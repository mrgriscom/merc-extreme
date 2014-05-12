/* guide to hungarian notation (TODO)
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

/*
function Point(unit, ref, data) {
    this.unit = unit;
    this.ref = ref;
    this.data = data;
}
*/

// return next highest power of 2 >= x
function pow2ceil(x) {
    var EPSILON = 1e-9;
    var lgx = Math.log(x) / Math.log(2.);
    return Math.pow(2., Math.ceil(lgx - EPSILON));
}

var vertex_shader;
var fragment_shader;

var TILE_SIZE = 256;               // (px) dimensions of a map tile
var MAX_ZOOM = 22;                 // max zoom level to attempt to fetch image tiles
var SAMPLE_FREQ = 8.;              // (px) spatial frequency to sample tile coverage
var SAMPLE_TIME_FREQ = 2.;         // (hz) temporal frequency to sample tile coverage
var ATLAS_TEX_SIZE = 4096;         // (px) dimensions of single page of texture atlas
var ZOOM_BLEND = .0;               // range over which to fade between adjacent zoom levels
var APPROXIMATION_THRESHOLD = 0.5; // (px) maximum error when using schemes to circumvent lack of opengl precision
var PREC_BUFFER = 2;               // number of zoom levels early to switch to 'high precision' mode
var NORTH_POLE_COLOR = '#ccc';
var SOUTH_POLE_COLOR = '#aaa';

// these aren't really meant to be changed... more just to justify how various constants got their values
var SCREEN_WIDTH_SOFTMAX = 1920;
var SCREEN_HEIGHT_SOFTMAX = 1200;
var MIN_BIAS = 0.;
var MAX_ZOOM_BLEND = .6;
var SCREEN_WIDTH = Math.min(screen.width, SCREEN_WIDTH_SOFTMAX);
var SCREEN_HEIGHT = Math.min(screen.height, SCREEN_HEIGHT_SOFTMAX);
var HIGH_PREC_Z_BASELINE = 16;

//// computed constants

var MAX_Z_WARP = 1. - MIN_BIAS + .5 * MAX_ZOOM_BLEND;
var MIPMAP_LEVELS = Math.ceil(MAX_Z_WARP);
var tiles_per = function(dim, noround) {
    var t = dim / TILE_SIZE *  Math.pow(2, MAX_Z_WARP);
    return noround ? t : Math.ceil(t);
}

var SCREEN_DIAG = Math.sqrt(Math.pow(SCREEN_WIDTH, 2) + Math.pow(SCREEN_HEIGHT, 2));
// maximum span of adjacent tiles of the same zoom level that can be visible at once
var MAX_Z_TILE_SPAN = tiles_per(SCREEN_DIAG);
// edge of tile where adjacent tile should also be loaded to compensate for lower resolution of tile coverage pass
var TILE_FRINGE_WIDTH = Math.min(tiles_per(SAMPLE_FREQ, true), .5);
// 
var TILE_OFFSET_RESOLUTION = pow2ceil(MAX_Z_TILE_SPAN);
// size of a single z-level's cell in the atlas index texture
var TEX_Z_IX_SIZE = 2 * TILE_OFFSET_RESOLUTION;
// number of z index cells in one edge of the index texture
var TEX_IX_CELLS = pow2ceil(Math.sqrt(2 * (MAX_ZOOM + 1)));
// size of the atlas index texture
var TEX_IX_SIZE = TEX_IX_CELLS * TEX_Z_IX_SIZE;
// size of a padded tile in the atlas texture
var TILE_SKIRT = Math.pow(2, MIPMAP_LEVELS); //px
var ATLAS_TILE_SIZE = TILE_SIZE + 2 * TILE_SKIRT;
// number of tiles that can fit in one texture page (along one edge)
var TEX_SIZE_TILES = Math.floor(ATLAS_TEX_SIZE / ATLAS_TILE_SIZE);
// an estimate of how many tiles can be active in the tile index at once
var MAX_TILES_AT_ONCE = tiles_per(SCREEN_WIDTH) * tiles_per(SCREEN_HEIGHT) * 4./3.;
var NUM_ATLAS_PAGES = Math.ceil(MAX_TILES_AT_ONCE / Math.pow(TEX_SIZE_TILES, 2));


function init() {
    vertex_shader = loadShader('vertex');
    fragment_shader = loadShader('fragment');
    
    var merc = new MercatorRenderer($('#container'), window.innerWidth, window.innerHeight, 2.5, 0.5);
    MERC = merc;

    $(window).keypress(function(e) {
        if (e.keyCode == 32) {
            merc.toggle_drag_mode();
            return false;
        } else if (e.keyCode == 113) {
            launchDebug();
        } else if (e.keyCode == 117) {
            METRIC = !METRIC;
        }
    });
    
    var $l = $('#layers');
    _.each(tile_specs, function(e) {
        var $k = $('<div />');
        $k.text(e.name);
        $k.click(function() {
            merc.setLayer(e);
        });
        $l.append($k);
    });
    merc.setLayer(tile_specs[0]);

    merc.start();

    $('#companion').click(function() {
        COMPANION = window.open('companion.html', 'companion', 'width=600,height=600,location=no,menubar=no,toolbar=no,status=no,personalbar=no');
    });
    DEBUG = {postMessage: function(){}};
    METRIC = true;

    $('.swap').click(function() {
        merc.swapPoles();
    });
}

function launchDebug() {
    DEBUG = window.open('debug.html', 'debug', 'width=800,height=600,location=no,menubar=no,toolbar=no,status=no,personalbar=no');
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

/*
use versions in geodesy.js instead

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
*/

// gp -> gw
function translate_pole(pos, pole) {
    var xyz = ll_to_xyz(pos);
    var pole_rlat = pole[0] * Math.PI / 180.;
    
    var latrot = pole_rlat - .5 * Math.PI;
    var xyz_trans = new THREE.Vector3(xyz[0], xyz[1], xyz[2]).applyMatrix4(new THREE.Matrix4().makeRotationY(-latrot));
    var pos_trans = xyz_to_ll([xyz_trans.x, xyz_trans.y, xyz_trans.z]);
    pos_trans[1] = lon_norm(pos_trans[1] + pole[1]);
    return pos_trans;
}

function inv_translate_pole(pos, pole) {
    var pole_rlat = pole[0] * Math.PI / 180.;    
    var latrot = pole_rlat - .5 * Math.PI;
 
    pos[1] -= pole[1];
    var xyz = ll_to_xyz(pos);
    var xyz_trans = new THREE.Vector3(xyz[0], xyz[1], xyz[2]).applyMatrix4(new THREE.Matrix4().makeRotationY(latrot));
    return xyz_to_ll([xyz_trans.x, xyz_trans.y, xyz_trans.z]);
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
        this.setData('position', vix[0], v[0]); // note implied zero for z-coord
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

    this.clearQuads = function(beyond) {
        var attr = this.attributes.index;
        for (var i = beyond * 6; i < attr.array.length; i++) {
            attr.array[i] = 0;
        }
        attr.needsUpdate = true;
    }

}
GridGeometry.prototype = Object.create(THREE.BufferGeometry.prototype);

function TexBuffer(size, texopts, bufopts) {
    bufopts = bufopts || {};
    this.width = size;
    this.height = size * (bufopts.aspect || 1.);
    
    // if bufopts.nocanvas, we don't actually need the <canvas>, but can't
    // figure out how to initialize texture otherwise
    var tmp = mk_canvas(this.width, this.height);
    this.$tx = tmp.canvas;
    this.ctx = tmp.context;

    this.tx = new THREE.Texture(this.$tx);
    var texbuf = this;
    $.each(texopts || {}, function(k, v) {
        texbuf.tx[k] = v;
    });
    this.tx.needsUpdate = true;
    
    this.incrUpdates = [];
    var texbuf = this;
    this.tx.incrementalUpdate = function(updatefunc) {
        for (var i = 0; i < texbuf.incrUpdates.length; i++) {
            texbuf.incrUpdates[i](updatefunc);
        }
        texbuf.incrUpdates = [];
    }
    this.tx.preUpdate = function() {
        if (texbuf.preUpdate) {
            texbuf.preUpdate();
        }
    }
    
    this.update = function(draw) {
        draw(this.ctx, this.width, this.height);
        this.tx.needsUpdate = true;
    }
    
    this.incrementalUpdate = function(updater) {
        // for inspecting canvas
        //updater(function(img, x, y) { texbuf.ctx.drawImage(img, x, y); });
        this.incrUpdates.push(updater);
    }
}

function IndexFragment(type, z, xoffset, yoffset, layer) {
    var ctx = layer.tex_index.ctx;
    var dim = Math.min(Math.pow(2, z), TILE_OFFSET_RESOLUTION);
    this.buf = ctx.createImageData(dim, dim);
    this.offsets = {x: xoffset, y: yoffset};
    this.type = type;
    this.z = z;
    this.tiles = {};
    this.dirty = false;

    this.addTile = function(tile, slot) {
        this.set_px(tile.x, tile.y, slot);
        this.tiles[tile.z + ':' + tile.x + ':' + tile.y] = true;
        this.setDirty();
    }

    this.removeTile = function(z, x, y) {
        this.set_px(x, y, null);
        delete this.tiles[z + ':' + x + ':' + y];
        this.setDirty();
    }

    this.setDirty = function() {
        this.dirty = true;
        layer.tex_index.tx.needsUpdate = true;
    }

    this.empty = function() {
        return this.tiles.length == 0;
    }

    this.set_px = function(x, y, slot) {
        var dx = x - this.offsets.x * TILE_OFFSET_RESOLUTION;
        var dy = y - this.offsets.y * TILE_OFFSET_RESOLUTION;
        var base = 4 * (dy * this.buf.width + dx);
        this.buf.data[base] = slot ? slot.tex + 1 : 0;
        this.buf.data[base + 1] = slot ? slot.x : 0;
        this.buf.data[base + 2] = slot ? slot.y : 0;
        this.buf.data[base + 3] = 255;
    }

    this._update = function(anti) {
        var ix_offsets = layer.index_offsets[(anti ? 1 : 0) + ':' + this.z];
        if (ix_offsets == null) {
            return;
        }

        var dx = mod((this.offsets.x - ix_offsets.x) * TILE_OFFSET_RESOLUTION, Math.pow(2., this.z));
        var dy = (this.offsets.y - ix_offsets.y) * TILE_OFFSET_RESOLUTION;
        if (dx >= TEX_Z_IX_SIZE || dy < 0 || dy >= TEX_Z_IX_SIZE) {
            // out of range for current offset
            return;
        }
 
        var zx = this.z % (TEX_IX_SIZE / TEX_Z_IX_SIZE);
        var zy = Math.floor(this.z / (TEX_IX_SIZE / TEX_Z_IX_SIZE)) + (anti ? .5 : 0) * (TEX_IX_SIZE / TEX_Z_IX_SIZE);
        
        var px = zx * TEX_Z_IX_SIZE + dx;
        var py = zy * TEX_Z_IX_SIZE + dy;

        var frag = this;
        layer.tex_index.update(function(ctx, w, h) {
            ctx.putImageData(frag.buf, px, py);
        });
    }

    this.update = function() {
        if (!this.dirty) {
            return;
        }

        this._update(false);
        this._update(true);
        this.dirty = false;

        if (this.empty()) {
            // purge self
            delete layer.index_fragments[this.z + ':' + this.offsets.x + ':' + this.offsets.y];
        }
    }
}

function TextureLayer(context) {
    
    this.context = context;

    this.curlayer = null;
    
    this.sample_width = Math.round(this.context.width_px / SAMPLE_FREQ);
    this.sample_height = Math.round(this.context.height_px / SAMPLE_FREQ);
    this.target = new THREE.WebGLRenderTarget(this.sample_width, this.sample_height, {format: THREE.RGBFormat});
    this.target.generateMipmaps = false;
    
    this.worker = new Worker('coverage-worker.js');

    this.pending = [];
    
    this.tex_z0 = new TexBuffer(TILE_SIZE, {
        generateMipmaps: true,
        magFilter: THREE.LinearFilter,
        minFilter: THREE.LinearMipMapLinearFilter,
        wrapS: THREE.RepeatWrapping, // still getting seams... why?
        flipY: false,
    }, {aspect: 2.});
    this.tex_atlas = [];
    for (var i = 0; i < NUM_ATLAS_PAGES; i++) {
        var page = new TexBuffer(ATLAS_TEX_SIZE, {
            // mipmapping must be done manually due to non-continguity of images
            generateMipmaps: false,
            magFilter: THREE.LinearFilter,
            minFilter: THREE.LinearFilter,
            flipY: false,
        }, {nocanvas: true});
        this.tex_atlas.push(page);
    }
    this.tex_index = new TexBuffer(TEX_IX_SIZE, {
        generateMipmaps: false,
        magFilter: THREE.NearestFilter,
        minFilter: THREE.NearestFilter,
        flipY: false,
    });

    this.tile_index = {};
    this.free_slots = {};
    for (var i = 0; i < this.tex_atlas.length; i++) {
        for (var j = 0; j < TEX_SIZE_TILES; j++) {
            for (var k = 0; k < TEX_SIZE_TILES; k++) {
                this.free_slots[i + ':' + j + ':' + k] = true;
            }
        }
    }
    this.index_offsets = {};
    this.index_fragments = {};
    var layer = this;
    this.tex_index.preUpdate = function() {
        _.each(layer.index_offsets, function(v, k) {
            var pcs = k.split(':');
            var anti = +pcs[0];
            var z = +pcs[1];

            layer.each_fragment_for_z(layer.curlayer.id, z, v.x, v.y, function(frag) {
                frag.update();
            });
        });
    }
    
    this.init = function() {
        var layer = this;
        this.worker.addEventListener('message', function(e) {
            layer.sample_coverage_postprocess(e.data);
            layer.sampling_complete();
        }, false);
    }
    
    this.setLayer = function(type) {
        if (this.curlayer != null && type.id == this.curlayer.id) {
            return;
        }

        type.tilefunc = compile_tile_spec(type.url);
        this.curlayer = type;

        // z0 tile has a dedicated texture, so z0 for multiple layers cannot co-exist
        // ensure the tile is reloaded when the layer is switched back
        var that = this;
        var flag_tile = function(z, x, y) {
            var key = that.shown_layer + ':' + z + ':' + x + ':' + y;
            var entry = that.tile_index[key];
            if (entry) {
                entry.rebuild_z0 = true;
            }
        }
        flag_tile(0, 0, 0);

        // trigger immediate reload
        context.last_sampling = null;
    }

    this.sample_coverage = function(oncomplete) {
        if (!this.sampleBuff) {
            this.sampleBuff = new Uint8Array(this.sample_width * this.sample_height * 4);
        }
        this.sampling_complete = oncomplete;
        
        var gl = this.context.glContext;
        this.context.renderer.render(this.context.scene, this.context.camera, this.target);
        // readPixels is slow and a bottleneck, seemingly regardless of buffer size
        gl.readPixels(0, 0, this.sample_width, this.sample_height, gl.RGBA, gl.UNSIGNED_BYTE, this.sampleBuff); // RGBA required by spec
        this.worker.postMessage({ref: this.context.ref_t, antiref: this.context.anti_ref_t});
        this.worker.postMessage(this.sampleBuff);
    }
    
    var offset = function(min, z) {
        return Math.floor(mod(min, Math.pow(2., z)) / TILE_OFFSET_RESOLUTION);
    }

    this.each_fragment_for_z = function(layer, z, xo, yo, func) {
        for (var i = 0; i < 2; i++) {
            var x = mod(xo + i, Math.pow(2, z) / TILE_OFFSET_RESOLUTION);
            for (var j = 0; j < 2; j++) {
                var y = yo + j;
                var frag = this.index_fragments[layer + ':' + z + ':' + x + ':' + y];
                if (frag) {
                    func(frag);
                }
            }
        }
    }

    this.tile_index_add = function(layer_type, tile, slot) {
        var xo = offset(tile.x, tile.z);
        var yo = offset(tile.y, tile.z);
        var fragkey = layer_type + ':' + tile.z + ':' + xo + ':' + yo;
        var frag = this.index_fragments[fragkey];
        if (!frag) {
            frag = new IndexFragment(layer_type, tile.z, xo, yo, this);
            this.index_fragments[fragkey] = frag;
        }
        frag.addTile(tile, slot);
    }

    this.tile_index_remove = function(layer_type, z, x, y) {
        var xo = offset(x, z);
        var yo = offset(y, z);
        var fragkey = layer_type + ':' + z + ':' + xo + ':' + yo;
        var frag = this.index_fragments[fragkey];
        frag.removeTile(z, x, y);
        // removal of empty frag from index_fragments happens after texture refresh
    }

    this.sample_coverage_postprocess = function(data) {
        var curlayer = this.curlayer;
        var tilekey = function(tile) {
            return curlayer.id + ':' + tile.z + ':' + tile.x + ':' + tile.y;
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
        // include all parent tiles of visible tiles
        // support smoother zoom-out, and we always need the z0 tile loaded
        _.each(_.clone(data), function(v, k) {
            var t = unpack_tile(k);
            while (true) {
                t.z -= 1;
                t.x = Math.floor(t.x / 2);
                t.y = Math.floor(t.y / 2);
                var key = +t.anti + ':' + t.z + ':' + t.x + ':' + t.y;
                if (t.z >= 0 && !data[key]) {
                    data[key] = true;
                } else {
                    break;
                }
            }
        });
        var tiles = _.sortBy(_.map(data, function(v, k) { return unpack_tile(k); }),
                             function(e) { return e.z + (e.anti ? .5 : 0.); });

        var layer = this;
        
        if (window.MRU_counter == null) {
            MRU_counter = 0;
        }
        var ranges = {};
        var range_basetile = {};
        $.each(tiles, function(i, tile) {
            var key = (tile.anti ? 1 : 0) + ':' + tile.z;
            var r = ranges[key];
            if (r == null) {
                range_basetile[key] = tile;
                ranges[key] = {xmin: tile.x, xmax: tile.x, ymin: tile.y, ymax: tile.y};
            } else {
                var tile_x = unwraparound(range_basetile[key].x, tile.x, Math.max(Math.pow(2., tile.z), TEX_Z_IX_SIZE));
                r.xmin = Math.min(r.xmin, tile_x);
                r.xmax = Math.max(r.xmax, tile_x);
                r.ymin = Math.min(r.ymin, tile.y);
                r.ymax = Math.max(r.ymax, tile.y);
            }
        });
        $.each(ranges, function(k, v) {
            // assert range <= TILE_OFFSET_RESOLUTION

            var pcs = k.split(':');
            var anti = +pcs[0];
            var z = +pcs[1];

            var xoffset = offset(v.xmin, z);
            var yoffset = offset(v.ymin, z);
            var cur_offsets = layer.index_offsets[k];
            if (layer.shown_layer != layer.curlayer.id || cur_offsets == null || cur_offsets.x != xoffset || cur_offsets.y != yoffset) {
                layer.index_offsets[k] = {x: xoffset, y: yoffset};
                layer.set_offset(z, anti, xoffset, yoffset);

                layer.clear_tile_ix(z, anti);
                layer.each_fragment_for_z(layer.curlayer.id, z, xoffset, yoffset, function(frag) {
                    frag.setDirty();
                });
            }
        });
        this.shown_layer = this.curlayer.id;

        // mark all tiles for LRU if exist in cache
        $.each(tiles, function(i, tile) {
            var ix_entry = layer.tile_index[tilekey(tile)];
            if (ix_entry) {
                ix_entry.mru = MRU_counter;
            }
        });
        this.tiles_by_age = _.sortBy(_.filter(_.pairs(this.tile_index), function(e) {
            return e[1].slot != null;
        }), function(e) {
            return -e[1].mru;
        });

        var split_slot_key = function(key) {
            var pcs = key.split(':');
            return {tex: +pcs[0], x: +pcs[1], y: +pcs[2]};
        };

        this.active_tiles = {};
        _.each(tiles, function(tile) {
            layer.active_tiles[tilekey(tile)] = true;
        });

        var tiles = _.filter(tiles, function(e) { return e.z <= (curlayer.max_depth || MAX_ZOOM); });
        $.each(tiles, function(i, tile) {
            //debug to reduce bandwidth (high zoom levels move out of view too fast)
            //TODO replace with movement-based criteria
            //if (tile.z > 16) {
            //    return;
            //}

            var entry = layer.tile_index[tilekey(tile)];
            if (entry != null && !entry.rebuild_z0) {
                return;
            }
            
            layer.tile_index[tilekey(tile)] = {status: 'loading'};
            load_image(curlayer, tile, function(img) {
                var ix_entry = layer.tile_index[tilekey(tile)];
                if (img == null) {
                    ix_entry.status = 'noexist';
                    return;
                }
                ix_entry.status = 'loaded';
                ix_entry.img = img;
                
                if (!layer.active_tiles[tilekey(tile)]) {
                    //console.log('tile moot');
                    delete layer.tile_index[tilekey(tile)];
                    return;
                }

                if (tile.z == 0) {
                    layer.mk_top_level_tile(img);
                    delete ix_entry.rebuild_z0;
                    return;
                }

                var slot = null;
                $.each(layer.free_slots, function(k, v) {
                    // always pick first and bail
                    slot = split_slot_key(k);
                    return false;
                });
                if (slot == null) {
                    //console.log('no slot');
                    var _oldest = layer.tiles_by_age.pop() || [null, null];
                    var oldest_key = _oldest[0];
                    var oldest_entry = _oldest[1];
                    if (oldest_entry == null || oldest_entry.mru == MRU_counter) {
                        // tile cache is full (provision extra space?)
                        console.log('tile cache is full!');
                        return;
                    }
                    
                    slot = oldest_entry.slot;
                    delete layer.tile_index[oldest_key];

                    var pcs = oldest_key.split(':');
                    layer.tile_index_remove(pcs[0], +pcs[1], +pcs[2], +pcs[3]);
                }
                
                ix_entry.slot = slot;
                ix_entry.pending = true;
                delete layer.free_slots[slot.tex + ':' + slot.x + ':' + slot.y];
                layer.pending.push({layer: curlayer, tile: tile, img: img, slot: slot});
                
                layer.tile_index_add(curlayer.id, tile, slot);
                ix_entry.mru = MRU_counter;
            });
        });
        
        MRU_counter++;

        DEBUG.postMessage({type: 'tiles', data: data}, '*');
    }

    var skirt = 1;
    var seamCorner = mk_canvas(skirt, skirt);
    var seamHoriz = mk_canvas(TILE_SIZE, skirt);
    var seamVert = mk_canvas(skirt, TILE_SIZE);

    this.handlePending = function() {
        var layer = this;
        var tilekey = function(layer, tile) {
            return layer.id + ':' + tile.z + ':' + tile.x + ':' + tile.y;
        }
        var seamCoords = function(slot, dx, dy) {
            var xoffset = (dx < 0 ? -skirt : dx > 0 ? TILE_SIZE : 0);
            var yoffset = (dy < 0 ? -skirt : dy > 0 ? TILE_SIZE : 0);
            return {x: ATLAS_TILE_SIZE * slot.x + TILE_SKIRT + xoffset,
                    y: ATLAS_TILE_SIZE * slot.y + TILE_SKIRT + yoffset};
        }
        var writeImgData = function(slot, dx, dy, getimg) {
            layer.tex_atlas[slot.tex].incrementalUpdate(function(update) {
                var coord = seamCoords(slot, dx, dy);
                update(getimg(), coord.x, coord.y);
            });
        }
        var imgOffset = function(k) {
            return k > 0 ? skirt - TILE_SIZE : 0;
        }

        var handle_neighbor = function(e, dx, dy) {
            var tile = e.tile;
            var slot = e.slot;

            var buf = (dx != 0 && dy != 0 ? seamCorner : dx != 0 ? seamVert : seamHoriz);
            var neighbor = {z: tile.z, x: mod(tile.x + dx, Math.pow(2., tile.z)), y: tile.y + dy};
            var n_entry = layer.tile_index[tilekey(e.layer, neighbor)];
            if (neighbor.y < 0 || neighbor.y >= Math.pow(2., tile.z)) {
                // out of bounds
                writeImgData(slot, dx, dy, function() {
                    buf.context.fillStyle = (dy < 0 ? NORTH_POLE_COLOR : SOUTH_POLE_COLOR);
                    buf.context.fillRect(0, 0, buf.canvas.width, buf.canvas.height);
                    return buf.canvas;
                });
            } else if (n_entry != null && n_entry.slot && !n_entry.pending) {
                //write this edge to other tile
                writeImgData(n_entry.slot, -dx, -dy, function() {
                    buf.context.drawImage(e.img, imgOffset(dx), imgOffset(dy));
                    return buf.canvas;
                });
                //write other tile's edge to this tile
                writeImgData(slot, dx, dy, function() {
                    buf.context.drawImage(n_entry.img, imgOffset(-dx), imgOffset(-dy));
                    return buf.canvas;
                });
            }
        }

        _.each(this.pending, function(e) {
            //console.log('loading', tilekey(tile));
            writeImgData(e.slot, 0, 0, function() { return e.img; });

            for (var dx = -1; dx < 2; dx++) {
                for (var dy = -1; dy < 2; dy++) {
                    if (dx == 0 && dy == 0) {
                        continue;
                    }
                    handle_neighbor(e, dx, dy);
                }
            }

            delete layer.tile_index[tilekey(e.layer, e.tile)].pending;
        });
        this.pending = [];
    }
    
    this.set_offset = function(z, anti, xo, yo) {
        var px = z;
        var py = (anti ? .5 : 0) * TEX_IX_SIZE + TEX_Z_IX_SIZE - 1;
        
        this.tex_index.update(function(ctx, w, h) {
            var buf = ctx.createImageData(1, 1);
            
            buf.data[0] = (xo >> 16) & 0xff;
            buf.data[1] = (xo >> 8) & 0xff;
            buf.data[2] = xo & 0xff;
            buf.data[3] = 255;
            ctx.putImageData(buf, px, py);
            
            buf.data[0] = (yo >> 16) & 0xff;
            buf.data[1] = (yo >> 8) & 0xff;
            buf.data[2] = yo & 0xff;
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

    this.mk_top_level_tile = function(img) {
        this.tex_z0.update(function(ctx, w, h) {
            ctx.fillStyle = NORTH_POLE_COLOR;
            ctx.fillRect(0, 0, TILE_SIZE, .5*TILE_SIZE);
            ctx.fillStyle = SOUTH_POLE_COLOR;
            ctx.fillRect(0, 1.5*TILE_SIZE, TILE_SIZE, .5*TILE_SIZE);
            ctx.drawImage(img, 0, .5*TILE_SIZE);
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
                anti_ref_t: {type: 'v2', value: null},
                tx_ix: {type: 't', value: this.tex_index.tx},
                tx_atlas: {type: 'tv', value: $.map(this.tex_atlas, function(e) { return e.tx; })},
                tx_z0: {type: 't', value: this.tex_z0.tx},
                zoom_blend: {type: 'f', value: ZOOM_BLEND},

                hp_pole_tile: {type: 'v2', value: null},
                hp_pole_offset: {type: 'v2', value: null},
                hp_ref_tile: {type: 'v2', value: null},
                hp_antiref_tile: {type: 'v2', value: null},
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
        if (texture.preUpdate) {
            texture.preUpdate();
        }

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
        console.log(this.glContext.getSupportedExtensions());

        this.renderer.setSize(this.width_px, this.height_px);
        // TODO handle window/viewport resizing
        $container.append(this.renderer.domElement);
        
        this.init_interactivity();
        
        this.camera = new THREE.OrthographicCamera(0, this.width_px, this.height_px, 0, -1, 1);

        this.scene = new THREE.Scene();
        this.group = new THREE.Object3D();
        this.scene.add(this.group);
        this.layer = new TextureLayer(this);
        this.currentObjs = [];

	    var M = new THREE.Matrix4();
	    M.multiply(new THREE.Matrix4().makeScale(this.scale_px, this.scale_px, 1));
	    M.multiply(new THREE.Matrix4().makeRotationZ(-0.5 * Math.PI));
	    M.multiply(new THREE.Matrix4().makeTranslation(-this.lonExtent, this.mercExtentS, 0));
        this.setWorldMatrix(M);

        this.curPole = COORDS.home;
        //this.curPole = COORDS.home_ct;
        //this.curPole = COORDS.home_za;
        //this.curPole = [43.56060, -7.41384];
        //this.curPole = [-16.159283,-180.];
        //this.curPole = [89.9999, 0];
    }

    this.setLayer = function(layer) {
        this.layer.setLayer(layer);
        $('#attribution span').html(formatAttr(layer.attr));
    }

    this.setWorldMatrix = function(M) {
        // this currently UPDATES the matrix
        this.M = this.M || new THREE.Matrix4();
        this.group.applyMatrix(M);

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

            /*
            $("#mouseinfo").css({
                top: (e.pageY + 15) + "px",
                left: (e.pageX + 15) + "px"
            });
            */

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
    
    var _interp = function(a, b, k) {
        return (1. - k) * a + k * b;
    }
    var computeTex = function(x, y, offset, pole) {
        var merc_ll = xy_to_ll(x, y);
        var ll = translate_pole(merc_ll, pole);
        var r = ll_to_xy(ll[0], ll[1]);
        return [unwraparound(offset.x, r.x), r.y];
    }
    var MIN_CELL_SIZE = 32;
    this.linearInterp = function(x0, x1, y0, y1, offset) {
        var buf = [];
        if (y0 < y1) {
            var renderer = this;
            mp = _.map([[x0, y0], [x1, y0], [x0, y1], [x1, y1]], function(e) {
                return computeTex(e[0], e[1], offset, renderer.curPole);
            });

            this._linearInterp(buf, offset, x0, x1, y0, y1, mp);
        }
        return buf;
    }
    this._linearInterp = function(buf, offset, x0, x1, y0, y1, mp) {
        var width = (y1 - y0);
        var height = (x1 - x0);
        var min_cell_size = 2. * MIN_CELL_SIZE / this.scale_px;
        var terminal = width <= min_cell_size && height <= min_cell_size;

        if (!terminal) {
            var uv_interp = [_interp(mp[0][0], mp[3][0], .5),
                             _interp(mp[0][1], mp[3][1], .5)];
            var p_center = [_interp(x0, x1, .5), _interp(y0, y1, .5)];

            var a = xy_to_ll(uv_interp[0], .5 - uv_interp[1]);
            var b = inv_translate_pole(a, this.curPole);
            var c = ll_to_xy(b[0], b[1]);
            var d = [c.x, .5 - c.y];
            var diff = [wraparound_diff(p_center[0] - d[0]), p_center[1] - d[1]];
            var error = Math.sqrt(Math.pow(diff[0], 2) + Math.pow(diff[1], 2)) * this.scale_px;

            terminal = (error < APPROXIMATION_THRESHOLD);
        }

        if (terminal) {
            var tex = _.map(mp, function(k) { return [k[0] - offset.x, k[1] - offset.y]; });
            buf.push({x0: x0, y0: y0, x1: x1, y1: y1, tex: tex});
        } else {
            var xcenter = _interp(x0, x1, .5);
            var ycenter = _interp(y0, y1, .5);

            if (height / width > Math.sqrt(2.)) {
                var texleft = computeTex(xcenter, y0, offset, this.curPole);
                var texright = computeTex(xcenter, y1, offset, this.curPole);
                this._linearInterp(buf, offset, x0, xcenter, y0, y1, [mp[0], texleft, mp[2], texright]);
                this._linearInterp(buf, offset, xcenter, x1, y0, y1, [texleft, mp[1], texright, mp[3]]);
            } else if (width / height > Math.sqrt(2.)) {
                var textop = computeTex(x0, ycenter, offset, this.curPole);
                var texbottom = computeTex(x1, ycenter, offset, this.curPole);
                this._linearInterp(buf, offset, x0, x1, y0, ycenter, [mp[0], mp[1], textop, texbottom]);
                this._linearInterp(buf, offset, x0, x1, ycenter, y1, [textop, texbottom, mp[2], mp[3]]);
            } else {
                var texleft = computeTex(xcenter, y0, offset, this.curPole);
                var texright = computeTex(xcenter, y1, offset, this.curPole);
                var textop = computeTex(x0, ycenter, offset, this.curPole);
                var texbottom = computeTex(x1, ycenter, offset, this.curPole);
                var texcenter = computeTex(xcenter, ycenter, offset, this.curPole);
                this._linearInterp(buf, offset, x0, xcenter, y0, ycenter, [mp[0], texleft, textop, texcenter]);
                this._linearInterp(buf, offset, x0, xcenter, ycenter, y1, [textop, texcenter, mp[2], texright]);
                this._linearInterp(buf, offset, xcenter, x1, y0, ycenter, [texleft, mp[1], texcenter, texbottom]);
                this._linearInterp(buf, offset, xcenter, x1, ycenter, y1, [texcenter, texbottom, texright, mp[3]]);
            }
        }
    }
    
    this.makeQuad = function(geo_mode, max) {
        var grid = new GridGeometry(max || 1);
        grid.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1000);
        var plane = new THREE.Mesh(grid, this.layer._materials['image'][geo_mode]);
        plane.geo_mode = geo_mode;
        plane.update = function(x0, x1, y0, y1, tex) {
            grid.setQuad(0, x0, x1, y0, y1, tex);
        };
        plane.updateAll = function(data) {
            for (var i = 0; i < data.length; i++) {
                var q = data[i];
                grid.setQuad(i, q.x0, q.x1, q.y0, q.y1, q.tex);
            }
            grid.clearQuads(data.length);
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
            this.qLinearAnti = this.makeQuad('linear', 1024);
            this.qGooeyMiddle = this.makeQuad('sphere');
        }

        this.setPole(this.curPole[0], this.curPole[1]);
        this.setRefPoint();
        
        var debug = {};
        if (window.POS) {
            var p = renderer.xyToWorld(POS.x, POS.y);
            var merc_ll = xy_to_ll(mod(p.x, 1.), p.y);
            var ll = translate_pole(merc_ll, renderer.curPole);

            var xy_prec = prec_digits_for_res(1. / this.scale_px);
            debug.merc_xy = p.x.toFixed(xy_prec) + ' ' + p.y.toFixed(xy_prec);
            var mercllfmt = fmt_pos(merc_ll, 5);
            debug.merc_ll = mercllfmt.lat + ' ' + mercllfmt.lon;

            dist = EARTH_MEAN_RAD * Math.PI / 180. * (90. - merc_ll[0]);
            bearing = mod(180. - merc_ll[1], 360.);
            scale = 2 * Math.PI / renderer.scale_px * Math.cos(merc_ll[0] * Math.PI / 180.) * EARTH_MEAN_RAD;
            orient = line_plotter(this.curPole, bearing)(dist, true)[1];

            var polefmt = fmt_pos(this.curPole, 5);
            $('#poleinfo .data').text(polefmt.lat + ' ' + polefmt.lon);
            var antipolefmt = fmt_pos(antipode(this.curPole), 5);
            $('#antipoleinfo .data').text(antipolefmt.lat + ' ' + antipolefmt.lon);
            var posfmt = fmt_pos(ll, 5);
            $('#mouseinfo #pos').text(posfmt.lat + ' ' + posfmt.lon);
            if (METRIC) {
                unit = dist < 1000 ? 'm' : 'km';
            } else {
                unit = dist < geomean(2000, 'ft', 1, 'mi') ? 'ft' : 'mi';
            }
            $('#mouseinfo #dist').text(format_with_unit(dist, scale, unit));
            var bearing_prec = prec_digits_for_res(360. / this.scale_px);
            $('#mouseinfo #bearing').text(npad(bearing.toFixed(bearing_prec), bearing_prec + 3 + (bearing_prec > 0 ? 1 : 0)) + '\xb0');
            $('#orient span').css('transform', 'rotate(' + (270 - orient) + 'deg)');
            var scalebar = snap_scale(scale, 33);
            $('#mouseinfo #scale #label').text(scalebar.label);
            $('#mouseinfo #scale #bar').css('width', scalebar.size + 'px');
        }

        var p0 = renderer.xyToWorld(0, this.height_px);
        var p1 = renderer.xyToWorld(this.width_px, 0);
        var xtop = p0.x;
        var xbottom = p1.x;
        var yleft = p0.y;
        var yright = p1.y;

        var low_prec_cutoff_latrad = Math.acos(Math.min(this.scale_px / Math.pow(2., 23. - PREC_BUFFER), 1.));
        // merc-y cutoff beyond which we must mitigate lack of shader precision
        var low_prec_cutoff = .5 - ll_to_xy(low_prec_cutoff_latrad * 180. / Math.PI, 0).y;

        var absy_min = ((yleft < 0) && (yright > 0) ? 0 : Math.min(Math.abs(yleft), Math.abs(yright)));
        var absy_max = Math.min(Math.max(Math.abs(yleft), Math.abs(yright)), 5.); // cap due to asympote issues
        // merc-y cutoff below which a flat-earth approximation is too crude
        var flat_earth_cutoff = solve_eq(absy_min, absy_max, 1. / this.scale_px, function(x) {
            var lat = xy_to_ll(0, x)[0];
            return flat_earth_error_px(lat, renderer.scale_px, renderer.curPole[0]) < APPROXIMATION_THRESHOLD;
        });
        flat_earth_cutoff = Math.max(flat_earth_cutoff, low_prec_cutoff);

        this.qPolarAnti.update(xtop, xbottom, yleft, -flat_earth_cutoff);
        this.qLinearAnti.updateAll(this.linearInterp(
            xtop,
            xbottom,
            Math.max(-flat_earth_cutoff, p0.y),
            Math.min(-low_prec_cutoff, p1.y),
            this.hp_anti_ref_t));
        this.qGooeyMiddle.update(xtop, xbottom, -low_prec_cutoff, low_prec_cutoff);
        this.qLinear.updateAll(this.linearInterp(
            xtop,
            xbottom,
            Math.max(low_prec_cutoff, p0.y),
            Math.min(flat_earth_cutoff, p1.y),
            this.hp_ref_t));
        this.qPolar.update(xtop, xbottom, flat_earth_cutoff, yright);

        this.layer.handlePending();
        this.renderer.render(this.scene, this.camera);

        if (window.COMPANION) {
            var tf = this.layer.curlayer.tilefunc;
            delete this.layer.curlayer.tilefunc;
            COMPANION.postMessage({
                pole: this.pole,
                layer: this.layer.curlayer,
                dist: dist,
                bearing: bearing,
            }, '*');
            this.layer.curlayer.tilefunc = tf;
        }

        var setMaterials = function(output_mode) {
            $.each(renderer.currentObjs, function(i, e) {
                e.material = renderer.layer._materials[output_mode][e.geo_mode];
            });
        }

        if (!this.sampling_in_progress && (this.last_sampling == null || timestamp - this.last_sampling > 1./SAMPLE_TIME_FREQ)) {
            this.sampling_in_progress = true;
            setMaterials('sampler');
            this.layer.sample_coverage(function() {
                renderer.sampling_in_progress = false;
                renderer.last_sampling = clock();
            });
            setMaterials('image');
        }

        DEBUG.postMessage({type: 'frame'}, '*');
        DEBUG.postMessage({type: 'text', data: debug}, '*');
    }
    
    this.setPole = function(lat, lon) {
        lon = lon_norm(lon);
        this.pole = [lat, lon];
        this.pole_t = ll_to_xy(lat, lon);
        this.layer.uniforms.pole.value = new THREE.Vector2(lon, lat);
        this.layer.uniforms.pole_t.value = new THREE.Vector2(this.pole_t.x, this.pole_t.y);

        var hp_x = hp_split(this.pole_t.x);
        var hp_y = hp_split(this.pole_t.y);
        this.layer.uniforms.hp_pole_tile.value = new THREE.Vector2(hp_x.coarse, hp_y.coarse);
        this.layer.uniforms.hp_pole_offset.value = new THREE.Vector2(hp_x.fine, hp_y.fine);
    };
    
    this.setRefPoint = function() {
        var renderer = this;
        var refPoint = function(lo) {
            var merc = renderer.xyToWorld(lo ? 0 : renderer.width_px, 0.5 * renderer.height_px);
            var merc_ll = xy_to_ll(merc.x, merc.y);
            var ll = translate_pole(merc_ll, renderer.pole);
            return ll_to_xy(ll[0], ll[1]);
        }
        
        this.ref_t = refPoint(false);
        this.layer.uniforms.ref_t.value = new THREE.Vector2(this.ref_t.x, this.ref_t.y);
        this.anti_ref_t = refPoint(true);
        this.layer.uniforms.anti_ref_t.value = new THREE.Vector2(this.anti_ref_t.x, this.anti_ref_t.y);

        var hp_ref_x = hp_split(this.ref_t.x);
        var hp_ref_y = hp_split(this.ref_t.y);
        var hp_antiref_x = hp_split(this.anti_ref_t.x);
        var hp_antiref_y = hp_split(this.anti_ref_t.y);
        this.hp_ref_t = {x: hp_ref_x.coarse, y: hp_ref_y.coarse};
        this.hp_anti_ref_t = {x: hp_antiref_x.coarse, y: hp_antiref_y.coarse};
        this.layer.uniforms.hp_ref_tile.value = new THREE.Vector2(this.hp_ref_t.x, this.hp_ref_t.y);
        this.layer.uniforms.hp_antiref_tile.value = new THREE.Vector2(this.hp_anti_ref_t.x, this.hp_anti_ref_t.y);
    }
    
    this.start = function() {
        var merc = this;
        renderLoop(function(t) { merc.render(t); });
    }
    

    this.poleAt = function(lat, lon, soft) {
        this.curPole = [lat, lon];
        if (!soft) {
            this.last_sampling = null;
        }
    }

    this.swapPoles = function() {
        var pole = antipode(this.curPole);
        this.poleAt(pole[0], pole[1]);
    }

    this.init();
}

function hp_split(val) {
    var hp_extent = Math.pow(2., HIGH_PREC_Z_BASELINE);
    var primary = Math.floor(val * hp_extent) / hp_extent;
    var remainder = val - primary;
    return {coarse: primary, fine: remainder};
}



function load_image(layer, tile, onload) {
    if (tile.z == 0 && layer.no_z0) {
        load_image_bing_hack(layer, onload);
        return;
    }

    var img = new Image();
    img.onload = function() { onload(img); };
    img.onerror = function() { onload(null); }; // 404 or CORS denial
    img.crossOrigin = 'anonymous';
    img.src = layer.tilefunc(tile.z, tile.x, tile.y);
}

function load_image_bing_hack(layer, onload) {
    var num_loaded = 0;
    var num_errors = 0;
    var c = mk_canvas(TILE_SIZE, TILE_SIZE);

    var mk_onload = function(x, y) {
        return function(img) {
            num_loaded++;
            if (img != null) {
                c.context.drawImage(img, x * .5*TILE_SIZE, y * .5*TILE_SIZE, .5*TILE_SIZE, .5*TILE_SIZE);
            } else {
                num_errors++;
            }
            if (num_loaded == 4) {
                if (num_errors == 4) {
                    onload(null);
                } else {
                    onload(c.canvas);
                }
            }
        }
    };

    for (var i = 0; i < 2; i++) {
        for (var j = 0; j < 2; j++) {
            load_image(layer, {z: 1, x: i, y: j}, mk_onload(i, j));
        }
    }
}

//=== TILE SERVICES ===

var tile_specs = [
    {
        id: 'gmap',
        name: 'Google Map',
        url: 'https://mts{s:0-3}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
        attr: ['Google'],
    },
    {
        id: 'gsat',
        name: 'Google Satellite',
        url: 'https://mts{s:0-3}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
        //url: 'https://khms{s:0-3}.google.com/kh/v=149&x={x}&y={y}&z={z}',
        attr: ['Google'],
    },
    {
        id: 'gterr',
        name: 'Google Terrain',
        url: 'https://mts{s:0-3}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
        max_depth: 15,
        attr: ['Google'],
    },
    {
        id: 'gtrans',
        name: 'Google Transit',
        url: 'http://mts{s:0-3}.google.com/vt/lyrs=m,transit&opts=r&x={x}&y={y}&z={z}',
        attr: ['Google'],
    },
    {
        id: 'mb',
        name: 'Mapbox Terrain',
        url: 'https://{s:abcd}.tiles.mapbox.com/v3/examples.map-9ijuk24y/{z}/{x}/{y}.png',
        attr: [['Mapbox', 'https://www.mapbox.com/about/maps/'], ['OpenStreetMap contributors', 'http://www.openstreetmap.org/copyright']],
    },
    {
        id: 'space',
        name: '"Space Station" by Mapbox',
        url: 'https://{s:abcd}.tiles.mapbox.com/v3/examples.3hqcl3di/{z}/{x}/{y}.jpg',
        attr: [['Mapbox', 'https://www.mapbox.com/about/maps/'], ['OpenStreetMap contributors', 'http://www.openstreetmap.org/copyright']],
    },
    {
        id: 'zomb',
        name: '"Zombie World" by Mapbox',
        url: 'https://{s:abcd}.tiles.mapbox.com/v3/examples.fb8f9523/{z}/{x}/{y}.jpg',
        attr: [['Mapbox', 'https://www.mapbox.com/about/maps/'], ['OpenStreetMap contributors', 'http://www.openstreetmap.org/copyright']],
    },
    {
        id: 'pint',
        name: 'Pinterest theme by Stamen/Mapbox',
        url: 'https://{s:abcd}.tiles.mapbox.com/v3/examples.map-51f69fea/{z}/{x}/{y}.jpg',
        attr: [['Pinterest'], ['OpenStreetMap contributors', 'http://www.openstreetmap.org/copyright']],
    },
    {
        id: 'bingmap',
        name: 'Bing Map',
        url: 'http://ak.t{s:0-3}.tiles.virtualearth.net/tiles/r{qt}?g=2432&shading=hill&n=z&key=AsK5lEUmEKKiXE2_QpZBfLW6QJXAUNZL9x0D9u0uOQv5Mfjcz-duXV1qX2GFg-N_',
        no_z0: true,
        attr: ['Microsoft', 'Nokia'],
    },
    {
        id: 'bingsat',
        name: 'Bing Satellite',
        url: 'http://ak.t{s:0-3}.tiles.virtualearth.net/tiles/a{qt}?g=2432&n=z&key=AsK5lEUmEKKiXE2_QpZBfLW6QJXAUNZL9x0D9u0uOQv5Mfjcz-duXV1qX2GFg-N_',
        no_z0: true,
        attr: ['Microsoft', 'Nokia'],
    },
    {
        id: 'bingsatl',
        name: 'Bing Hybrid',
        url: 'http://ak.t{s:0-3}.tiles.virtualearth.net/tiles/h{qt}?g=2432&n=z&key=AsK5lEUmEKKiXE2_QpZBfLW6QJXAUNZL9x0D9u0uOQv5Mfjcz-duXV1qX2GFg-N_',
        no_z0: true,
        attr: ['Microsoft', 'Nokia'],
    },
    {
        id: 'osm',
        name: 'OSM Mapnik',
        url: 'http://{s:abc}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attr: [['OpenStreetMap contributors', 'http://www.openstreetmap.org/copyright']],
    },
];

function formatAttr(attr) {
    return '&copy; ' + _.map(attr, function(e) {
        if (typeof e == 'string') {
            return e;
        } else {
            return '<a target="_blank" href="' + e[1] + '">' + e[0] + '</a>';
        }
    }).join(', ');
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
        'ATLAS_TILE_SIZE',
        'TILE_FRINGE_WIDTH',
        'TILE_SKIRT',
    ];
    const_ctx = {};
    _.each(constants, function(e) {
        const_ctx[e] = window[e];
    });
    context.constants = const_ctx;

    context.num_atlas_pages = NUM_ATLAS_PAGES;

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
        render(clock());
        requestAnimationFrame(cb);
    }
    requestAnimationFrame(cb);
}

function clock() {
    return window.performance.now() / 1000;
}





function compile_tile_spec(spec) {
    var converters = {
        z: function(zoom, x, y) { return zoom; },
        x: function(zoom, x, y) { return x; },
        y: function(zoom, x, y) { return y; },
        '-y': function(zoom, x, y) { return Math.pow(2, zoom) - 1 - y; },
        s: function(zoom, x, y, arg) {
            var k = x + y;
            if (arg.indexOf('-') == -1) {
                return arg.split('')[k % arg.length];
            } else {
                var bounds = arg.split('-');
                var min = +bounds[0];
                var max = +bounds[1];
                return min + k % (max - min + 1);
            }
        },
        qt: function(zoom, x, y, arg) {
            var bin_digit = function(h, i) {
                return Math.floor(h / Math.pow(2, i) % 2);
            }
            
            var qt = '';
            for (var i = zoom - 1; i >= 0; i--) {
                var q = 2 * bin_digit(y, i) + bin_digit(x, i);
                qt += (arg != null ? arg[q] : q);
            }
            return qt;
        },
    };

    regex = new RegExp('{(.+?)(:.+?)?}', 'g');
    return function(zoom, x, y) {
        return spec.replace(regex, function(full_match, key, key_args) {
            if (!key_args) {
                key_args = null;
            } else {
                key_args = key_args.substring(1);
            }

            return converters[key](zoom, x, y, key_args);
        });
    }
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

function mk_canvas(w, h) {
    var $c = $('<canvas />');
    $c.attr('width', w);
    $c.attr('height', h);
    var c = $c[0];
    var ctx = c.getContext('2d');
    return {canvas: c, context: ctx};
}



// mod that doesn't suck for negative numbers
function mod(a, b) {
    return ((a % b) + b) % b;
}

function wraparound_diff(diff, rng) {
    rng = rng || 1.;
    return mod(diff + .5 * rng, rng) - .5 * rng;
}

function unwraparound(base, val, rng) {
    return base + wraparound_diff(val - base, rng);
}

function lon_norm(lon) {
    return mod(lon + 180., 360.) - 180.;
}

function prof(tag, func, ctx) {
    var start = window.performance.now();
    func.call(ctx);
    var end = window.performance.now();
    console.log(tag, (end - start).toFixed(3) + ' ms');
}

function npad(n, pad) {
    var s = '' + n;
    while (s.length < pad) {
        s = '0' + s;
    }
    return s;
}

function fmt_ll(k, dir, pad, prec) {
    return dir[k >= 0 ? 0 : 1] + npad(Math.abs(k).toFixed(prec), prec + 1 + pad) + '\xb0';
};

function fmt_pos(ll, prec) {
    return {
        lat: fmt_ll(ll[0], 'NS', 2, prec),
        lon: fmt_ll(ll[1], 'EW', 3, prec)
    };
}

function antipode(ll) {
    return [-ll[0], lon_norm(ll[1] + 180.)];
}

function prec_digits_for_res(delta) {
    return Math.max(-Math.round(Math.log(delta) / Math.LN10), 0);
}

ADD_COMMAS = new RegExp('\\B(?=(?:\\d{3})+(?!\\d))', 'g');
function format_with_unit(val, delta, unit) {
    // omg fuck javascript
    val /= UNITS[unit];
    if (delta != null) {
        delta /= UNITS[unit];
        var num = val.toFixed(prec_digits_for_res(delta));
    } else {
        var num = val.toPrecision(8);
        for (var i = num.length - 1; num[i] == '0'; i--);
        if (num[i] == '.') {
            i--;
        }
        num = num.substring(0, i + 1);
    }
    if (num.indexOf('.') != -1) {
        var fuck = num.split('.');
        num = fuck[0].replace(ADD_COMMAS, ',') + '.' + fuck[1];
    } else {
        num = num.replace(ADD_COMMAS, ',');
    }
    return num + ' ' + unit;
}

function niceRoundNumber(x, stops, orderOfMagnitude) {
    var orderOfMagnitude = orderOfMagnitude || 10;
    var stops = stops || [1, 2, 5];
    // numbers will snap to .1, .2, .5, 1, 2, 5, 10, 20, 50, 100, 200, etc.

    var xLog = Math.log(x) / Math.log(orderOfMagnitude);
    var exponent = Math.floor(xLog);
    var xNorm = Math.pow(orderOfMagnitude, xLog - exponent);

    var getStop = function(i) {
        return (i == stops.length ? orderOfMagnitude * stops[0] : stops[i]);
    }
    var cutoffs = $.map(stops, function(e, i) {
        var multiplier = getStop(i + 1);
        var cutoff = Math.sqrt(e * multiplier);
        if (cutoff >= orderOfMagnitude) {
            multiplier /= orderOfMagnitude;
            cutoff /= orderOfMagnitude;
        }
        return {cutoff: cutoff, mult: multiplier};
    });
    cutoffs = _.sortBy(cutoffs, function(co) { return co.cutoff; });

    var bucket = matchThresholds(xNorm, $.map(cutoffs, function(co) { return co.cutoff; }), true);
    var multiplier = (bucket == -1 ? cutoffs.slice(-1)[0].mult / orderOfMagnitude : cutoffs[bucket].mult);
    return Math.pow(orderOfMagnitude, exponent) * multiplier;
}

function matchThresholds(val, thresholds, returnIndex) {
    var cat = (returnIndex ? -1 : '-');
    $.each(thresholds, function(i, e) {
        if (e <= val) {
            cat = (returnIndex ? i : e);
        } else {
            return false;
        }
    });
    return cat;
}

UNITS = {
    'cm': 1e-2,
    'm': 1,
    'km': 1e3,
    'in': .0254,
    'ft': .3048,
    'mi': 1609.344,
};

function geomean(x, xu, y, yu) {
    return Math.sqrt(x * y * UNITS[xu] * UNITS[yu]);
}

function snap_scale(scale, target_size) {
    var target_len = scale * target_size;
    if (METRIC) {
        var len = niceRoundNumber(target_len);
        if (len < 1) {
            var unit = 'cm';
        } else if (len < 1000) {
            var unit = 'm';
        } else {
            var unit = 'km';
        }
    } else {
        if (target_len < UNITS.in) {
            var unit = 'in';
            var len = niceRoundNumber(target_len / UNITS[unit]);
        } else if (target_len < geomean(6, 'in', 1, 'ft')) {
            var unit = 'in';
            var len = niceRoundNumber(target_len / UNITS[unit], [1, 3, 6], 12);
        } else if (target_len < geomean(2000, 'ft', 1, 'mi')) {
            var unit = 'ft';
            var len = Math.min(niceRoundNumber(target_len / UNITS[unit]), 2000);
        } else {
            var unit = 'mi';
            var len = Math.max(niceRoundNumber(target_len / UNITS[unit]), 1);
        }
        len *= UNITS[unit];
    }
    return {label: format_with_unit(len, null, unit), size: len / scale};
}
