
function tile_coord() {
    var params = new URLSearchParams(window.location.search);
    var defaults = {z: 2, x: 0, y: 1};
    var z = params.get('z') || defaults.z;
    defaults.x = Math.min(defaults.x, Math.pow(2, z) - 1);
    defaults.y = Math.min(defaults.y, Math.pow(2, z) - 1);
    var x = params.get('x') || defaults.x;
    var y = params.get('y') || defaults.y;
    return {z: +z, x: +x, y: +y};
}

function zoom_in(coord, dx, dy) {
    coord.z += 1;
    coord.x = 2*coord.x + dx;
    coord.y = 2*coord.y + dy;
    set_coord(coord);
}

function zoom_out(coord) {
    if (coord.z > 0) {
        coord.z -= 1;
        coord.x = Math.floor(coord.x / 2);
        coord.y = Math.floor(coord.y / 2);
        set_coord(coord);
    }
}

function set_coord(coord, no_reload) {
    var query = new URLSearchParams(coord).toString();
    if (no_reload) {
        history.replaceState(null, null, window.location.pathname + '?' + query);
    } else {
        window.location.search = query;
    }
}

function test_tile(lyr, coord, specialcase) {
    var img = new Image();
    img.width = TILE_SIZE;
    img.height = TILE_SIZE;
    img.crossOrigin = 'anonymous';
        
    img.src = lyr.tilefunc()(coord.z, coord.x, coord.y);

    if (specialcase != null) {
        var $container = $('#specialcase');
        var zstr = specialcase; // + ' ' + coord.z + '-' + coord.x + '-' + coord.y;
    } else {
        var $container = $('#general');
        var zstr = (lyr.max_depth() != null ? 'z:' + lyr.min_depth() + '&ndash;' + lyr.max_depth() :
                    lyr.min_depth() > 0 ? 'z:' + lyr.min_depth() + '+' : '');

        $(img).css('cursor', 'pointer');
        $(img).click(function(e) {
            zoom_in(coord,
                    Math.floor((e.pageX - this.offsetLeft) / (TILE_SIZE / 2)),
                    Math.floor((e.pageY - this.offsetTop) / (TILE_SIZE / 2))
                   );
        });
        $(img).bind('contextmenu', function(e) {
            zoom_out(coord);
            return false;
        });
    }

    $test = $('<div class="patch">');
    $title = $('<div>');
    $link = $('<a target="_blank">');
    $link.attr('href', img.src);
    $link.html(lyr.key() + ' ' + zstr);
    $title.append($link);
    $(img).css('background', lyr.bg);
    $test.append($title);
    $test.append(img);
    $container.append($test);
}

function layer_test() {
    var coord = tile_coord();
    // show full tile coord in url bar
    set_coord(coord, true);
    
    var layers = {};
    _.each(load_tile_specs(), function(spec) {
        var lyr = new LayerModel(spec);
        layers[lyr.key()] = lyr;
        test_tile(lyr, coord);
    });
    test_tile(layers['google:sat'], {z: 23, x:4965358, y: 4264294}, 'deepzoom');
}
