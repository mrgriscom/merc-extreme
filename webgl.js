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
 
function tile_url(x, y, z) {
    //return 'https://mts1.google.com/vt/lyrs=m&x=' + x + '&y=' + y + '&z=' + z;
    return 'https://khms1.google.com/kh/v=121&x=' + x + '&y=' + y + '&z=' + z;
}

function launch(render) {
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

function loadShader(name) {
    return $('#' + name).text();
}

function init2() {

    var w = new Worker('worker.js');
    w.addEventListener('message', function(e) {
            console.log('worker result', e.data);
        }, false);

    var W_PX = window.innerWidth;
    var H_PX = window.innerHeight;
    var ASPECT = W_PX / H_PX;

    var SAMPLE_FREQ = 1/4.;
    var SW_PX = Math.round(W_PX * SAMPLE_FREQ);
    var SH_PX = Math.round(H_PX * SAMPLE_FREQ);

    var MERC_EXTENT_N = 2.5;
    var MERC_EXTENT_S = 2.5;
    var LON_OFFSET = 0;

    var MERC_EXTENT = MERC_EXTENT_S + MERC_EXTENT_N;
    var LON_EXTENT = 1; //MERC_EXTENT / ASPECT;
    var PX_SCALE = W_PX / MERC_EXTENT;

    var renderer = new THREE.WebGLRenderer();
    var ctx = renderer.context;
    console.log('max size', ctx.getParameter(ctx.MAX_TEXTURE_SIZE));
    console.log('max #', ctx.getParameter(ctx.MAX_TEXTURE_IMAGE_UNITS));
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    var target = new THREE.WebGLRenderTarget(SW_PX, SH_PX);

    stats = new Stats();
    stats.domElement.style.position = 'absolute';
    stats.domElement.style.top = '0px';
    document.body.appendChild( stats.domElement );

    
    var texes = [];
    for (var k = 0; k < 16; k++) {
        var tx = mk_tex_test(1024);
        tx.tx.ctx = tx.ctx;
        texes.push(tx.tx);
    }
    var X0 = .3;
    var Y0 = .37;
    $.each(texes, function(k, tx) {
            var z = 2 + k;
            var x0 = Math.max(Math.floor(X0 * Math.pow(2., z)) - 1, 0);
            var y0 = Math.max(Math.floor(Y0 * Math.pow(2., z)) - 1, 0);
            tex_load_img(tx, tx.ctx, 1024, z, x0, y0);
            tx.needsUpdate = true;
        });

    var camera = new THREE.OrthographicCamera(0, W_PX, H_PX, 0, -1, 1);
    console.log('w ' + W_PX + ' h ' + H_PX + ' aspect ' + ASPECT);

    var vertShader = loadShader('vertexShader');
    var fragShader = loadShader('fragmentShader');
    var uniforms = {
        scale: {type: 'f', value: PX_SCALE},
        bias: {type: 'f', value: 1.},
        pole: {type: 'v2', value: null},
        pole_t: {type: 'v2', value: null},
        txtest: {type: 'tv', value: texes}
    };
    var material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertShader,
            fragmentShader: fragShader
    });

    var setPole = function(lat, lon) {
        var t = ll_to_xy(lat, lon);
        uniforms.pole.value = new THREE.Vector2(lon, lat);
        uniforms.pole_t.value = new THREE.Vector2(t.x, t.y);
    };

    var quad = new QuadGeometry(LON_OFFSET, -MERC_EXTENT_S, LON_EXTENT, MERC_EXTENT);
    
    quad.applyMatrix(new THREE.Matrix4().makeTranslation(-LON_EXTENT, MERC_EXTENT_S, 0));
    quad.applyMatrix(new THREE.Matrix4().makeRotationZ(-0.5 * Math.PI));
    quad.applyMatrix(new THREE.Matrix4().makeScale(PX_SCALE, PX_SCALE, 1));

    var plane = new THREE.Mesh(quad, material);

    var scene = new THREE.Scene();
    scene.add(plane);

    // create wrapper object that contains three.js objects
    var three = {
        renderer: renderer,
        camera: camera,
        scene: scene,
        plane: plane
    };
    
    var buff = new Uint8Array(SW_PX * SH_PX * 4);

    var last = null;

    var render = function(timestamp) {
        setPole(41.63 +.005*timestamp, -72.59);
        three.renderer.render(three.scene, three.camera);

        if (last == null || timestamp - last > 0.1) {
            three.renderer.render(three.scene, three.camera, target);
            var gl = three.renderer.getContext();
            gl.readPixels(0, 0, SW_PX, SH_PX, gl.RGBA, gl.UNSIGNED_BYTE, buff);
            
            w.postMessage(buff);

            last = timestamp;
            console.log(timestamp);
        }

        stats.update();
    }

    launch(render);


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

function tex_load_img(tx, ctx, size, z, x0, y0) {
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
                img.src = tile_url(x0 + x, y0 + y, z);
            })(x, y);
        }
    }
}

