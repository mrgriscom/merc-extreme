
ANTI_OFFSET = 32;
TILE_OFFSET = 32;
MAX_ZOOM = 22;

self.addEventListener('message', function(e) {
        if (e.data instanceof Uint8Array) {
            self.postMessage(process_buffer(e.data));
        } else {
            self.update_pole(e.data);
        }
    }, false);

function update_pole(poles) {
    self.pole_tiles = {};
    for (var z = 0; z <= MAX_ZOOM; z++) {
        self.pole_tiles[z] = {x: Math.floor(Math.pow(2., z) * poles.ref.x), y: Math.floor(Math.pow(2., z) * poles.ref.y)};
    }
    for (var z = 0; z <= MAX_ZOOM; z++) {
        self.pole_tiles[ANTI_OFFSET + z] = {x: Math.floor(Math.pow(2., z) * poles.antiref.x), y: Math.floor(Math.pow(2., z) * poles.antiref.y)};
    }
}

// mod that doesn't suck for negative numbers
function mod(a, b) {
    return ((a % b) + b) % b;
}

function condense_data(buff) {
    var uniques = {};
    for (var i = 0; i < buff.length; i += 4) {
        var a = buff[i];
        var b = buff[i + 1];
        var c = buff[i + 2];
        var val = (a << 16) | (b << 8) | c;
        uniques[val] = true;
    }
    return uniques;
}

function process_buffer(buff) {
    data = condense_data(buff);

    tiles = {};
    for (var e in data) {
        var a = (e >> 16) & 0xff;
        var b = (e >> 8) & 0xff;
        var c = e & 0xff;

        var _z = a;
        var _x = b - TILE_OFFSET;
        var _y = c - TILE_OFFSET;
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