
TILE_OFFSET = 32;

// todo need to link these to main file
MAX_ZOOM = 22;
TILE_FRINGE_WIDTH = .1;

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

function parse_fringe(_fr, child_left) {
    fringe = {};
    if (_fr == 3) {
        if (TILE_FRINGE_WIDTH < 1/3.) {
            fringe.lo = false;
            fringe.hi = false;
            fringe.parent_lo = child_left;
            fringe.parent_hi = !child_left;
        } else {
            fringe.lo = !child_left;
            fringe.hi = child_left;
            fringe.parent_lo = false;
            fringe.parent_hi = false;
        }
    } else {
        fringe.lo = _fr & 0x1;
        fringe.hi = (_fr >> 1) & 0x1;
        fringe.parent_lo = fringe.lo && child_left;
        fringe.parent_hi = fringe.hi && !child_left;
    }
    return fringe;
}

function xadd(z, x0, offset) {
    return mod(x0 + offset, Math.pow(2, z));
}

function process_buffer(buff) {
    data = condense_data(buff);

    tiles = {};
    setTile = function(anti, z, x, y) {
        if (z < 0 || x < 0 || y < 0 || x >= Math.pow(2, z) || y >= Math.pow(2, z)) {
            return;
        }

        tiles[anti + ':' + z + ':' + x + ':' + y] = true;
    }
    setTiles = function(anti, z, x, y, left, right, top, bottom) {
        setTile(anti, z, x, y);
        if (left) {
            setTile(anti, z, xadd(z, x, -1), y);
        } else if (right) {
            setTile(anti, z, xadd(z, x, 1), y);
        }
        if (top) {
            setTile(anti, z, x, y - 1);
        } else if (bottom) {
            setTile(anti, z, x, y + 1);
        }
    }

    for (var e in data) {
        var anti = (e >> 22) & 0x1;
        var bleed = (e >> 21) & 0x1;
        var z = (e >> 16) & 0x1f;
        var _xfringe = (e >> 14) & 0x3;
        var _x = (e >> 8) & 0x3f;
        var _yfringe = (e >> 6) & 0x3;
        var _y = e & 0x3f;

        if (z > MAX_ZOOM) {
            // out of bounds
            continue;
        }

        var xdiff = _x - TILE_OFFSET;
        var ydiff = _y - TILE_OFFSET;
        var pole_tile = self.pole_tiles[zenc(anti, z)];
        var x = xadd(z, pole_tile.x, xdiff);
        var y = ydiff + pole_tile.y;

        var xfringe = parse_fringe(_xfringe, x % 2 == 0);
        var yfringe = parse_fringe(_yfringe, y % 2 == 0);

        setTiles(anti, z, x, y, xfringe.lo, xfringe.hi, yfringe.lo, yfringe.hi);
        if (bleed) {
            setTiles(anti, z - 1, Math.floor(x / 2), Math.floor(y / 2),
                     xfringe.parent_lo, xfringe.parent_hi, yfringe.parent_lo, yfringe.parent_hi);
        }
     }
    return tiles;
}