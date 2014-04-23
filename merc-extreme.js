/* guide to hungarian notation
 * 
 * units prefix:
 * - mr: mercator-projected radians
 * - m: mercator-projected units (1 unit = 1 earth circumference)
 * - t: tile cartesian (top-left corner of z0 tile = (0, 0), bottom-right corner = (1, 1))
 * - gr: lat-lon radians
 * - g: lat-lon degrees
 * - v: xyz vector
 * - s: screen pixels ((0, 0) = upper-left)
 *
 * reference prefix:
 * - w: world -- coordinates correspond to physical planet
 * - p: projected -- coordinates correspond to planet with shifted pole
 */

function Point(unit, ref, data) {
    this.unit = unit;
    this.ref = ref;
    this.data = data;
}

//function mr_to_m(p) {
//    var scale = 2 * Math.PI;
//    reutrn {x: , y: }
//}

// return next highest power of 2 >= x
function pow2ceil(x) {
    var EPSILON = 1e-9;
    var lgx = Math.log(x) / Math.log(2.);
    return Math.pow(2., Math.ceil(lgx - EPSILON));
}

var _stats;
var vertex_shader;
var fragment_shader;

var TILE_SIZE = 256;
var MAX_ZOOM = 22; // max zoom level to attempt to fetch image tiles

// these aren't really meant to be changed... more just to justify how various constants got their values
var MIN_BIAS = 0.;
var MAX_ZOOM_BLEND = .6;
var MAX_SCREEN_DIAG = Math.sqrt(Math.pow(1920, 2) + Math.pow(1080, 2));
var MAX_Z_TILE_SPAN = Math.ceil(MAX_SCREEN_DIAG / TILE_SIZE * Math.pow(2, 1. - MIN_BIAS + MAX_ZOOM_BLEND));

var TILE_OFFSET_RESOLUTION = pow2ceil(MAX_Z_TILE_SPAN);
// size of the texture index for a single zoom level; the maximum visible area
// at a single zoom level should never span more than half this number of tiles
var TEX_Z_IX_SIZE = 2 * TILE_OFFSET_RESOLUTION;

var TEX_IX_CELLS = pow2ceil(Math.sqrt(2 * (MAX_ZOOM + 1)));
var TEX_IX_SIZE = TEX_IX_CELLS * TEX_Z_IX_SIZE;

/* if this is too low, there is a chance that visible tiles will be missed and
   not loaded. how low you can get away with closely relates to how much buffer
   zone is set in the tile cache
*/
var SAMPLE_FREQ = 1/4.;
var ATLAS_TEX_SIZE = 4096;
var SAMPLE_TIME_FREQ = 1.;

var TILE_FRINGE_WIDTH = .1; // set dynamically from SAMPLE_FREQ?
var TILE_SKIRT = 2; //px

var HIGH_PREC_Z_BASELINE = 16;

var APPROXIMATION_THRESHOLD = 0.5; //px
var PREC_BUFFER = 2;

var NORTH_POLE_COLOR = '#ccc';
var SOUTH_POLE_COLOR = '#ccc';

function init() {
    vertex_shader = loadShader('vertex-default');
    fragment_shader = loadShader('fragment');
    
    var merc = new MercatorRenderer($('#container'), window.innerWidth, window.innerHeight, 2.5, 0.5);
    
    _stats = new Stats();
    _stats.domElement.style.position = 'absolute';
    _stats.domElement.style.top = '0px';
    document.body.appendChild(_stats.domElement);
    
    $(window).keypress(function(e) {
        if (e.keyCode == 32) {
            merc.toggle_drag_mode();
            return false;
        }
    });
    
    merc.start();
}



/* xy is google style upper left=(0, 0), lower right=(1, 1) */
// g -> t
function ll_to_xy(lat, lon) {
    var x = lon / 360. + .5;
    var rlat = lat * Math.PI / 180.;
    var merc_y = Math.log(Math.tan(.5 * rlat + .25 * Math.PI));
    var y = .5 - merc_y / (2. * Math.PI);
    return {x: x, y: y};
}

/* xy is x:0,1 == -180,180, y:equator=0 */
// t -> g
function xy_to_ll(x, y) {
    var lon = (x - .5) * 360.;
    var merc_y = 2. * Math.PI * y;
    var rlat = 2. * Math.atan(Math.exp(merc_y)) - .5 * Math.PI;
    var lat = rlat * 180. / Math.PI;
    return [lat, lon];
}

// g -> v
function ll_to_xyz(lat, lon) {
    var rlat = lat * Math.PI / 180.;
    var rlon = lon * Math.PI / 180.;
    return [Math.cos(rlon) * Math.cos(rlat), Math.sin(rlon) * Math.cos(rlat), Math.sin(rlat)];
}

// v -> g
function xyz_to_ll(x, y, z) {
    var rlon = Math.atan2(y, x);
    var rlat = Math.atan2(z, Math.sqrt(x*x + y*y));
    return [rlat * 180. / Math.PI, rlon * 180. / Math.PI];
}

// gp -> gw
function translate_pole(pos, pole) {
    var xyz = ll_to_xyz(pos[0], pos[1]);
    var pole_rlat = pole[0] * Math.PI / 180.;
    
    var latrot = pole_rlat - .5 * Math.PI;
    var xyz_trans = new THREE.Vector3(xyz[0], xyz[1], xyz[2]).applyMatrix4(new THREE.Matrix4().makeRotationY(-latrot));
    var pos_trans = xyz_to_ll(xyz_trans.x, xyz_trans.y, xyz_trans.z);
    pos_trans[1] = lon_norm(pos_trans[1] + pole[1]);
    return pos_trans;
}

function inv_translate_pole(pos, pole) {
    var pole_rlat = pole[0] * Math.PI / 180.;    
    var latrot = pole_rlat - .5 * Math.PI;
 
    pos[1] -= pole[1];
    var xyz = ll_to_xyz(pos[0], pos[1]);
    var xyz_trans = new THREE.Vector3(xyz[0], xyz[1], xyz[2]).applyMatrix4(new THREE.Matrix4().makeRotationY(latrot));
    return xyz_to_ll(xyz_trans.x, xyz_trans.y, xyz_trans.z);
}

// estimate the error from using a flat earth approximation (ie, plotting
// the distance from a center point directly on the mercator-projected plane
// rather than on the surface of the spherical earth)
// lat: latitude in degrees of center of circle
// radius: radius of circle in earth radii
// DO NOT ask how i figured this all out
function flat_earth_error(lat, radius) {
    lat = Math.abs(lat);

    // handle situations where approximation becomes too inaccurate
    if (radius > .1) {
        return Number.POSITIVE_INFINITY;
    }
    var rlog = Math.max(Math.log(radius) / Math.LN10, -4);
    // empirically determined thresholds at which estimate starts
    // to differ from reality by more than 1%
    var latmin = 18. * Math.pow(10., rlog);
    var latmax = 90. - 97. * Math.pow(10., rlog);
    if (lat > latmax) {
        return Number.POSITIVE_INFINITY;
    } else if (lat < latmin) {
        lat = latmin;
    }

    var rlat = lat * Math.PI / 180.;
    return .5 * Math.pow(radius, 2.) * Math.tan(rlat);
}

// lat: latitude in projected coordinate system
// scale: pixels per earth circumference
function flat_earth_error_px(lat, scale, pole_lat) {
    var lat = Math.abs(lat);
    var rlat = lat * Math.PI / 180.;
    var pole_dist = .5 * Math.PI - rlat;

    var error = flat_earth_error(pole_lat, pole_dist);
    var px_size = 2. * Math.PI / scale * Math.cos(rlat); // radians per pixel

    return error / px_size;
}

function solve_eq(start, end, resolution, func) {
    if (func(start)) {
        return start;
    } else if (!func(end)) {
        return end;
    }

    var x, result;
    while (true) {
        x = .5 * (start + end);
        if (Math.abs(end - start) <= resolution) {
            return x;
        }

        result = func(x);
        if (result) {
            end = x;
        } else {
            start = x;
        }
    }
}



QuadGeometry = function(x0, x1, y0, y1, texcoords) {
	THREE.Geometry.call(this);
    var g = this;
    
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;

    var UVs = [[], []];
    $.each([g.y0, g.y1], function(i, y) {
        $.each([g.x0, g.x1], function(j, x) {
            g.vertices.push(new THREE.Vector3(x, y, 0));

            var alt = (texcoords ? texcoords[2 * i + j] : null);
            var uv1 = new THREE.Vector2(x, y);
            var uv2 = (alt ? new THREE.Vector2(alt[0], alt[1]) : uv1);
            UVs[0].push(uv1);
            UVs[1].push(uv2);
        });
    });
    this.faces.push(new THREE.Face3(0, 1, 3));
    this.faces.push(new THREE.Face3(0, 3, 2));

    this.faceVertexUvs[0] = [[UVs[0][0], UVs[0][1], UVs[0][3]], [UVs[0][0], UVs[0][3], UVs[0][2]]];
    this.faceVertexUvs[1] = [[UVs[1][0], UVs[1][1], UVs[1][3]], [UVs[1][0], UVs[1][3], UVs[1][2]]];
};
QuadGeometry.prototype = Object.create(THREE.Geometry.prototype);


function arrCopy(dst, start, src) {
    for (var i = 0; i < src.length; i++) {
        dst[start + i] = src[i];
    }
}

GridGeometry = function(maxquads) {
	THREE.BufferGeometry.call(this);

    this.maxquads = maxquads;
    this.addAttribute('index', Uint16Array, this.maxquads * 6, 1);
	this.addAttribute('position', Float32Array, this.maxquads * 4, 3);
	this.addAttribute('uv', Float32Array, this.maxquads * 4, 2);
	this.addAttribute('uv2', Float32Array, this.maxquads * 4, 2);
    this.offsets.push({
		start: 0,
        index: 0,
        count: this.attributes.index.array.length
    });

    this.setData = function(type, offset, data) {
        var attr = this.attributes[type];
        arrCopy(attr.array, offset * attr.itemSize, data);
        attr.needsUpdate = true;
    }

    this.setQuad = function(ix, x0, x1, y0, y1, tex) {
        var v = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
        var vix = [4*ix, 4*ix + 1, 4*ix + 2, 4*ix + 3];
        this.setData('index', 6*ix, [vix[0], vix[1], vix[3], vix[0], vix[3], vix[2]]);
        this.setData('position', vix[0], v[0]);
        this.setData('position', vix[1], v[1]);
        this.setData('position', vix[2], v[2]);
        this.setData('position', vix[3], v[3]);
        this.setData('uv', vix[0], v[0]);
        this.setData('uv', vix[1], v[1]);
        this.setData('uv', vix[2], v[2]);
        this.setData('uv', vix[3], v[3]);
        this.setData('uv2', vix[0], tex ? tex[0] : v[0]);
        this.setData('uv2', vix[1], tex ? tex[1] : v[1]);
        this.setData('uv2', vix[2], tex ? tex[2] : v[2]);
        this.setData('uv2', vix[3], tex ? tex[3] : v[3]);
    }

    this.singleton = function(x0, x1, y0, y1, tex) {
        this.setQuad(0, x0, x1, y0, y1, tex);
    }

    this.clearQuads = function(beyond) {
        var arr = this.attributes.index.array;
        for (var i = beyond * 6; i < arr.length; i++) {
            arr[i] = 0;
        }
        this.attributes.index.needsUpdate = true;
    }

}
GridGeometry.prototype = Object.create(THREE.BufferGeometry.prototype);

function TexBuffer(size, texopts, aspect) {
    this.width = size;
    this.height = size * (aspect || 1.);
    
    var $tx = $('<canvas />');
    $tx.attr('width', this.width);
    $tx.attr('height', this.height);
    this.$tx = $tx[0];
    
    this.ctx = this.$tx.getContext('2d');

    this.tx = new THREE.Texture(this.$tx);
    var texbuf = this;
    $.each(texopts || {}, function(k, v) {
        texbuf.tx[k] = v;
    });
    this.tx.needsUpdate = true;
    
    this.incrUpdates = [];
    var texbuf = this;
    this.tx.incrementalUpdate = function(updatefunc) {
        $.each(texbuf.incrUpdates, function(i, e) {
            updatefunc(e.img, e.xo, e.yo);
        });
        texbuf.incrUpdates = [];
    }
    
    this.update = function(draw) {
        draw(this.ctx, this.width, this.height);
        this.tx.needsUpdate = true;
    }
    
    this.incrementalUpdate = function(image, xo, yo) {
        this.incrUpdates.push({img: image, xo: xo, yo: yo});
    }
}

function TextureLayer(context, tilefunc) {
    
    this.context = context;
    this.tilefunc = tilefunc;
    
    this.sample_width = Math.round(this.context.width_px * SAMPLE_FREQ);
    this.sample_height = Math.round(this.context.height_px * SAMPLE_FREQ);
    this.target = new THREE.WebGLRenderTarget(this.sample_width, this.sample_height, {format: THREE.RGBFormat});
    this.target.generateMipmaps = false;
    
    this.worker = new Worker('coverage-worker.js');
    
    this.tex_z0 = new TexBuffer(TILE_SIZE, {
        generateMipmaps: true,
        magFilter: THREE.LinearFilter,
        minFilter: THREE.LinearMipMapLinearFilter,
        wrapS: THREE.RepeatWrapping, // still getting seams... why?
        flipY: false,
    }, 2.);
    this.tex_atlas = [new TexBuffer(ATLAS_TEX_SIZE, {
        // mipmapping must be done manually due to non-continguity of images
        generateMipmaps: false,
        magFilter: THREE.LinearFilter,
        minFilter: THREE.LinearFilter,
        flipY: false,
    })];
    this.tex_index = new TexBuffer(TEX_IX_SIZE, {
        generateMipmaps: false,
        magFilter: THREE.NearestFilter,
        minFilter: THREE.NearestFilter,
        flipY: false,
    });

    this.tile_index = {};
    this.slot_index = {};
    var TEX_SIZE_TILES = ATLAS_TEX_SIZE / TILE_SIZE;
    for (var i = 0; i < TEX_SIZE_TILES; i++) {
        for (var j = 0; j < TEX_SIZE_TILES; j++) {
            this.slot_index[0 + ':' + i + ':' + j] = false;
        }
    }
    this.index_offsets = {};
    
    this.init = function() {
        var layer = this;
        this.worker.addEventListener('message', function(e) {
            layer.sample_coverage_postprocess(e.data);
        }, false);
    }
    
    this.sample_coverage = function() {
        if (!this.sampleBuff) {
            this.sampleBuff = new Uint8Array(this.sample_width * this.sample_height * 4);
        }
        
        var gl = this.context.glContext;
        this.context.renderer.render(this.context.scene, this.context.camera, this.target);
        gl.readPixels(0, 0, this.sample_width, this.sample_height, gl.RGBA, gl.UNSIGNED_BYTE, this.sampleBuff); // RGBA required by spec
        this.worker.postMessage(this.context.ref_t);
        this.worker.postMessage(this.sampleBuff);
    }
    
    this.first_run = true;
    this.sample_coverage_postprocess = function(data) {
        this._debug_overview(data);
        
        var tilekey = function(tile) {
            return tile.z + ':' + tile.x + ':' + tile.y;
        }
        
        var unpack_tile = function(key) {
            var pcs = key.split(':');
            return {
                anti: +pcs[0] == 1,
                z: +pcs[1],
                x: +pcs[2],
                y: +pcs[3]
            };
        }
        var tiles = _.sortBy($.map(data, function(v, k) { return unpack_tile(k); }), function(e) { return e.z + (e.anti ? .5 : 0.); });
        if (this.first_run) {
            // always load z0 tile even if not in current view
            tiles.push({anti: false, z: 0, x: 0, y: 0}); // may be a duplicate, but the code below should handle it ok
            this.first_run = false;
        }

        var layer = this;
        
        if (window.MRU_counter == null) {
            MRU_counter = 0;
        }
        var ranges = {};
        $.each(tiles, function(i, tile) {
            var key = (tile.anti ? 1 : 0) + ':' + tile.z;
            var r = ranges[key];
            if (r == null) {
                ranges[key] = {xmin: tile.x, xmax: tile.x, ymin: tile.y, ymax: tile.y};
            } else {
                r.xmin = Math.min(r.xmin, tile.x);
                r.xmax = Math.max(r.xmax, tile.x);
                r.ymin = Math.min(r.ymin, tile.y);
                r.ymax = Math.max(r.ymax, tile.y);
            }
        });
        $.each(ranges, function(k, v) {
            // assert range <= TEX_Z_IX_SIZE / 2
            var offset = function(min) {
                return Math.floor(min / (TEX_Z_IX_SIZE / 2));
            }
            var xoffset = offset(v.xmin);
            var yoffset = offset(v.ymin);
            var cur_offsets = layer.index_offsets[k];
            if (cur_offsets == null || cur_offsets.x != xoffset || cur_offsets.y != yoffset) {
                layer.index_offsets[k] = {x: xoffset, y: yoffset};
                layer.set_offset(k, xoffset, yoffset);

                var pcs = k.split(':');
                var anti = +pcs[0];
                var z = +pcs[1];
                layer.clear_tile_ix(z, anti);
                // is this too slow?.... yes. yes it is
                // FIXME performance
                $.each(layer.tile_index, function(k, v) {
                    if (v.status != 'loaded') {
                        return;
                    }

                    var pcs = k.split(':');
                    var tile = {z: +pcs[0], x: +pcs[1], y: +pcs[2]};
                    layer.set_tile_ix(tile, v.slot);
                });
            }
        });

        // mark all tiles for LRU if exist in cache
        $.each(tiles, function(i, tile) {
            var ix_entry = layer.tile_index[tilekey(tile)];
            if (ix_entry) {
                ix_entry.mru = MRU_counter;
            }
        });
        
        $.each(tiles, function(i, tile) {
            //debug to reduce bandwidth (high zoom levels move out of view too fast)
            //if (tile.z > 7) {
            //    return;
            //}
            
            if (layer.tile_index[tilekey(tile)] != null) {
                return;
            }
            
            layer.tile_index[tilekey(tile)] = {status: 'loading'};
            load_image(layer.tilefunc(tile.z, tile.x, tile.y), function(img) {
                var ix_entry = layer.tile_index[tilekey(tile)];
                ix_entry.status = 'loaded';
                
                if (tile.z == 0) {
                    layer.mk_top_level_tile(img);
                    return;
                }
                
                // note: by the time we get here there is no guarantee that the
                // tile is even still in view

                var slot = null;
                var split_slot_key = function(key) {
                    var pcs = key.split(':');
                    return {tex: +pcs[0], x: +pcs[1], y: +pcs[2]};
                };
                $.each(layer.slot_index, function(key, occupied) {
                    if (!occupied) {
                        slot = split_slot_key(key);
                        return false;
                    }
                });
                if (slot == null) {
                    console.log('no slot');
                    var oldest_key = null;
                    var oldest = null;
                    $.each(layer.tile_index, function(k, v) {
                        if (v.status != 'loaded') {
                            return;
                        }
                        if (k == '0:0:0') {
                            // not stored in texture atlas
                            return;
                        }
                        
                        if (oldest == null || v.mru < oldest.mru) {
                            oldest_key = k;
                            oldest = v;
                        }
                    });
                    
                    if (oldest.mru == MRU_counter) {
                        // tile cache is full (TODO provision extra space?)
                        console.log('tile cache is full!');
                        return;
                    }
                    
                    slot = oldest.slot;
                    delete layer.tile_index[oldest_key];

                    var pcs = oldest_key.split(':');
                    layer.set_tile_ix({z: +pcs[0], x: +pcs[1], y: +pcs[2]}, null);
                }
                
                console.log('loading', tilekey(tile));
                layer.tex_atlas[slot.tex].incrementalUpdate(img, TILE_SIZE * slot.x, TILE_SIZE * slot.y);
                ix_entry.slot = slot;
                layer.slot_index[slot.tex + ':' + slot.x + ':' + slot.y] = true;
                
                layer.set_tile_ix(tile, slot);
                ix_entry.mru = MRU_counter;
            });
        });
        
        MRU_counter++;
    }
    
    this.set_offset = function(zkey, xo, yo) {
        var pcs = zkey.split(':');
        var anti = +pcs[0];
        var z = +pcs[1];
        
        var px = z;
        var py = (anti ? .5 : 0) * TEX_IX_SIZE + TEX_Z_IX_SIZE - 1;
        
        this.tex_index.update(function(ctx, w, h) {
            var buf = ctx.createImageData(1, 1);
            
            buf.data[0] = Math.floor(xo / 256.);
            buf.data[1] = xo % 256;
            buf.data[2] = 0;
            buf.data[3] = 255;
            ctx.putImageData(buf, px, py);
            
            buf.data[0] = Math.floor(yo / 256.);
            buf.data[1] = yo % 256;
            buf.data[2] = 0;
            buf.data[3] = 255;
            ctx.putImageData(buf, px, py - 1);
        });
    }

    this.clear_tile_ix = function(z, anti) {
        var zx = z % (TEX_IX_SIZE / TEX_Z_IX_SIZE);
        var zy = Math.floor(z / (TEX_IX_SIZE / TEX_Z_IX_SIZE)) + (anti ? .5 : 0) * (TEX_IX_SIZE / TEX_Z_IX_SIZE);
        var size = Math.min(Math.pow(2, z), TEX_Z_IX_SIZE);
        this.tex_index.update(function(ctx, w, h) {
            ctx.fillStyle = '#000';
            ctx.fillRect(zx * TEX_Z_IX_SIZE, zy * TEX_Z_IX_SIZE, size, size);
        });
    }
    
    this.set_tile_ix = function(tile, slot) {
        var layer = this;
        var helper = function(anti) {
            var offsets = layer.index_offsets[(anti ? 1 : 0) + ':' + tile.z];
            if (offsets == null) {
                return;
            }

            var dx = tile.x - TEX_Z_IX_SIZE / 2 * offsets.x;
            var dy = tile.y - TEX_Z_IX_SIZE / 2 * offsets.y;
            if (dx < 0 || dy < 0 || dx >= TEX_Z_IX_SIZE || dy >= TEX_Z_IX_SIZE) {
                // out of range for current offset
                return;
            }
 
            var zx = tile.z % (TEX_IX_SIZE / TEX_Z_IX_SIZE);
            var zy = Math.floor(tile.z / (TEX_IX_SIZE / TEX_Z_IX_SIZE)) + (anti ? .5 : 0) * (TEX_IX_SIZE / TEX_Z_IX_SIZE);
        
            var px = zx * TEX_Z_IX_SIZE + dx;
            var py = zy * TEX_Z_IX_SIZE + dy;

            layer.tex_index.update(function(ctx, w, h) {
                var buf = ctx.createImageData(1, 1);
                if (slot != null) {
                    buf.data[0] = slot.tex + 1;
                    buf.data[1] = slot.x;
                    buf.data[2] = slot.y;
                } else {
                    buf.data[0] = 0;
                    buf.data[1] = 0;
                    buf.data[2] = 0;
                }
                buf.data[3] = 255;
                ctx.putImageData(buf, px, py);
            });
        };
        
        helper(false);
        helper(true);
    }
    
    this.mk_top_level_tile = function(img) {
        this.tex_z0.update(function(ctx, w, h) {
            ctx.fillStyle = NORTH_POLE_COLOR;
            ctx.fillRect(0, 0, w, .5 * h);
            ctx.fillStyle = SOUTH_POLE_COLOR;
            ctx.fillRect(0, .5 * h, w, .5 * h);
            
            ctx.drawImage(img, 0, .25 * h);
        });
    }
    
    this.material = function(params) {
        if (!this.uniforms) {
            this.uniforms = {
                scale: {type: 'f', value: this.context.scale_px},
                bias: {type: 'f', value: 0.},
                pole: {type: 'v2', value: null},
                pole_t: {type: 'v2', value: null},
                ref_t: {type: 'v2', value: null},
                tx_ix: {type: 't', value: this.tex_index.tx},
                tx_atlas: {type: 'tv', value: $.map(this.tex_atlas, function(e) { return e.tx; })},
                tx_z0: {type: 't', value: this.tex_z0.tx},

                hp_pole_tile: {type: 'v2', value: null},
                hp_pole_offset: {type: 'v2', value: null},
            };
        }
        return new THREE.ShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: configureShader(vertex_shader),
            fragmentShader: configureShader(fragment_shader, params)
        });        
    }
    
    this.init();
    this._materials = {
        'image': {
            'sphere': this.material({geo_mode: 'sphere', output_mode: 'tex'}),
            'linear': this.material({geo_mode: 'linear', output_mode: 'tex'}),
            'flat': this.material({geo_mode: 'flat', output_mode: 'tex'}),
        },
        'sampler': {
            'sphere': this.material({geo_mode: 'sphere', output_mode: 'tile'}),
            'linear': this.material({geo_mode: 'linear', output_mode: 'tile'}),
            'flat': this.material({geo_mode: 'flat', output_mode: 'tile'}),
        },
    };
    
    
    this._debug_overview = function(data) {
        //console.log('worker result', data, _.size(data));
        var canvas = $('#tileovl')[0];
        $(canvas).attr('width', (TEX_Z_IX_SIZE / 2 * (1 + MAX_ZOOM)) + 'px');
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#444';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        for (var i = 0; i < 1 + MAX_ZOOM; i++) {
            for (var j = 0; j < 2; j++) {
                ctx.fillStyle = ((i + j) % 2 == 0 ? '#200' : '#002');
                ctx.fillRect(32 * i, 32 * j, Math.min(Math.pow(2, i), 32), Math.min(Math.pow(2, i), 32));

                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = '#555';
                ctx.font = '12pt sans-serif';
                ctx.fillText(i, 32 * (i + .5), 32 * (j + .5));
            }
        }
        
        $.each(data, function(k, v) {
            var pcs = k.split(':');
            var anti = +pcs[0];
            var z = +pcs[1];
            var dx = pcs[2] % 32;
            var dy = pcs[3] % 32;
            
            ctx.fillStyle = 'white';
            ctx.fillRect(32 * z + dx, 32 * ((anti ? 1 : 0)) + dy, 1, 1);
        });
    }
}

function MercatorRenderer($container, viewportWidth, viewportHeight, extentN, extentS, lonOffset, lonExtent) {
    this.width_px = viewportWidth;
    this.height_px = viewportHeight;
    this.aspect = this.width_px / this.height_px;

    this.mercExtentN = extentN;
    this.mercExtentS = extentS;
    this.lonOffset = lonOffset || 0.;

    this.mercExtent = this.mercExtentS + this.mercExtentN;
    this.lonExtent = (lonExtent == null ? this.mercExtent / this.aspect : lonExtent);
    this.scale_px = this.width_px / this.mercExtent;

    this.renderer = new THREE.WebGLRenderer();
    this.glContext = this.renderer.getContext();

    this.curPole = null;

    // monkeypatch to support tex update sub-image
    var _setTexture = this.renderer.setTexture;
    this.renderer.setTexture = function(texture, slot) {
        _setTexture(texture, slot);
        
        if (texture.incrementalUpdate) {
            var renderer = this;
            var _gl = this.getContext();
            
            var glFormat = paramThreeToGL(texture.format, _gl);
            var glType = paramThreeToGL(texture.type, _gl);
            
            var first = true;
            var updatefunc = function(image, xoffset, yoffset) {
                if (first) {
                    // texture should already be bound from default setTexture behavior
                    
                    _gl.pixelStorei(_gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);
                    _gl.pixelStorei(_gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, texture.premultiplyAlpha);
                    
                    first = false;
                }
                
                _gl.texSubImage2D(_gl.TEXTURE_2D, 0, xoffset, yoffset, glFormat, glType, image);
            };
            
            texture.incrementalUpdate(updatefunc);
        }
    }
    
    this.init = function() {
        console.log('width', this.width_px, 'height', this.height_px, 'aspect', this.aspect);
        console.log('max tex size', this.glContext.getParameter(this.glContext.MAX_TEXTURE_SIZE));
        console.log('max # texs', this.glContext.getParameter(this.glContext.MAX_TEXTURE_IMAGE_UNITS));
        console.log('prec (med)', this.glContext.getShaderPrecisionFormat(this.glContext.FRAGMENT_SHADER, this.glContext.MEDIUM_FLOAT).precision);
        console.log('prec (high)', this.glContext.getShaderPrecisionFormat(this.glContext.FRAGMENT_SHADER, this.glContext.HIGH_FLOAT).precision);
        
        this.renderer.setSize(this.width_px, this.height_px);
        // TODO handle window/viewport resizing
        $container.append(this.renderer.domElement);
        
        this.init_interactivity();
        
        this.camera = new THREE.OrthographicCamera(0, this.width_px, this.height_px, 0, -1, 1);

        this.scene = new THREE.Scene();
        this.group = new THREE.Object3D();
        this.scene.add(this.group);
        this.layer = new TextureLayer(this, tile_url('map'));
        this.currentObjs = [];

        //this.quad = new QuadGeometry(-1, -3, 3, 6); //this.lonOffset, -this.mercExtentS, this.lonExtent, this.mercExtent);
        //this.plane = new THREE.Mesh(this.quad, this.layer._material);
        //this.group.add(this.plane);

        //quad.applyMatrix(new THREE.Matrix4().makeTranslation(-this.lonExtent, this.mercExtentS, 0));
        //quad.applyMatrix(new THREE.Matrix4().makeRotationZ(-0.5 * Math.PI));
        //quad.applyMatrix(new THREE.Matrix4().makeScale(this.scale_px, this.scale_px, 1));

	    var M = new THREE.Matrix4();
	    M.multiply(new THREE.Matrix4().makeScale(this.scale_px, this.scale_px, 1));
	    M.multiply(new THREE.Matrix4().makeRotationZ(-0.5 * Math.PI));
	    M.multiply(new THREE.Matrix4().makeTranslation(-this.lonExtent, this.mercExtentS, 0));
        this.setWorldMatrix(M);

	    //this.curPole = [41.63, -72.59];
        this.curPole = [42.4, -71.1];
	    //this.curPole = [-34.0,18.4];
        //this.curPole = [43.56057, -7.41375];
    }

    this.setWorldMatrix = function(M) {
        // this currently UPDATES the matrix
        this.M = this.M || new THREE.Matrix4();
        this.group.applyMatrix(M);
        this.group.verticesNeedUpdate = true;

        // this is a mess
        M.multiply(this.M);
        this.M = M;
	    this.toWorld = new THREE.Matrix4().getInverse(this.M);
    }

    this.xyToWorld = function(x, y) {
        return new THREE.Vector3(x, y, 0).applyMatrix4(this.toWorld);
    }

    this.worldToXY = function(x, y) {
        return new THREE.Vector3(x, y, 0).applyMatrix4(this.M);
    }

    this.zoom = function(x, y, z) {
        y = $(this.renderer.domElement).height() - y - 1; // ugly
	    var M = new THREE.Matrix4();
        M.multiply(new THREE.Matrix4().makeTranslation(x, y, 0));
        M.multiply(new THREE.Matrix4().makeScale(z, z, 1));
        M.multiply(new THREE.Matrix4().makeTranslation(-x, -y, 0));
        this.setWorldMatrix(M);
        this.scale_px *= z;
        this.layer.uniforms.scale.value *= z;
    }

    this.warp = function(pos, drag_context) {
        var merc = this.xyToWorld(pos.x, pos.y);
	    var merc_ll = xy_to_ll(merc.x, merc.y);
	    this.curPole = translate_pole([merc_ll[0], merc_ll[1] + 180.], drag_context.down_ll);
    }

    this.pan = function(pos, drag_context) {
        delta = [pos.x - drag_context.last_px.x, pos.y - drag_context.last_px.y];
        var M = new THREE.Matrix4().makeTranslation(delta[0], delta[1], 0);
        this.setWorldMatrix(M);
    }

    this.drag_mode = this.warp;
    this.toggle_drag_mode = function() {
        this.drag_mode = (this.drag_mode == this.warp ? this.pan : this.warp);
    }

    this.init_interactivity = function() {
        var mouse_pos = function(e) {
            return {x: e.pageX - e.target.offsetLeft, y: e.target.offsetHeight - (e.pageY - e.target.offsetTop)};
        }
        
	    var renderer = this;
        var drag_context = null;
        $(this.renderer.domElement).bind('mousedown', function(e) {
            drag_context = {
		        'down_px': mouse_pos(e),
		        'down_pole': renderer.curPole,
	        };
            
            var merc = renderer.xyToWorld(drag_context.down_px.x, drag_context.down_px.y);
	        var merc_ll = xy_to_ll(merc.x, merc.y);
	        drag_context.down_ll = translate_pole(merc_ll, drag_context.down_pole);
        });
        $(document).bind('mousemove', function(e) {
            // debug
	        var pos = mouse_pos(e);
            POS = pos;

            if (drag_context == null) {
                return;
            }
            drag_context.last_px = drag_context.last_px || drag_context.down_px;
            
	        var pos = mouse_pos(e);
            renderer.drag_mode(pos, drag_context);
            drag_context.last_px = pos;
        });
        $(document).bind('mouseup', function(e) {
            drag_context = null;
        });
        
        
        $(this.renderer.domElement).bind('mousewheel', function(e) {
            e = e.originalEvent;
            var pos = [e.offsetX, e.offsetY];
            var delta = e.wheelDelta;
            
            var ZOOM_QUANTUM = Math.pow(1.05, 1/120.);
            renderer.zoom(pos[0], pos[1], Math.pow(ZOOM_QUANTUM, delta));
            return false;
        });
    }
    
    /* linear interp issues
       handle wraparound
       handle antipole, potentially both visible at once
       handle quadtree refinement
       using real tile offset in shader

       drops to 8 tiles... why?
    */

    var _interp = function(a, b, k) {
        return (1. - k) * a + k * b;
    }
    var _interp2d = function(a, b, c, d, kx, ky) {
        return _interp(_interp(a, b, kx), _interp(c, d, kx), ky);
    }
    var MIN_CELL_SIZE = 2;
    this.linearInterp = function(x0, x1, y0, y1) {
        var buf = [];
        this._linearInterp(buf, x0, x1, y0, y1);
        return buf;
    }
    this._linearInterp = function(buf, x0, x1, y0, y1, mp) {
        if (y0 >= y1) {
            return;
        }

        var renderer = this;
        mp = mp || [null, null, null, null];
        $.each([[x0, y0], [x1, y0], [x0, y1], [x1, y1]], function(i, e) {
            if (!mp[i]) {
                var merc_ll = xy_to_ll(e[0], e[1]);
                var ll = translate_pole(merc_ll, renderer.curPole);
                var r = ll_to_xy(ll[0], ll[1]);
                mp[i] = [r.x, r.y];
            }
        });

        var width = (y1 - y0);
        var height = (x1 - x0);
        var min_cell_size = MIN_CELL_SIZE / this.scale_px;
        var terminal = width <= min_cell_size && height <= min_cell_size;

        if (!terminal) {
            var uv_interp = [_interp2d(mp[0][0], mp[1][0], mp[2][0], mp[3][0], .5, .5),
                             _interp2d(mp[0][1], mp[1][1], mp[2][1], mp[3][1], .5, .5)];
            var p_center = [_interp(x0, x1, .5), _interp(y0, y1, .5)];

            var a = xy_to_ll(uv_interp[0], .5 - uv_interp[1]);
            var b = inv_translate_pole(a, renderer.curPole);
            var c = ll_to_xy(b[0], b[1]);
            var d = [c.x, .5 - c.y];
            var diff = [p_center[0] - d[0], p_center[1] - d[1]];
            var error = Math.sqrt(Math.pow(diff[0], 2) + Math.pow(diff[1], 2)) * renderer.scale_px;

            terminal = (error < APPROXIMATION_THRESHOLD);
        }

        if (terminal) {
            buf.push({x0: x0, y0: y0, x1: x1, y1: y1, tex: mp});
            QC += 1;
        } else {
            var xcenter = _interp(x0, x1, .5);
            var ycenter = _interp(y0, y1, .5);

            if (height / width > Math.sqrt(2.)) {
                this._linearInterp(buf, x0, xcenter, y0, y1, [mp[0], null, mp[2], null]);
                this._linearInterp(buf, xcenter, x1, y0, y1, [null, mp[1], null, mp[3]]);
            } else if (width / height > Math.sqrt(2.)) {
                this._linearInterp(buf, x0, x1, y0, ycenter, [mp[0], mp[1], null, null]);
                this._linearInterp(buf, x0, x1, ycenter, y1, [null, null, mp[2], mp[3]]);
            } else {
                this._linearInterp(buf, x0, xcenter, y0, ycenter, [mp[0], null, null, null]);
                this._linearInterp(buf, x0, xcenter, ycenter, y1, [null, null, mp[2], null]);
                this._linearInterp(buf, xcenter, x1, y0, ycenter, [null, mp[1], null, null]);
                this._linearInterp(buf, xcenter, x1, ycenter, y1, [null, null, null, mp[3]]);
            }
        }
    }
    
    this.makeQuad = function(geo_mode, max) {
        var quad = new GridGeometry(max || 1);
        var plane = new THREE.Mesh(quad, this.layer._materials['image'][geo_mode]);
        plane.geo_mode = geo_mode;
        plane.update = function(x0, x1, y0, y1) {
            plane.geometry.singleton(x0, x1, y0, y1);
        };
        plane.updateAll = function(data) {
            // if i take out this line the geometry won't show up
            // WHAT THE FUCK!?!?!
            plane.geometry.setQuad(0, 0, 1, 0, 1);

            for (var i = 0; i < data.length; i++) {
                var q = data[i];
                plane.geometry.setQuad(i, q.x0, q.x1, q.y0, q.y1, q.tex);
            }
            plane.geometry.clearQuads(data.length);
        };
        this.group.add(plane);
        this.currentObjs.push(plane);
        return plane;
    }

    this.render = function(timestamp) {
        var renderer = this;
        if (!this.currentObjs.length) {
            this.qPolar = this.makeQuad('flat');
            this.qPolarAnti = this.makeQuad('flat');
            this.qLinear = this.makeQuad('linear', 1024);
            //this.qLinearAnti = this.makeQuad('linear', 1024);
            this.qGooeyMiddle = this.makeQuad('sphere');
        }

        var debug = '';
        if (window.POS) {
            var p = renderer.xyToWorld(POS.x, POS.y);
            var merc_ll = xy_to_ll(p.x, p.y);
            var ll = translate_pole(merc_ll, renderer.curPole);

            dist = 6371.009 * Math.PI / 180. * (90. - merc_ll[0]);
            bearing = lon_norm(180. - merc_ll[1]);
            scale = 2 * Math.PI / renderer.scale_px * Math.cos(merc_ll[0] * Math.PI / 180.) * 6371009;
            debug = ll[0].toFixed(5) + ' ' + ll[1].toFixed(5) + '<br>' + dist.toFixed(4) + '<br>' + bearing.toFixed(1) + '<br>' + scale.toFixed(2) + '<br>';
        }

        var low_prec_cutoff_latrad = Math.acos(Math.min(this.scale_px / Math.pow(2., 23. - PREC_BUFFER), 1.));
        var low_prec_cutoff = .5 - ll_to_xy(low_prec_cutoff_latrad * 180. / Math.PI, 0).y;

        // TODO can bind this by screen-viewable area
        var flat_earth_cutoff = solve_eq(0, 3., 1. / this.scale_px, function(x) {
            var lat = xy_to_ll(0, x)[0];
            return flat_earth_error_px(lat, renderer.scale_px, renderer.curPole[0]) < APPROXIMATION_THRESHOLD;
        });
        flat_earth_cutoff = Math.max(flat_earth_cutoff, low_prec_cutoff);

        var p0 = renderer.xyToWorld(0, 0);
        var p1 = renderer.xyToWorld(this.width_px, this.height_px);
        var xtop = p1.x;
        var xbottom = p0.x;
        var yleft = Math.max(low_prec_cutoff, p0.y);
        var yright = Math.min(flat_earth_cutoff, p1.y);

        // TODO always fill screen -- no longer need arbitrary cutoffs
        this.qPolarAnti.update(-1, 2, -3, -flat_earth_cutoff);
        //this.addQuad(-1, -flat_earth_cutoff, 2, -low_prec_cutoff, 'linear');
        this.qGooeyMiddle.update(-1, 2, -low_prec_cutoff, low_prec_cutoff);
        QC = 0; var a = new Date();
        this.qLinear.updateAll(this.linearInterp(xtop, xbottom, yleft, yright));
        a = new Date() - a;
        this.qPolar.update(-1, 2, flat_earth_cutoff, 3);

	    this.setPole(this.curPole[0], this.curPole[1]);
        
        var b = new Date();
        this.renderer.render(this.scene, this.camera);
        b = new Date() - b;
        debug += QC + ' ' + (a / 1000) + ' ' + (b / 1000) + '<br>';
        
        var setMaterials = function(output_mode) {
            $.each(renderer.currentObjs, function(i, e) {
                e.material = renderer.layer._materials[output_mode][e.geo_mode];
            });
        }

        if (this.last_sampling == null || timestamp - this.last_sampling > SAMPLE_TIME_FREQ) {
            this.setRefPoint();
            setMaterials('sampler');
            this.layer.sample_coverage();
            setMaterials('image');
            this.last_sampling = timestamp;
        }

        $('#x').html(debug);

        _stats.update();
    }
    
    this.setPole = function(lat, lon) {
        lon = lon_norm(lon);
        this.pole = [lat, lon];
        this.pole_t = ll_to_xy(lat, lon);
        this.layer.uniforms.pole.value = new THREE.Vector2(lon, lat);
        this.layer.uniforms.pole_t.value = new THREE.Vector2(this.pole_t.x, this.pole_t.y);

        var hp_extent = Math.pow(2., HIGH_PREC_Z_BASELINE);
        var xt = Math.floor(this.pole_t.x * hp_extent) / hp_extent;
        var yt = Math.floor(this.pole_t.y * hp_extent) / hp_extent;
        var xo = this.pole_t.x - xt;
        var yo = this.pole_t.y - yt;

        this.layer.uniforms.hp_pole_tile.value = new THREE.Vector2(xt, yt);
        this.layer.uniforms.hp_pole_offset.value = new THREE.Vector2(xo, yo);
    };
    
    this.setRefPoint = function() {
        var renderer = this;
        var extremePoint = function(lo) {
            return renderer.xyToWorld(lo ? 0 : renderer.width_px, 0.5 * renderer.height_px);
        }
        var exLo = extremePoint(true);
        var exHi = extremePoint(false);
        var refAnti = Math.abs(exLo.y) > Math.abs(exHi.y);
        var refXY = refAnti ? exLo : exHi;

        var merc_ll = xy_to_ll(refXY.x, refXY.y);
        var ll = translate_pole(merc_ll, this.pole);
        var refAbs = ll_to_xy(ll[0], ll[1]);
        if (refAnti) {
            refAbs = {x: (refAbs.x + .5) % 1., y: 1. - refAbs.y};
        }
        
        this.ref_t = refAbs;
        this.layer.uniforms.ref_t.value = new THREE.Vector2(this.ref_t.x, this.ref_t.y);
    }
    
    this.start = function() {
        var merc = this;
        renderLoop(function(t) { merc.render(t); });
    }
    
    this.init();
}





function load_image(url, onload) {
    var img = new Image();
    img.onload = function() { onload(img); };
    img.crossOrigin = 'anonymous';
    img.src = url;
}


//=== TILE SERVICES ===

function tile_url(type) {
    var specs = {
        map: 'https://mts{s:0-3}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
        sat: 'https://khms{s:0-3}.google.com/kh/v=147&x={x}&y={y}&z={z}',
        terr: 'https://mts{s:0-3}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
        osm: 'http://{s:abc}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        trans: 'http://mts{s:0-3}.google.com/vt/lyrs=m@230051588,transit:comp%7Cvm:1&hl=en&src=app&opts=r&x={x}&y={y}&z={z}',
        mb: 'https://api.tiles.mapbox.com/v3/examples.map-51f69fea/{z}/{x}/{y}.jpg',
        mb2: 'https://api.tiles.mapbox.com/v3/examples.map-vyofok3q/{z}/{x}/{y}.png',
        topo: 'http://services.arcgisonline.com/ArcGIS/rest/services/USA_Topo_Maps/MapServer/tile/{z}/{y}/{x}'
    };
    return function(z, x, y) { return _tile_url(specs[type], z, {x: x, y: y}); };
}

//=== UTIL ===

function loadShader(name) {
    var content = null;
    $.ajax(name + '.glsl', {
        async: false,
        success: function(data) {
            content = data;
        }
    });
    return _.template(content);
}

function configureShader(template, context) {
    context = context || {};

    constants = [
        'TILE_SIZE',
        'MAX_ZOOM',
        'TILE_OFFSET_RESOLUTION',
        'TEX_Z_IX_SIZE',
        'TEX_IX_CELLS',
        'TEX_IX_SIZE',
        'ATLAS_TEX_SIZE',
        'TILE_FRINGE_WIDTH',
        'TILE_SKIRT',
    ];
    const_ctx = {};
    _.each(constants, function(e) {
        const_ctx[e] = window[e];
    });
    context.constants = const_ctx;

    context.num_atlas_pages = 1;

    //console.log(template(context));
    return template(context);
}

// huh?
window.requestAnimFrame = (function(callback){
    return window.requestAnimationFrame ||
           window.webkitRequestAnimationFrame ||
           window.mozRequestAnimationFrame ||
           window.oRequestAnimationFrame ||
           window.msRequestAnimationFrame ||
           function(callback){
               window.setTimeout(callback, 1000 / 60);
           };
})();

function renderLoop(render) {
    var cb = function(timestamp) {
        timestamp /= 1000.;
        if (!window.T0) {
            T0 = timestamp;
        }
        render(timestamp - T0);
        requestAnimationFrame(cb);
    }
    requestAnimationFrame(cb);
}









function _tile_url(spec, zoom, point) {
    var replace = function(key, sub) {
        spec = spec.replace(new RegExp('{' + key + '(:[^}]+)?}', 'g'), function(match, submatch) {
                return sub(submatch == null || submatch.length == 0 ? null : submatch.substring(1));
            });
    }

    replace('z', function() { return zoom; });
    replace('x', function() { return point.x; });
    replace('y', function() { return point.y; });
    replace('-y', function() { return Math.pow(2, zoom) - 1 - point.y; });
    replace('s', function(arg) {
            var k = point.x + point.y;
            if (arg.indexOf('-') == -1) {
                return arg.split('')[k % arg.length];
            } else {
                var bounds = arg.split('-');
                var min = +bounds[0];
                var max = +bounds[1];
                return min + k % (max - min + 1);
            }
        });
    replace('qt', function(arg) {
            var bin_digit = function(h, i) {
                return Math.floor(h / Math.pow(2, i) % 2);
            }

            var qt = '';
            for (var i = zoom - 1; i >= 0; i--) {
                var q = 2 * bin_digit(point.y, i) + bin_digit(point.x, i);
                qt += (arg != null ? arg[q] : q);
            }
            return qt;
        });

    return spec;
}









// couldn't get a reference to this function inside the three.js code; copied
function paramThreeToGL (p, _gl) {

    if ( p === THREE.RepeatWrapping ) return _gl.REPEAT;
    if ( p === THREE.ClampToEdgeWrapping ) return _gl.CLAMP_TO_EDGE;
    if ( p === THREE.MirroredRepeatWrapping ) return _gl.MIRRORED_REPEAT;
    
    if ( p === THREE.NearestFilter ) return _gl.NEAREST;
    if ( p === THREE.NearestMipMapNearestFilter ) return _gl.NEAREST_MIPMAP_NEAREST;
    if ( p === THREE.NearestMipMapLinearFilter ) return _gl.NEAREST_MIPMAP_LINEAR;
    
    if ( p === THREE.LinearFilter ) return _gl.LINEAR;
    if ( p === THREE.LinearMipMapNearestFilter ) return _gl.LINEAR_MIPMAP_NEAREST;
    if ( p === THREE.LinearMipMapLinearFilter ) return _gl.LINEAR_MIPMAP_LINEAR;
    
    if ( p === THREE.UnsignedByteType ) return _gl.UNSIGNED_BYTE;
    if ( p === THREE.UnsignedShort4444Type ) return _gl.UNSIGNED_SHORT_4_4_4_4;
    if ( p === THREE.UnsignedShort5551Type ) return _gl.UNSIGNED_SHORT_5_5_5_1;
    if ( p === THREE.UnsignedShort565Type ) return _gl.UNSIGNED_SHORT_5_6_5;
    
    if ( p === THREE.ByteType ) return _gl.BYTE;
    if ( p === THREE.ShortType ) return _gl.SHORT;
    if ( p === THREE.UnsignedShortType ) return _gl.UNSIGNED_SHORT;
    if ( p === THREE.IntType ) return _gl.INT;
    if ( p === THREE.UnsignedIntType ) return _gl.UNSIGNED_INT;
    if ( p === THREE.FloatType ) return _gl.FLOAT;
    
    if ( p === THREE.AlphaFormat ) return _gl.ALPHA;
    if ( p === THREE.RGBFormat ) return _gl.RGB;
    if ( p === THREE.RGBAFormat ) return _gl.RGBA;
    if ( p === THREE.LuminanceFormat ) return _gl.LUMINANCE;
    if ( p === THREE.LuminanceAlphaFormat ) return _gl.LUMINANCE_ALPHA;
    
    if ( p === THREE.AddEquation ) return _gl.FUNC_ADD;
    if ( p === THREE.SubtractEquation ) return _gl.FUNC_SUBTRACT;
    if ( p === THREE.ReverseSubtractEquation ) return _gl.FUNC_REVERSE_SUBTRACT;
    
    if ( p === THREE.ZeroFactor ) return _gl.ZERO;
    if ( p === THREE.OneFactor ) return _gl.ONE;
    if ( p === THREE.SrcColorFactor ) return _gl.SRC_COLOR;
    if ( p === THREE.OneMinusSrcColorFactor ) return _gl.ONE_MINUS_SRC_COLOR;
    if ( p === THREE.SrcAlphaFactor ) return _gl.SRC_ALPHA;
    if ( p === THREE.OneMinusSrcAlphaFactor ) return _gl.ONE_MINUS_SRC_ALPHA;
    if ( p === THREE.DstAlphaFactor ) return _gl.DST_ALPHA;
    if ( p === THREE.OneMinusDstAlphaFactor ) return _gl.ONE_MINUS_DST_ALPHA;
    
    if ( p === THREE.DstColorFactor ) return _gl.DST_COLOR;
    if ( p === THREE.OneMinusDstColorFactor ) return _gl.ONE_MINUS_DST_COLOR;
    if ( p === THREE.SrcAlphaSaturateFactor ) return _gl.SRC_ALPHA_SATURATE;
    
    return 0;

};

// mod that doesn't suck for negative numbers
function mod(a, b) {
    return ((a % b) + b) % b;
}

function lon_norm(lon) {
    return mod(lon + 180., 360.) - 180.;
}