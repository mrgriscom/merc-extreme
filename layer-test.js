
function tile_coord() {
    var params = new URLSearchParams(window.location.search);
    var defaults = {z: 2, x: 0, y: 1};
    var z = params.get('z') || defaults.z;
    defaults.x = Math.min(defaults.x, Math.pow(2, z) - 1);
    defaults.y = Math.min(defaults.y, Math.pow(2, z) - 1);
    var x = params.get('x') || defaults.x;
    var y = params.get('y') || defaults.y;
    return {z: z, x: x, y: y};
}

function test_tile(lyr, coord, specialcase) {
    var img = new Image();
    img.width = TILE_SIZE;
    img.height = TILE_SIZE;
    img.crossOrigin = 'anonymous';
        
    img.src = lyr.tilefunc()(coord.z, coord.x, coord.y);

    if (specialcase != null) {
        var $container = $('#specialcase');
        var zstr = specialcase + ' ' + coord.z + '-' + coord.x + '-' + coord.y;
    } else {
        var $container = $('#general');
        var zstr = (lyr.max_depth() != null ? 'z:' + lyr.min_depth() + '&ndash;' + lyr.max_depth() :
                    lyr.min_depth() > 0 ? 'z:' + lyr.min_depth() + '+' : '');
    }
    
    $title = $('<div>');
    $title.html(lyr.key() + ' ' + zstr);
    $(img).css('background', lyr.bg);
    $container.append($title);
    $container.append(img);
}

function layer_test() {
    var tile = tile_coord();
    var layers = {};
    _.each(load_tile_specs(), function(spec) {
        var lyr = new LayerModel(spec);
        layers[lyr.key()] = lyr;
        test_tile(lyr, tile);
    });
    test_tile(layers['google:sat'], {z: 23, x:4965358, y: 4264294}, 'deepzoom');
}
