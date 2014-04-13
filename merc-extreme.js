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

// size of the texture index for a single zoom level; the maximum visible area
// at a single zoom level should never span more than half this number of tiles
// TODO change to the half-version instead
// rough guidelines for half value: max diagonal screen res / TILE_SIZE * 2
var TEX_Z_IX_SIZE = 64;
// TODO autocompute
var TEX_IX_SIZE = 512; // overall size of the texture index texture; should be >= sqrt(2 * MAX_ZOOM) * TEX_Z_IX_SIZE

/* if this is too low, there is a chance that visible tiles will be missed and
   not loaded. how low you can get away with closely relates to how much buffer
   zone is set in the tile cache
*/
var SAMPLE_FREQ = 1/4.;
var ATLAS_TEX_SIZE = 4096;
var SAMPLE_TIME_FREQ = 1.;


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
function ll_to_xy(lat, lon) {
    var x = lon / 360. + .5;
    var rlat = lat * Math.PI / 180.;
    var merc_y = Math.log(Math.tan(.5 * rlat + .25 * Math.PI));
    var y = .5 - merc_y / (2. * Math.PI);
    return {x: x, y: y};
}

/* xy is x:0,1 == -180,180, y:equator=0 */
function xy_to_ll(x, y) {
    var lon = (x - .5) * 360.;
    var merc_y = 2. * Math.PI * y;
    var rlat = 2. * Math.atan(Math.exp(merc_y)) - .5 * Math.PI;
    var lat = rlat * 180. / Math.PI;
    return [lat, lon];
}

function ll_to_xyz(lat, lon) {
    var rlat = lat * Math.PI / 180.;
    var rlon = lon * Math.PI / 180.;
    return [Math.cos(rlon) * Math.cos(rlat), Math.sin(rlon) * Math.cos(rlat), Math.sin(rlat)];
}

function xyz_to_ll(x, y, z) {
    var rlon = Math.atan2(y, x);
    var rlat = Math.atan2(z, Math.sqrt(x*x + y*y));
    return [rlat * 180. / Math.PI, rlon * 180. / Math.PI];
}

function translate_pole(pos, pole) {
    var xyz = ll_to_xyz(pos[0], pos[1]);
    var pole_rlat = pole[0] * Math.PI / 180.;
    
    var latrot = pole_rlat - .5 * Math.PI;
    var xyz_trans = new THREE.Matrix4().makeRotationY(-latrot).multiplyVector3(new THREE.Vector3(xyz[0], xyz[1], xyz[2]));
    var pos_trans = xyz_to_ll(xyz_trans.x, xyz_trans.y, xyz_trans.z);
    pos_trans[1] += pole[1];
    return pos_trans;
}


QuadGeometry = function(x0, y0, width, height) {
	THREE.Geometry.call(this);
    var g = this;
    
    this.x0 = x0;
    this.y0 = y0;
    this.width = width;
    this.height = height;
    this.x1 = x0 + width;
    this.y1 = y0 + height;

    $.each([g.y0, g.y1], function(i, y) {
        $.each([g.x0, g.x1], function(j, x) {
            g.vertices.push(new THREE.Vector3(x, y, 0));
        });
    });
    var face = new THREE.Face4(0, 1, 3, 2);
    
	var normal = new THREE.Vector3(0, 0, 1);
    face.normal.copy(normal);
    var UVs = [];
    $.each(['a', 'b', 'c', 'd'], function(i, e) {
        var v = g.vertices[face[e]];
        UVs.push(new THREE.UV(v.x, v.y));
        face.vertexNormals.push(normal.clone());        
    });
    this.faceVertexUvs[0].push(UVs);
    
    this.faces.push(face);
	this.computeCentroids();
};
QuadGeometry.prototype = Object.create(THREE.Geometry.prototype);

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

    //debug
    //document.body.appendChild(this.tex_atlas[0].$tx);
    //document.body.appendChild(this.tex_index.$tx);
    
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
            //if (tile.z > 16) {
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
        
        /* TODO
           image skirts
           z-level offset
           sideways/fringe offset
           index spillover and offset
        */
        
        /*
          set loc in lookup texture and update
        */
        
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
            ctx.fillStyle = '#ccc';
            ctx.fillRect(0, 0, w, h);
            
            ctx.drawImage(img, 0, .25 * h);
        });
    }
    
    this.material = function() {
        
        var tex = this;
        
        this.uniforms = {
            scale: {type: 'f', value: this.context.scale_px},
            bias: {type: 'f', value: 0.},
            pole: {type: 'v2', value: null},
            pole_t: {type: 'v2', value: null},
            ref_t: {type: 'v2', value: null},
            tx_ix: {type: 't', value: this.tex_index.tx},
            tx_atlas: {type: 'tv', value: $.map(this.tex_atlas, function(e) { return e.tx; })},
            tx_z0: {type: 't', value: this.tex_z0.tx},
        };
        return new THREE.ShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: configureShader(vertex_shader),
            fragmentShader: configureShader(fragment_shader, {MODE_TEX: null})
        });
        
    }
    
    this.sampler_material = function() {
        return new THREE.ShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: configureShader(vertex_shader),
            fragmentShader: configureShader(fragment_shader, {MODE_TILE: null})
        });
    }
    
    this.init();
    this._material = this.material();
    this._sampler_material = this.sampler_material();
    
    
    
    
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

        var quad = new QuadGeometry(-1000, -1000, 2000, 2000); //this.lonOffset, -this.mercExtentS, this.lonExtent, this.mercExtent);
	/*
        quad.applyMatrix(new THREE.Matrix4().makeTranslation(-this.lonExtent, this.mercExtentS, 0));
        quad.applyMatrix(new THREE.Matrix4().makeRotationZ(-0.5 * Math.PI));
        quad.applyMatrix(new THREE.Matrix4().makeScale(this.scale_px, this.scale_px, 1));
        */
        this.quad = quad;

	    var M = new THREE.Matrix4();
	    M.multiplySelf(new THREE.Matrix4().makeScale(this.scale_px, this.scale_px, 1));
	    M.multiplySelf(new THREE.Matrix4().makeRotationZ(-0.5 * Math.PI));
	    M.multiplySelf(new THREE.Matrix4().makeTranslation(-this.lonExtent, this.mercExtentS, 0));
        this.setWorldMatrix(M);
        
	    this.layer = new TextureLayer(this, tile_url('map'));
        
        this.plane = new THREE.Mesh(this.quad, this.layer._material);
        
        this.scene = new THREE.Scene();
        this.scene.add(this.plane);
        
	    this.curPole = [-41.63, -72.59 + 180.];
	    //this.curPole = [42.4, -71.1];
	    //this.curPole = [-34.0,18.4];
    }

    this.setWorldMatrix = function(M) {
        // this currently UPDATES the matrix
        this.M = this.M || new THREE.Matrix4();
        this.quad.applyMatrix(M);
        this.quad.verticesNeedUpdate = true;

        // this is a mess
        M.multiplySelf(this.M);
        this.M = M;
	    this.toWorld = new THREE.Matrix4().getInverse(this.M);
    }

    this.xyToWorld = function(x, y) {
        return this.toWorld.multiplyVector3(new THREE.Vector3(x, y, 0));
    }

    this.zoom = function(x, y, z) {
        y = $(this.renderer.domElement).height() - y - 1; // ugly
	    var M = new THREE.Matrix4();
        M.multiplySelf(new THREE.Matrix4().makeTranslation(x, y, 0));
        M.multiplySelf(new THREE.Matrix4().makeScale(z, z, 1));
        M.multiplySelf(new THREE.Matrix4().makeTranslation(-x, -y, 0));
        this.setWorldMatrix(M);
        this.layer.uniforms.scale.value *= z;
        console.log(this.layer.uniforms.scale.value);
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
    
    this.render = function(timestamp) {
	    this.setPole(this.curPole[0], this.curPole[1]);
        //this.layer.uniforms.bias.value = 0.5 + 1.5*Math.cos(timestamp);
        this.renderer.render(this.scene, this.camera);
        
        if (this.last_sampling == null || timestamp - this.last_sampling > SAMPLE_TIME_FREQ) {
            this.setRefPoint();
            this.plane.material = this.layer._sampler_material;
            this.layer.sample_coverage();
            this.plane.material = this.layer._material;
            this.last_sampling = timestamp;
        }
        
        _stats.update();
    }
    
    this.setPole = function(lat, lon) {
        this.pole = [lat, lon];
        this.pole_t = ll_to_xy(lat, lon);
        this.layer.uniforms.pole.value = new THREE.Vector2(lon, lat);
        this.layer.uniforms.pole_t.value = new THREE.Vector2(this.pole_t.x, this.pole_t.y);
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
        sat: 'https://khms{s:0-3}.google.com/kh/v=131&x={x}&y={y}&z={z}',
        terr: 'https://mts{s:0-3}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
        osm: 'http://{s:abc}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        trans: 'http://mts{s:0-3}.google.com/vt/lyrs=m@230051588,transit:comp%7Cvm:1&hl=en&src=app&opts=r&x={x}&y={y}&z={z}',
        mb: 'https://api.tiles.mapbox.com/v3/examples.map-51f69fea/{z}/{x}/{y}.jpg',
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
    return content;
}

function configureShader(code, params) {
    var param_to_predicate = function(varname, value) {
        return '#define ' + varname + (value != null ? ' ' + value : '');
    };
    var predicates = $.map(params || {}, function(v, k) {
        return param_to_predicate(k, v);
    });
    predicates.push('');
    predicates.push(code);
    return predicates.join('\n');
}

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
    replace('custom', function(arg) {
            // note: this blocks the browser due to need for synchronous request to server
            var url = null;
            $.ajax('/tileurl/' + arg + '/' + zoom + '/' + point.x + ',' + point.y, {
                    success: function(data) {
                        url = data;
                    },
                    async: false
                });
            return url;
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
