


self.addEventListener('message', function(e) {
        if (e.data instanceof Uint8Array) {
            self.postMessage(process_buffer(e.data));
        } else {
            self.update_pole(e.data);
        }
    }, false);

function update_pole(pole_t) {
    self.pole_tiles = {};
    for (var z = 0; z <= 22; z++) {
        self.pole_tiles[z] = {x: Math.floor(Math.pow(2., z) * pole_t.x), y: Math.floor(Math.pow(2., z) * pole_t.y)};
    }
    for (var z = 1; z <= 22; z++) {
        var antipole_t = {x: (pole_t.x + .5) % 1., y: 1. - pole_t.y};
        self.pole_tiles[64 + z] = {x: Math.floor(Math.pow(2., z) * antipole_t.x), y: Math.floor(Math.pow(2., z) * antipole_t.y)};
    }
}

function process_buffer(buff) {
    tiles = {};
    for (var i = 0; i < buff.length; i += 4) {
        var z = buff[i];
        var pole_tile = self.pole_tiles[z];
        if (pole_tile == null) {
            continue;
        }
        var x = (buff[i + 1] - 128) + pole_tile.x;
        var y = (buff[i + 2] - 128) + pole_tile.y;
        tiles[z + ':' + x + ':' + y] = true;
    }
    return tiles;
}