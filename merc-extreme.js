var _stats;
var vertex_shader;
var fragment_shader;

var MAX_ZOOM = 22; // max zoom level to attempt to fetch image tiles
// size of the texture index for a single zoom level; the maximum visible area
// at a single zoom level should never span more than half this number of tiles
var TEX_Z_IX_SIZE = 64;
var TEX_IX_SIZE = 512; // overall size of the texture index texture; should be >= sqrt(2 * MAX_ZOOM) * TEX_Z_IX_SIZE
var TILE_SIZE = 256;

function init() {
    vertex_shader = loadShader('vertex-default');
    fragment_shader = loadShader('fragment');

    var merc = new MercatorRenderer($('#container'), window.innerWidth, window.innerHeight, 2.5, 0.5);
    
    _stats = new Stats();
    _stats.domElement.style.position = 'absolute';
    _stats.domElement.style.top = '0px';
    document.body.appendChild(_stats.domElement);

    merc.start();

}



 


function ll_to_xy(lat, lon) {
    var x = lon / 360. + .5;
    var rlat = lat * Math.PI / 180.;
    var merc_y = Math.log(Math.tan(.5 * rlat + .25 * Math.PI));
    var y = .5 - merc_y / (2. * Math.PI);
    return {x: x, y: y};
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

function TexBuffer(size, texopts) {
    this.size = size;

    var $tx = $('<canvas />');
    $tx.attr('width', size);
    $tx.attr('height', size);
    this.$tx = $tx[0];

    this.ctx = this.$tx.getContext('2d');

    this.tx = new THREE.Texture(this.$tx);
    var texbuf = this;
    $.each(texopts || {}, function(k, v) {
            texbuf.tx[k] = v;
        });
    this.tx.needsUpdate = true;

    this.update = function(draw) {
        draw(this.ctx, this.size, this.size);
        this.tx.needsUpdate = true;
    }
}

function TextureLayer(context, tilefunc) {

    this.context = context;
    this.tilefunc = tilefunc;

    /* if this is too low, there is a chance that visible tiles will be missed and
       not loaded. how low you can get away with closely relates to how much buffer
       zone is set in the tile cache
    */
    var SAMPLE_FREQ = 1/4.;
    this.sample_width = Math.round(this.context.width_px * SAMPLE_FREQ);
    this.sample_height = Math.round(this.context.height_px * SAMPLE_FREQ);
    this.target = new THREE.WebGLRenderTarget(this.sample_width, this.sample_height, {format: THREE.RGBFormat});
    this.target.generateMipmaps = false;

    this.worker = new Worker('coverage-worker.js');

    var ATLAS_TEX_SIZE = 4096;
    this.tex_z0;
    this.tex_atlas = [new TexBuffer(ATLAS_TEX_SIZE, {
                // want to mipmap, but it causes creases
                generateMipmaps: false,
                magFilter: THREE.LinearFilter,
                minFilter: THREE.LinearFilter,
            })];
    this.tex_index = new TexBuffer(TEX_IX_SIZE, {
            generateMipmaps: false,
            magFilter: THREE.NearestFilter,
            minFilter: THREE.NearestFilter,
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
        this.worker.postMessage(this.context.pole_t);
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
                    // TODO shift existing index pixels
                    layer.index_offsets[k] = {x: xoffset, y: yoffset};
                    layer.set_offset(k, xoffset, yoffset);
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
                if (tile.z > 15) {
                    return;
                }

                if (layer.tile_index[tilekey(tile)] != null) {
                    return;
                }

                layer.tile_index[tilekey(tile)] = {status: 'loading'};
                load_image(layer.tilefunc(tile.z, tile.x, tile.y), function(img) {
                        var ix_entry = layer.tile_index[tilekey(tile)];
                        ix_entry.status = 'loaded';

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
                            var oldest_key = null;
                            var oldest = null;
                            $.each(layer.tile_index, function(k, v) {
                                    if (v.status != 'loaded') {
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
                            // remove from index texture too
                        }

                        console.log('loading', tilekey(tile));
                        layer.tex_atlas[slot.tex].update(function(ctx, w, h) {
                                ctx.drawImage(img, TILE_SIZE * slot.x, TILE_SIZE * slot.y);
                            });
                        ix_entry.slot = slot;
                        layer.slot_index[slot.tex + ':' + slot.x + ':' + slot.y] = true;

                        layer.set_tile_ix(tile, slot);
                        //hack -- need to handle that same tile may be indexed from both hemispheres
                        if (tile.z <= 1) {
                            layer.set_tile_ix({anti: !tile.anti, z: tile.z, x: tile.x, y: tile.y}, slot);
                        }
                        ix_entry.mru = MRU_counter;
                    });
            });

        /* TODO
          image skirts
          z-level offset
          sideways/fringe offset
          index spillover and offset
          update sub-image only
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
                ctx.putImageData(buf, px, h - 1 - py);

                buf.data[0] = Math.floor(yo / 256.);
                buf.data[1] = yo % 256;
                buf.data[2] = 0;
                buf.data[3] = 255;
                ctx.putImageData(buf, px, h - 1 - (py - 1));
            });
    }

    this.set_tile_ix = function(tile, slot) {
        var zx = tile.z % (TEX_IX_SIZE / TEX_Z_IX_SIZE);
        var zy = Math.floor(tile.z / (TEX_IX_SIZE / TEX_Z_IX_SIZE)) + (tile.anti ? .5 : 0) * (TEX_IX_SIZE / TEX_Z_IX_SIZE);

        var offsets = this.index_offsets[(tile.anti ? 1 : 0) + ':' + tile.z];
        var px = zx * TEX_Z_IX_SIZE + tile.x - TEX_Z_IX_SIZE / 2 * offsets.x;
        var py = zy * TEX_Z_IX_SIZE + tile.y - TEX_Z_IX_SIZE / 2 * offsets.y;

        this.tex_index.update(function(ctx, w, h) {
                var buf = ctx.createImageData(1, 1);
                buf.data[0] = slot.tex;
                buf.data[1] = slot.x;
                buf.data[2] = slot.y;
                buf.data[3] = 255;
                ctx.putImageData(buf, px, h - 1 - py);
            });
    }

    this.material = function() {

        var tex = this;

        this.uniforms = {
            scale: {type: 'f', value: this.context.scale_px},
            bias: {type: 'f', value: 0.}, //1.
            pole: {type: 'v2', value: null},
            pole_t: {type: 'v2', value: null},
            tx_ix: {type: 't', value: this.tex_index.tx},
            tx_atlas: {type: 'tv', value: $.map(this.tex_atlas, function(e) { return e.tx; })},
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
        console.log('worker result', data);
        var canvas = $('#tileovl')[0];
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        for (var i = 0; i < 30; i++) {
            for (var j = 0; j < 2; j++) {
                ctx.fillStyle = ((i + j) % 2 == 0 ? '#200' : '#002');
                ctx.fillRect(32 * i, 32 * j, 32, 32);
            }
        }
        
        var count = 0;
        $.each(data, function(k, v) {
                var pcs = k.split(':');
                var anti = +pcs[0];
                var z = +pcs[1];
                var dx = pcs[2] % 32;
                var dy = pcs[3] % 32;
                
                ctx.fillStyle = 'white';
                ctx.fillRect(32 * z + dx, 32 * ((anti ? 1 : 0)) + dy, 1, 1);
                
                count++;
            });
        console.log(count);
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


    this.init = function() {
        console.log('width', this.width_px, 'height', this.height_px, 'aspect', this.aspect);
        console.log('max tex size', this.glContext.getParameter(this.glContext.MAX_TEXTURE_SIZE));
        console.log('max # texs', this.glContext.getParameter(this.glContext.MAX_TEXTURE_IMAGE_UNITS));
        // TODO query precision bits

        this.renderer.setSize(this.width_px, this.height_px);
        // TODO handle window/viewport resizing
        $container.append(this.renderer.domElement);

        this.camera = new THREE.OrthographicCamera(0, this.width_px, this.height_px, 0, -1, 1);

        var quad = new QuadGeometry(this.lonOffset, -this.mercExtentS, this.lonExtent, this.mercExtent);
        quad.applyMatrix(new THREE.Matrix4().makeTranslation(-this.lonExtent, this.mercExtentS, 0));
        quad.applyMatrix(new THREE.Matrix4().makeRotationZ(-0.5 * Math.PI));
        quad.applyMatrix(new THREE.Matrix4().makeScale(this.scale_px, this.scale_px, 1));

        this.layer = new TextureLayer(this, tile_url('sat'));

        this.plane = new THREE.Mesh(quad, this.layer._material);

        this.scene = new THREE.Scene();
        this.scene.add(this.plane);
    }

    this.render = function(timestamp) {
        //var pos = [41.63, -72.59];
        //var pos = [-33.92, 18.42];
        var pos = [38.93, -74.91];
        this.setPole(pos[0] + .04 * Math.cos(.2*timestamp), pos[1] + .04 / .7 * Math.sin(.2*timestamp));
        //this.layer.uniforms.bias.value = 0.5 + 1.5*Math.cos(timestamp);
        this.renderer.render(this.scene, this.camera);

        var sample_freq = 0.1;
        if (this.last_sampling == null || timestamp - this.last_sampling > sample_freq) {
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
        sat: 'https://khms{s:0-3}.google.com/kh/v=123&x={x}&y={y}&z={z}',
        terr: 'https://mts{s:0-3}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
        osm: 'http://{s:abc}.tile.openstreetmap.org/{z}/{x}/{y}.png',
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
