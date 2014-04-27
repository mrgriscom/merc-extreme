
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
        self.pole_tiles[zenc(false, z)] = {x: Math.floor(Math.pow(2., z) * poles.ref.x), y: Math.floor(Math.pow(2., z) * poles.ref.y)};
    }
    for (var z = 0; z <= MAX_ZOOM; z++) {
        self.pole_tiles[zenc(true, z)] = {x: Math.floor(Math.pow(2., z) * poles.antiref.x), y: Math.floor(Math.pow(2., z) * poles.antiref.y)};
    }
}

// mod that doesn't suck for negative numbers
function mod(a, b) {
    return ((a % b) + b) % b;
}

function zenc(anti, z) {
    return +anti + ':' + z;
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
        var anti = (e >> 22) & 0x1;
        var bleed = (e >> 21) & 0x1;
        var z = (e >> 16) & 0x1f;

        var b = (e >> 8) & 0xff;
        var c = e & 0xff;

        if (z > MAX_ZOOM) {
            // out of bounds
            continue;
        }

        var xdiff = b - TILE_OFFSET;
        var ydiff = c - TILE_OFFSET;
        var pole_tile = self.pole_tiles[zenc(anti, z)];
        var x = mod(xdiff + pole_tile.x, Math.pow(2, z));
        var y = ydiff + pole_tile.y;

        tiles[anti + ':' + z + ':' + x + ':' + y] = true;
    }
    return tiles;
}