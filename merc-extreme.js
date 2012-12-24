var _stats;
var vertex_shader;
var fragment_shader;

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

function TextureLayer(context, tilefunc) {

    this.context = context;
    this.tilefunc = tilefunc;

    var SAMPLE_FREQ = 1/4.;
    var SW_PX = Math.round(this.context.width_px * SAMPLE_FREQ);
    var SH_PX = Math.round(this.context.height_px * SAMPLE_FREQ);
    this.target = new THREE.WebGLRenderTarget(SW_PX, SH_PX);

    this.worker = new Worker('coverage-worker.js');
    this.sampleBuff = new Uint8Array(SW_PX * SH_PX * 4);

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
        this.context.renderer.render(this.context.scene, this.context.camera, this.target);
        this.context.glContext.readPixels(0, 0, SW_PX, SH_PX, gl.RGBA, gl.UNSIGNED_BYTE, this.sampleBuff);            
        this.worker.postMessage(this.sampleBuff);

        last = timestamp;
        console.log(timestamp);
    }

    this.sample_coverage_postprocess = function(data) {
        console.log('worker result', data);
        var canvas = $('#tileovl')[0];
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        $.each(data, function(k, v) {
                var pcs = k.split(':');
                var z = +pcs[0];
                var anti = z >= 64;
                z = z % 64;
                
                var dx = +pcs[1] - 128;
                var dy = +pcs[2] - 128;
                
                ctx.fillStyle = 'white';
                ctx.fillRect(32 * (z + .5) + dx, 32 * ((anti ? 1 : 0) + .5) + dy, 1, 1);
            });
    }

    this.material = function() {

        var tex = this;

        //debug stuff
        var texes = [];
        for (var k = 0; k < 16; k++) {
            var tx = mk_tex_test(1024);
            tx.tx.ctx = tx.ctx;

            tx.tx.generateMipmaps = false;
            tx.tx.magFilter = THREE.LinearFilter;
            tx.tx.minFilter = THREE.LinearFilter;

            texes.push(tx.tx);
        }
        var X0 = .3;
        var Y0 = .37;
        $.each(texes, function(k, tx) {
                var z = 2 + k;
                var x0 = Math.max(Math.floor(X0 * Math.pow(2., z)) - 1, 0);
                var y0 = Math.max(Math.floor(Y0 * Math.pow(2., z)) - 1, 0);
                tex_load_img(tex.tilefunc, tx, tx.ctx, 1024, z, x0, y0);
                tx.needsUpdate = true;
            });
        ////


        this.uniforms = {
            scale: {type: 'f', value: this.context.scale_px},
            bias: {type: 'f', value: 1.},
            pole: {type: 'v2', value: null},
            pole_t: {type: 'v2', value: null},
            txtest: {type: 'tv', value: texes}
        };
        return new THREE.ShaderMaterial({
                uniforms: this.uniforms,
                vertexShader: configureShader(vertex_shader),
                fragmentShader: configureShader(fragment_shader, {MODE_TEX: null})
            });

    }

    this.init();
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

        var plane = new THREE.Mesh(quad, this.layer.material());

        this.scene = new THREE.Scene();
        this.scene.add(plane);
    }

    var last = null;
    this.render = function(timestamp) {
        this.setPole(41.63 +.05*timestamp, -72.59 + 0.02*timestamp);
        this.renderer.render(this.scene, this.camera);

        /*
        if (last == null || timestamp - last > 0.1) {
            three.renderer.render(three.scene, three.camera, target);
            var gl = three.renderer.getContext();
            gl.readPixels(0, 0, SW_PX, SH_PX, gl.RGBA, gl.UNSIGNED_BYTE, buff);
            
            w.postMessage(buff);

            last = timestamp;
            console.log(timestamp);
        }
        */

        _stats.update();
    }

    this.setPole = function(lat, lon) {
        var t = ll_to_xy(lat, lon);
        this.layer.uniforms.pole.value = new THREE.Vector2(lon, lat);
        this.layer.uniforms.pole_t.value = new THREE.Vector2(t.x, t.y);
    };



    this.start = function() {
        var merc = this;
        renderLoop(function(t) { merc.render(t); });
    }

    this.init();
}







function mk_tex_test(size) {
    var $tx = $('<canvas />');
    $tx.attr('width', size);
    $tx.attr('height', size);
    $tx = $tx[0];
    var ctx = $tx.getContext('2d');
    ctx.fillStyle = 'blue';
    ctx.fillRect(0, 0, size, size);

    var tx = new THREE.Texture($tx);
    tx.needsUpdate = true;
    return {tx: tx, ctx: ctx};
}

function tex_load_img(urlfunc, tx, ctx, size, z, x0, y0) {
    var num = size / 256;
    for (var y = 0; y < num; y++) {
        for (var x = 0; x < num; x++) {
            (function(x, y) {
                var img = new Image();
                img.onload = function() {
                    ctx.drawImage(img, 256 * x, 256 * y);
                    tx.needsUpdate = true;
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
        map: function(z, x, y) { return 'https://mts1.google.com/vt/lyrs=m&x=' + x + '&y=' + y + '&z=' + z; },
        sat: function(z, x, y) { return 'https://khms1.google.com/kh/v=123&x=' + x + '&y=' + y + '&z=' + z; },
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
