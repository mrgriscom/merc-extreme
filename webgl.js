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

    var angularSpeed = 0.2; // revolutions per second
    var lastTime = 0;
    
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
    var plane = new THREE.Mesh(new THREE.PlaneGeometry(1024, 1024), material); /*new THREE.MeshBasicMaterial({
                map: tx
                }));*/
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