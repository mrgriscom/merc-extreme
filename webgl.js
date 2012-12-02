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
    return 'https://mts1.google.com/vt/lyrs=m&x=' + x + '&y=' + y + '&z=' + z;
    //return 'https://khms1.google.com/kh/v=121&x=' + x + '&y=' + y + '&z=' + z;
}

function init() {
    var IMG = tile_url(77, 94, 8);

    var $tx = $('<canvas />');
    $tx.attr('width', 1024);
    $tx.attr('height', 1024);
    $tx = $tx[0];
    var ctx = $tx.getContext('2d');
    ctx.fillStyle = 'blue';
    ctx.fillRect(0, 0, 1024, 1024);

    var renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    
    // camera
    var camera = new THREE.OrthographicCamera(window.innerWidth / -2, window.innerWidth / 2, window.innerHeight / 2, window.innerHeight / -2, -1, 1);
    
    var tx = new THREE.Texture($tx);
    tx.needsUpdate = true;
    var vertShader = document.getElementById('vertexShader').innerHTML;
    var fragShader = document.getElementById('fragmentShader').innerHTML;
    var uniforms = {
        texture1: { type: "t", value: tx }
    };
    var material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertShader,
            fragmentShader: fragShader
    });

    // scene
    var scene = new THREE.Scene();
    
    // plane
    var plane = new THREE.Mesh(new THREE.PlaneGeometry(1024, 1024), material);
    scene.add(plane);

    var i = -1;
    for (var y = 0; y < 4; y++) {
        for (var x = 0; x < 4; x++) {
            (function(x, y) {
                var e = [x, y];
                i++;

                setTimeout(function() {
                        var img = new Image();
                        img.onload = function() {
                            ctx.drawImage(img, 256 * e[0], 256 * e[1]);
                            tx.needsUpdate = true;
                        };
                        img.crossOrigin = 'anonymous';
                        img.src = tile_url(74 + e[0], 92 + e[1], 8);
                    }, (i + 1) * 100);
            })(x, y);
        }
    }

    // create wrapper object that contains three.js objects
    var three = {
        renderer: renderer,
        camera: camera,
        scene: scene,
        plane: plane
    };
    
    var render = function(timestamp) {
        //console.log(timestamp);
        plane.position.x = timestamp * .3;
        plane.rotation.z = timestamp * .05;
        three.renderer.render(three.scene, three.camera);
    }

    launch(render);
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

function init2() {
    var W_PX = window.innerWidth;
    var H_PX = window.innerHeight;
    var ASPECT = W_PX / H_PX;

    var MERC_EXTENT_N = 2.5;
    var MERC_EXTENT_S = 0.5;
    var LON_OFFSET = 0;

    var MERC_EXTENT = MERC_EXTENT_S + MERC_EXTENT_N;
    var LON_EXTENT = MERC_EXTENT / ASPECT;
    var PX_SCALE = W_PX / MERC_EXTENT;

    var renderer = new THREE.WebGLRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    
    var camera = new THREE.OrthographicCamera(0, W_PX, H_PX, 0, -1, 1);
    console.log('w ' + W_PX + ' h ' + H_PX + ' aspect ' + ASPECT);

    var vertShader = document.getElementById('vertexShader').innerHTML;
    var fragShader = document.getElementById('fragmentShader').innerHTML;
    var uniforms = {
        scale: {type: 'f', value: PX_SCALE},
        bias: {type: 'f', value: 1.},
        pole: {type: 'v2', value: new THREE.Vector2(45, 45)}
    };
    var material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: vertShader,
            fragmentShader: fragShader
    });

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
    
    var render = function(timestamp) {
        uniforms.pole.value = new THREE.Vector2(-72.59, 41.63 + 3.*timestamp);
        three.renderer.render(three.scene, three.camera);
    }

    launch(render);


}