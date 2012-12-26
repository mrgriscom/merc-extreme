var _stats;
var vertex_shader;
var fragment_shader;

var MAX_ZOOM = 22; // max zoom level to attempt to fetch image tiles
// size of the texture index for a single zoom level; the maximum visible area
// at a single zoom level should never span more than half this number of tiles
var TEX_Z_IX_SIZE = 64;
var TEX_IX_SIZE = 512; // overall size of the texture index texture; should be >= sqrt(2 * MAX_ZOOM) * TEX_Z_IX_SIZE

function init() {
    vertex_shader = loadShader('vertex-default');
    fragment_shader = loadShader('fragment');

    var merc = new MercatorRenderer($('#container'), window.innerWidth, window.innerHeight, 2.5, 2.5);
    
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

    this.tex_z0;
    this.tex_atlas = [];
    this.tex_index;

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
        //debug overlay
        (function() {
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
        })();

        /*

          iterate through each tile
          does tile already exist in the texture cache?
          if not:
            create js image object with onload handler. if in cache, will 'load' immediately
            onload, find an available slot
            if no slot available, find an occupied slot whose tile is no longer needed (LRU). use this slot
            if no such slot, abort for now (future: add new texture buffer)
            load image into texture slot (todo: skirt) .. set tex needsupdate / gl texupdatesubimage

            set loc in lookup texture and update
            cell and z-level offset -- if range spills, copy over and update offset
            
         */

    }

    this.material = function() {

        var tex = this;

        //debug stuff
        var texes = [];
        for (var k = 0; k < 16; k++) {
            var texbuf = new TexBuffer(1024, {
                    generateMipmaps: false,
                    magFilter: THREE.LinearFilter,
                    minFilter: THREE.LinearFilter,
                });

            texes.push(texbuf);
        }
        var X0 = .3;
        var Y0 = .37;
        $.each(texes, function(k, tb) {
                var z = 2 + k;
                var x0 = Math.max(Math.floor(X0 * Math.pow(2., z)) - 1, 0);
                var y0 = Math.max(Math.floor(Y0 * Math.pow(2., z)) - 1, 0);
                tex_load_img(tex.tilefunc, tb, z, x0, y0);
            });
        ////


        this.uniforms = {
            scale: {type: 'f', value: this.context.scale_px},
            bias: {type: 'f', value: 1.},
            pole: {type: 'v2', value: null},
            pole_t: {type: 'v2', value: null},
            txtest: {type: 'tv', value: $.map(texes, function(e) { return e.tx; })}
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

        this.layer = new TextureLayer(this, tile_url('map'));

        this.plane = new THREE.Mesh(quad, this.layer._material);

        this.scene = new THREE.Scene();
        this.scene.add(this.plane);
    }

    this.render = function(timestamp) {
        this.setPole(41.63 +.05*timestamp, -72.59 + 0.02*timestamp);
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







function tex_load_img(urlfunc, texbuf, z, x0, y0) {
    var num = texbuf.size / 256;
    for (var y = 0; y < num; y++) {
        for (var x = 0; x < num; x++) {
            (function(x, y) {
                var img = new Image();
                img.onload = function() {
                    texbuf.update(function(ctx, w, h) {
                            ctx.drawImage(img, 256 * x, 256 * y);
                        });
                };
                img.crossOrigin = 'anonymous';
                img.src = urlfunc(z, x0 + x, y0 + y);
            })(x, y);
        }
    }
}

//=== TILE SERVICES ===

function tile_url(type) {
    return {
        map: function(z, x, y) { return 'https://mts' + ((x + y) % 4) + '.google.com/vt/lyrs=m&x=' + x + '&y=' + y + '&z=' + z; },
        sat: function(z, x, y) { return 'https://khms' + ((x + y) % 4) + '.google.com/kh/v=123&x=' + x + '&y=' + y + '&z=' + z; },
    }[type];
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
