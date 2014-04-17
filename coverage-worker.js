
ANTI_OFFSET = 32;

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
    for (var z = 0; z <= 22; z++) {
        var antipole_t = {x: (pole_t.x + .5) % 1., y: 1. - pole_t.y};
        self.pole_tiles[ANTI_OFFSET + z] = {x: Math.floor(Math.pow(2., z) * antipole_t.x), y: Math.floor(Math.pow(2., z) * antipole_t.y)};
    }
}

// mod that doesn't suck for negative numbers
function mod(a, b) {
    return ((a % b) + b) % b;
}

function process_buffer(buff) {
    tiles = {};
    for (var i = 0; i < buff.length; i += 4) {
        var _z = buff[i];
        var _x = buff[i + 1] - 32;
        var _y = buff[i + 2] - 32;
        var pole_tile = self.pole_tiles[_z];
        if (pole_tile == null) {
            continue;
        }

        var anti = (_z >= ANTI_OFFSET ? 1 : 0);
        var z = _z % ANTI_OFFSET;
        var extent = Math.pow(2, z);

        var x = mod(_x + pole_tile.x, extent);
        var y = _y + pole_tile.y;
        tiles[anti + ':' + z + ':' + x + ':' + y] = true;
    }
    return tiles;
}