/* guide to hungarian notation (TODO - this isn't actually used yet)
 * 
 * units prefix:
 * - mr: mercator-projected radians
 * - m: mercator-projected units (1 unit = 1 earth circumference)
 * - t: tile cartesian (top-left corner of z0 tile = (0, 0), bottom-right corner = (1, 1))
 * - gr: lat-lon radians
 * - g: lat-lon degrees
 * - v: xyz vector
 * - s: screen pixels ((0, 0) = upper-left)
 *
 * reference prefix:
 * - w: world -- coordinates correspond to physical planet
 * - p: projected -- coordinates correspond to planet with shifted pole
 */

/*
function Point(unit, ref, data) {
    this.unit = unit;
    this.ref = ref;
    this.data = data;
}
*/

// return next highest power of 2 >= x
function pow2ceil(x) {
    var EPSILON = 1e-9;
    var lgx = Math.log(x) / Math.log(2.);
    return Math.pow(2., Math.ceil(lgx - EPSILON));
}

var vertex_shader;
var fragment_shader;

var TILE_SIZE = 256;               // (px) dimensions of a map tile
var MAX_ZOOM = 22;                 // max zoom level to attempt to fetch image tiles
var SAMPLE_FREQ = 8.;              // (px) spatial frequency to sample tile coverage
var SAMPLE_TIME_FREQ = 2.;         // (hz) temporal frequency to sample tile coverage
var ATLAS_TEX_SIZE = 4096;         // (px) dimensions of single page of texture atlas (may be lowered based on
                                   // gpu capabilities
var APPROXIMATION_THRESHOLD = 0.5; // (px) maximum error when using schemes to circumvent lack of opengl precision
var PREC_BUFFER = 2;               // number of zoom levels early to switch to 'high precision' mode
var NORTH_POLE_COLOR = '#ccc';
var SOUTH_POLE_COLOR = '#aaa';
var MAX_MERC = 2.5;
var DEFAULT_EXTENT_S = .5;

// these aren't really meant to be changed... more just to justify how various constants got their values
var SCREEN_WIDTH_SOFTMAX = 1920;
var SCREEN_HEIGHT_SOFTMAX = 1200;
var MIN_BIAS = 0.;
var MAX_ZOOM_BLEND = .6;
var HIGH_PREC_Z_BASELINE = 16;

function setComputedConstants(GL) {
    MAX_Z_WARP = 1. - MIN_BIAS + .5 * MAX_ZOOM_BLEND;
    MIPMAP_LEVELS = Math.ceil(MAX_Z_WARP);
    var tiles_per = function(dim, noround) {
        var t = dim / TILE_SIZE *  Math.pow(2, MAX_Z_WARP);
        return noround ? t : Math.ceil(t);
    }

    // edge of tile where adjacent tile should also be loaded to compensate for lower resolution of tile coverage pass
    TILE_FRINGE_WIDTH = Math.min(tiles_per(SAMPLE_FREQ, true), .5);
    // size of a padded tile in the atlas texture
    TILE_SKIRT = Math.pow(2, MIPMAP_LEVELS); //px
    ATLAS_TILE_SIZE = TILE_SIZE + 2 * TILE_SKIRT;

    if (typeof screen !== 'undefined') {
        SCREEN_WIDTH = Math.min(screen.width, SCREEN_WIDTH_SOFTMAX);
        SCREEN_HEIGHT = Math.min(screen.height, SCREEN_HEIGHT_SOFTMAX);
        SCREEN_DIAG = Math.sqrt(Math.pow(SCREEN_WIDTH, 2) + Math.pow(SCREEN_HEIGHT, 2));
        // maximum span of adjacent tiles of the same zoom level that can be visible at once
        MAX_Z_TILE_SPAN = tiles_per(SCREEN_DIAG);
        // an estimate of how many tiles can be active in the tile index at once
        MAX_TILES_AT_ONCE = tiles_per(SCREEN_WIDTH) * tiles_per(SCREEN_HEIGHT) * 4./3.;
        // 
        TILE_OFFSET_RESOLUTION = pow2ceil(MAX_Z_TILE_SPAN);
        // size of a single z-level's cell in the atlas index texture
        TEX_Z_IX_SIZE = 2 * TILE_OFFSET_RESOLUTION;
        // number of z index cells in one edge of the index texture
        TEX_IX_CELLS = pow2ceil(Math.sqrt(2 * (MAX_ZOOM + 1)));
        // size of the atlas index texture
        TEX_IX_SIZE = TEX_IX_CELLS * TEX_Z_IX_SIZE;

        if (GL) {
            var _gl = GL.context;
            var maxTexSize = _gl.getParameter(_gl.MAX_TEXTURE_SIZE);
            ATLAS_TEX_SIZE = Math.min(maxTexSize, ATLAS_TEX_SIZE);
            // number of tiles that can fit in one texture page (along one edge)
            TEX_SIZE_TILES = Math.floor(ATLAS_TEX_SIZE / ATLAS_TILE_SIZE);
            NUM_ATLAS_PAGES = Math.ceil(MAX_TILES_AT_ONCE / Math.pow(TEX_SIZE_TILES, 2));
        }
    }
}

function init() {
    initGlobal();
    var env = checkEnvironment();
    console.log(env.errors);
    setComputedConstants(env.gl);

    vertex_shader = loadShader('vertex');
    fragment_shader = loadShader('fragment');
    
    var merc = new MercatorRenderer(env.gl, $('#container'), function(window) {
        return [window.innerWidth, window.innerHeight - $('#titlebar').outerHeight()];
    }, MAX_MERC, DEFAULT_EXTENT_S);
    MERC = merc;

    var initSlider = function($container, max, field, init) {
        var set = function(val) {
            $container.find('.slider-val').text(val + '%');
            merc[field] = .01 * val;
        }
        $container.find('.slider').slider({
            range: 'max',
            max: 100 * max,
            value: 100 * (init || 0),
            slide: function(ev, ui) { set(ui.value); }
        });
        set($container.find('.slider').slider('value'));
    };
    initSlider($('#blend'), MAX_ZOOM_BLEND, 'zoom_blend');
    initSlider($('#overzoom'), .5, 'overzoom');
    initSlider($('#blinders'), 1, 'blinder_opacity', .7);


    var koRoot = new EMViewModel(merc);
    koRoot.load(tile_specs, landmarks);
    ko.applyBindings(koRoot);

    var initPole = _.find(koRoot.places(), function(e) { return e.default; });
    initPole._select(true);

    merc.start();

    $('#companion').click(function() {
        COMPANION = window.open('companion/', 'companion', 'width=600,height=600,location=no,menubar=no,toolbar=no,status=no,personalbar=no');
        COMPANION.onbeforeunload = function() { COMPANION = null; };
    });
    DEBUG = {postMessage: function(){}};
    METRIC = true;

    $('.swap').click(function() {
        merc.swapPoles();
    });

    geocoder = new GEOCODERS.google();
    $('#search').submit(function() {
        var callbacks = {
            onresult: function(lat, lon) {
                merc.poleAt(lat, lon);
            },
            onnoresult: function() {
                alert('no results');
            },
        };

        var match_ll = function(q) {
            var FLOAT_PATTERN = '[+-]?(?:\\d*\\.\\d+|\\d+\\.?)';
            var LL_PATTERN = '^(' + FLOAT_PATTERN + ')(?: |,|, )(' + FLOAT_PATTERN + ')$';
            var matches = q.match(new RegExp(LL_PATTERN));
            if (matches) {
                var lat = +matches[1];
                var lon = +matches[2];
                if (lat <= 90 && lat >= -90 && lon <= 360 && lon >= -180) {
                    return [lat, lon];
                }
            }
            return null;
        }

        var query = $('#locsearch').val().trim();
        var literal_ll = match_ll(query);
        if (literal_ll) {
            callbacks.onresult(literal_ll[0], literal_ll[1]);        
        } else {
            geocoder.geocode(query, callbacks);
        }
        return false;
    });
}

function checkEnvironment() {
    var errors = {};
    var GL = null;

    // webgl enabled
    var webgl = (function() {
	    try {
            var canvas = document.createElement('canvas');
            return !!window.WebGLRenderingContext && (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
        } catch(e) {
            return false;
        }
    })();
    if (!webgl) {
        errors.webgl = true;
    } else {
        var GL = new THREE.WebGLRenderer();
        var _gl = GL.context;

        // shader precision
        var prec_type = GL.getPrecision();
        var prec_bits = _gl.getShaderPrecisionFormat(_gl.FRAGMENT_SHADER, {highp: _gl.HIGH_FLOAT, mediump: _gl.MEDIUM_FLOAT}[prec_type]).precision;
        console.log('fragment shader: ' + prec_type + ', ' + prec_bits + ' bits');
        if (prec_bits < 23) {
            errors.precision = true;
        }

        console.log('max tex size', _gl.getParameter(_gl.MAX_TEXTURE_SIZE));
        console.log('max # texs', _gl.getParameter(_gl.MAX_TEXTURE_IMAGE_UNITS));
        console.log('glextentions', _gl.getSupportedExtensions());
    }

    // screen size
    if (screen.width > SCREEN_WIDTH_SOFTMAX || screen.height > SCREEN_HEIGHT_SOFTMAX) {
        errors.screensize = true;
    }

    // chrome
    if (!$.browser.chrome) {
        errors.chrome = true;
    }

    return {errors: errors, gl: GL};
}

function initGlobal() {
    GridGeometry.prototype = Object.create(THREE.BufferGeometry.prototype);

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
}

function GoogleGeocoder() {
    var that = this;
    google.maps.event.addDomListener(window, 'load', function() {
        that.geocoder = new google.maps.Geocoder();
    });

    this.geocode = function(query, callbacks) {
        // caution: geocoder is loaded async
        this.geocoder.geocode({address: query}, function(results, status) {
            if (status == google.maps.GeocoderStatus.OK) {
                var pos = results[0].geometry.location;
                callbacks.onresult(pos.lat(), pos.lng());
            } else {
                callbacks.onnoresult();
            }
        });
    }
}

function BingGeocoder() {
    this.geocode = function(query, callbacks) {
        window.bingRecv = function(data) {
            var entry = data.resourceSets[0].resources[0];
            if (entry == null) {
                callbacks.onnoresult();
            } else {
                var pos = entry.point.coordinates;
                callbacks.onresult(pos[0], pos[1]);
            }
        };

        $.getJSON('http://dev.virtualearth.net/REST/v1/Locations/' + encodeURIComponent(query) + '?callback=?&jsonp=bingRecv&key=' + API_KEYS.bing);
    }
}

function MapquestGeocoder() {
    this.geocode = function(query, callbacks) {
        $.getJSON('http://www.mapquestapi.com/geocoding/v1/address?key=' + API_KEYS.mapquest + '&location=' + encodeURIComponent(query), {}, function(results) {
            var entry = results.results[0].locations[0];
            if (entry.geocodeQualityCode.substring(0, 2) == 'A1') {
                callbacks.onnoresult();
            } else {
                var pos = entry.latLng;
                callbacks.onresult(pos.lat, pos.lng);
            }
        });
    }
}

GEOCODERS = {
    google: GoogleGeocoder,
    bing: BingGeocoder,
    mapquest: MapquestGeocoder,
};

function launchDebug() {
    DEBUG = window.open('debug.html', 'debug', 'width=800,height=600,location=no,menubar=no,toolbar=no,status=no,personalbar=no');
}



/* xy is google style upper left=(0, 0), lower right=(1, 1) */
// g -> t
function ll_to_xy(lat, lon) {
    var x = lon / 360. + .5;
    var rlat = lat * Math.PI / 180.;
    var merc_y = Math.log(Math.tan(.5 * rlat + .25 * Math.PI));
    var y = .5 - merc_y / (2. * Math.PI);
    return {x: x, y: y};
}

/* xy is x:0,1 == -180,180, y:equator=0 */
// t -> g
function xy_to_ll(x, y) {
    var lon = (x - .5) * 360.;
    var merc_y = 2. * Math.PI * y;
    var rlat = 2. * Math.atan(Math.exp(merc_y)) - .5 * Math.PI;
    var lat = rlat * 180. / Math.PI;
    return [lat, lon];
}

/*
use versions in geodesy.js instead

// g -> v
function ll_to_xyz(lat, lon)

// v -> g
function xyz_to_ll(x, y, z)

*/

// gp -> gw
function translate_pole(pos, pole) {
    return line_plotter(pole, 180 - pos[1])((90 - pos[0]) / DEG_RAD * EARTH_MEAN_RAD);
}

// gw -> gp
function inv_translate_pole(pos, pole) {
    var dist = distance(pole, pos, true);
    var heading = bearing(pole, pos);
    return [90 - dist * DEG_RAD, 180 - heading];
}

// estimate the error from using a flat earth approximation (ie, plotting
// the distance from a center point directly on the mercator-projected plane
// rather than on the surface of the spherical earth)
// lat: latitude in degrees of center of circle
// radius: radius of circle in earth radii
// DO NOT ask how i figured this all out
function flat_earth_error(lat, radius) {
    lat = Math.abs(lat);

    // handle situations where approximation becomes too inaccurate
    if (radius > .1) {
        return Number.POSITIVE_INFINITY;
    }
    var rlog = Math.max(Math.log(radius) / Math.LN10, -4);
    // empirically determined thresholds at which estimate starts
    // to differ from reality by more than 1%
    var latmin = 18. * Math.pow(10., rlog);
    var latmax = 90. - 97. * Math.pow(10., rlog);
    if (lat > latmax) {
        return Number.POSITIVE_INFINITY;
    } else if (lat < latmin) {
        lat = latmin;
    }

    var rlat = lat * Math.PI / 180.;
    return .5 * Math.pow(radius, 2.) * Math.tan(rlat);
}

// lat: latitude in projected coordinate system
// scale: pixels per earth circumference
function flat_earth_error_px(lat, scale, pole_lat) {
    var lat = Math.abs(lat);
    var rlat = lat * Math.PI / 180.;
    var pole_dist = .5 * Math.PI - rlat;

    var error = flat_earth_error(pole_lat, pole_dist);
    var px_size = 2. * Math.PI / scale * Math.cos(rlat); // radians per pixel

    return error / px_size;
}

function solve_eq(start, end, resolution, func) {
    if (func(start)) {
        return start;
    } else if (!func(end)) {
        return end;
    }

    var x, result;
    while (true) {
        x = .5 * (start + end);
        if (Math.abs(end - start) <= resolution) {
            return x;
        }

        result = func(x);
        if (result) {
            end = x;
        } else {
            start = x;
        }
    }
}




function arrCopy(dst, start, src) {
    for (var i = 0; i < src.length; i++) {
        dst[start + i] = src[i];
    }
}

GridGeometry = function(maxquads) {
	THREE.BufferGeometry.call(this);

    this.maxquads = maxquads;
    this.addAttribute('index', Uint16Array, this.maxquads * 6, 1);
	this.addAttribute('position', Float32Array, this.maxquads * 4, 3);
	this.addAttribute('uv', Float32Array, this.maxquads * 4, 2);
	this.addAttribute('uv2', Float32Array, this.maxquads * 4, 2);
    this.offsets.push({
		start: 0,
        index: 0,
        count: this.attributes.index.array.length
    });

    this.setData = function(type, offset, data) {
        var attr = this.attributes[type];
        arrCopy(attr.array, offset * attr.itemSize, data);
        attr.needsUpdate = true;
    }

    this.setQuad = function(ix, x0, x1, y0, y1, tex) {
        var v = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
        var vix = [4*ix, 4*ix + 1, 4*ix + 2, 4*ix + 3];
        this.setData('index', 6*ix, [vix[0], vix[1], vix[3], vix[0], vix[3], vix[2]]);
        this.setData('position', vix[0], v[0]); // note implied zero for z-coord
        this.setData('position', vix[1], v[1]);
        this.setData('position', vix[2], v[2]);
        this.setData('position', vix[3], v[3]);
        this.setData('uv', vix[0], v[0]);
        this.setData('uv', vix[1], v[1]);
        this.setData('uv', vix[2], v[2]);
        this.setData('uv', vix[3], v[3]);
        this.setData('uv2', vix[0], tex ? tex[0] : v[0]);
        this.setData('uv2', vix[1], tex ? tex[1] : v[1]);
        this.setData('uv2', vix[2], tex ? tex[2] : v[2]);
        this.setData('uv2', vix[3], tex ? tex[3] : v[3]);
    }

    this.clearQuads = function(beyond) {
        var attr = this.attributes.index;
        for (var i = beyond * 6; i < attr.array.length; i++) {
            attr.array[i] = 0;
        }
        attr.needsUpdate = true;
    }

}
// see initGlobal

function TexBuffer(size, texopts, bufopts) {
    bufopts = bufopts || {};
    this.width = size;
    this.height = size * (bufopts.aspect || 1.);
    
    // if bufopts.nocanvas, we don't actually need the <canvas>, but can't
    // figure out how to initialize texture otherwise
    var tmp = mk_canvas(this.width, this.height);
    this.$tx = tmp.canvas;
    this.ctx = tmp.context;

    this.tx = new THREE.Texture(this.$tx);
    var texbuf = this;
    $.each(texopts || {}, function(k, v) {
        texbuf.tx[k] = v;
    });
    this.tx.needsUpdate = true;
    
    this.incrUpdates = [];
    var texbuf = this;
    this.tx.incrementalUpdate = function(updatefunc) {
        for (var i = 0; i < texbuf.incrUpdates.length; i++) {
            texbuf.incrUpdates[i](updatefunc);
        }
        texbuf.incrUpdates = [];
    }
    this.tx.preUpdate = function() {
        if (texbuf.preUpdate) {
            texbuf.preUpdate();
        }
    }
    
    this.update = function(draw) {
        draw(this.ctx, this.width, this.height);
        this.tx.needsUpdate = true;
    }
    
    this.incrementalUpdate = function(updater) {
        // for inspecting canvas
        //updater(function(img, x, y) { texbuf.ctx.drawImage(img, x, y); });
        this.incrUpdates.push(updater);
    }
}

function IndexFragment(type, z, xoffset, yoffset, layer) {
    var ctx = layer.tex_index.ctx;
    var dim = Math.min(Math.pow(2, z), TILE_OFFSET_RESOLUTION);
    this.buf = ctx.createImageData(dim, dim);
    this.offsets = {x: xoffset, y: yoffset};
    this.type = type;
    this.z = z;
    this.tiles = {};
    this.dirty = false;

    this.addTile = function(tile, slot) {
        this.set_px(tile.x, tile.y, slot);
        this.tiles[tile.z + ':' + tile.x + ':' + tile.y] = true;
        this.setDirty();
    }

    this.removeTile = function(z, x, y) {
        this.set_px(x, y, null);
        delete this.tiles[z + ':' + x + ':' + y];
        this.setDirty();
    }

    this.setDirty = function() {
        this.dirty = true;
        layer.tex_index.tx.needsUpdate = true;
    }

    this.empty = function() {
        return this.tiles.length == 0;
    }

    this.set_px = function(x, y, slot) {
        var dx = x - this.offsets.x * TILE_OFFSET_RESOLUTION;
        var dy = y - this.offsets.y * TILE_OFFSET_RESOLUTION;
        var base = 4 * (dy * this.buf.width + dx);
        this.buf.data[base] = slot ? slot.tex + 1 : 0;
        this.buf.data[base + 1] = slot ? slot.x : 0;
        this.buf.data[base + 2] = slot ? slot.y : 0;
        this.buf.data[base + 3] = 255;
    }

    this._update = function(anti) {
        var ix_offsets = layer.index_offsets[(anti ? 1 : 0) + ':' + this.z];
        if (ix_offsets == null) {
            return;
        }

        var dx = mod((this.offsets.x - ix_offsets.x) * TILE_OFFSET_RESOLUTION, Math.pow(2., this.z));
        var dy = (this.offsets.y - ix_offsets.y) * TILE_OFFSET_RESOLUTION;
        if (dx >= TEX_Z_IX_SIZE || dy < 0 || dy >= TEX_Z_IX_SIZE) {
            // out of range for current offset
            return;
        }
 
        var zx = this.z % (TEX_IX_SIZE / TEX_Z_IX_SIZE);
        var zy = Math.floor(this.z / (TEX_IX_SIZE / TEX_Z_IX_SIZE)) + (anti ? .5 : 0) * (TEX_IX_SIZE / TEX_Z_IX_SIZE);
        
        var px = zx * TEX_Z_IX_SIZE + dx;
        var py = zy * TEX_Z_IX_SIZE + dy;

        var frag = this;
        layer.tex_index.update(function(ctx, w, h) {
            ctx.putImageData(frag.buf, px, py);
        });
    }

    this.update = function() {
        if (!this.dirty) {
            return;
        }

        this._update(false);
        this._update(true);
        this.dirty = false;

        if (this.empty()) {
            // purge self
            delete layer.index_fragments[this.z + ':' + this.offsets.x + ':' + this.offsets.y];
        }
    }
}

function TextureLayer(context) {
    
    this.context = context;

    this.curlayer = null;

    this.onViewportSet = function() {
        this.sample_width = Math.round(this.context.width_px / SAMPLE_FREQ);
        this.sample_height = Math.round(this.context.height_px / SAMPLE_FREQ);
        this.target = new THREE.WebGLRenderTarget(this.sample_width, this.sample_height, {format: THREE.RGBFormat});
        this.target.generateMipmaps = false;
        this.sampleBuff = new Uint8Array(this.sample_width * this.sample_height * 4);
    }

    this.worker = new Worker('coverage-worker.js');

    this.pending = [];
    
    this.tex_z0 = new TexBuffer(TILE_SIZE, {
        generateMipmaps: true,
        magFilter: THREE.LinearFilter,
        minFilter: THREE.LinearMipMapLinearFilter,
        wrapS: THREE.RepeatWrapping, // still getting seams... why?
        flipY: false,
    }, {aspect: 2.});
    this.tex_atlas = [];
    for (var i = 0; i < NUM_ATLAS_PAGES; i++) {
        var page = new TexBuffer(ATLAS_TEX_SIZE, {
            // mipmapping must be done manually due to non-continguity of images
            generateMipmaps: false,
            magFilter: THREE.LinearFilter,
            minFilter: THREE.LinearFilter,
            flipY: false,
        }, {nocanvas: true});
        this.tex_atlas.push(page);
    }
    this.tex_index = new TexBuffer(TEX_IX_SIZE, {
        generateMipmaps: false,
        magFilter: THREE.NearestFilter,
        minFilter: THREE.NearestFilter,
        flipY: false,
    });

    this.tile_index = {};
    this.free_slots = {};
    for (var i = 0; i < this.tex_atlas.length; i++) {
        for (var j = 0; j < TEX_SIZE_TILES; j++) {
            for (var k = 0; k < TEX_SIZE_TILES; k++) {
                this.free_slots[i + ':' + j + ':' + k] = true;
            }
        }
    }
    this.index_offsets = {};
    this.index_fragments = {};
    var layer = this;
    this.tex_index.preUpdate = function() {
        _.each(layer.index_offsets, function(v, k) {
            var pcs = k.split(':');
            var anti = +pcs[0];
            var z = +pcs[1];

            layer.each_fragment_for_z(layer.curlayer.id, z, v.x, v.y, function(frag) {
                frag.update();
            });
        });
    }
    
    this.init = function() {
        var layer = this;
        this.worker.addEventListener('message', function(e) {
            layer.sample_coverage_postprocess(e.data);
            layer.sampling_complete();
        }, false);
    }
    
    this.setLayer = function(type) {
        if (this.curlayer != null && type.id == this.curlayer.id) {
            return;
        }

        // z0 tile has a dedicated texture, so z0 for multiple layers cannot co-exist
        // ensure the tile is reloaded when the layer is switched back
        if (this.curlayer) {
            var key = this.curlayer.id + ':' + 0 + ':' + 0 + ':' + 0;
            var entry = this.tile_index[key];
            if (entry) {
                entry.rebuild_z0 = true;
            }
        }

        this.curlayer = type;

        // trigger immediate reload
        this.force_ix_rebuild = true;
        context.last_sampling = null;
    }

    this.sample_coverage = function(oncomplete) {
        this.sampling_complete = oncomplete;
        
        var gl = this.context.glContext;
        this.context.renderer.render(this.context.scene, this.context.camera, this.target);
        // readPixels is slow and a bottleneck, seemingly regardless of buffer size
        gl.readPixels(0, 0, this.sample_width, this.sample_height, gl.RGBA, gl.UNSIGNED_BYTE, this.sampleBuff); // RGBA required by spec
        this.worker.postMessage({ref: this.context.ref_t, antiref: this.context.anti_ref_t});
        this.worker.postMessage(this.sampleBuff);
    }
    
    var offset = function(min, z) {
        return Math.floor(mod(min, Math.pow(2., z)) / TILE_OFFSET_RESOLUTION);
    }

    this.each_fragment_for_z = function(layer, z, xo, yo, func) {
        for (var i = 0; i < 2; i++) {
            var x = mod(xo + i, Math.pow(2, z) / TILE_OFFSET_RESOLUTION);
            for (var j = 0; j < 2; j++) {
                var y = yo + j;
                var frag = this.index_fragments[layer + ':' + z + ':' + x + ':' + y];
                if (frag) {
                    func(frag);
                }
            }
        }
    }

    this.tile_index_add = function(layer_type, tile, slot) {
        var xo = offset(tile.x, tile.z);
        var yo = offset(tile.y, tile.z);
        var fragkey = layer_type + ':' + tile.z + ':' + xo + ':' + yo;
        var frag = this.index_fragments[fragkey];
        if (!frag) {
            frag = new IndexFragment(layer_type, tile.z, xo, yo, this);
            this.index_fragments[fragkey] = frag;
        }
        frag.addTile(tile, slot);
    }

    this.tile_index_remove = function(layer_type, z, x, y) {
        var xo = offset(x, z);
        var yo = offset(y, z);
        var fragkey = layer_type + ':' + z + ':' + xo + ':' + yo;
        var frag = this.index_fragments[fragkey];
        frag.removeTile(z, x, y);
        // removal of empty frag from index_fragments happens after texture refresh
    }

    this.sample_coverage_postprocess = function(data) {
        var curlayer = this.curlayer;
        var tilekey = function(tile) {
            return curlayer.id + ':' + tile.z + ':' + tile.x + ':' + tile.y;
        }
        
        var unpack_tile = function(key) {
            var pcs = key.split(':');
            return {
                anti: +pcs[0] == 1,
                z: +pcs[1],
                x: +pcs[2],
                y: +pcs[3]
            };
        }
        // include all parent tiles of visible tiles
        // support smoother zoom-out, and we always need the z0 tile loaded
        _.each(_.clone(data), function(v, k) {
            var t = unpack_tile(k);
            while (true) {
                t.z -= 1;
                t.x = Math.floor(t.x / 2);
                t.y = Math.floor(t.y / 2);
                var key = +t.anti + ':' + t.z + ':' + t.x + ':' + t.y;
                if (t.z >= 0 && !data[key]) {
                    data[key] = true;
                } else {
                    break;
                }
            }
        });

        // we want a tile to remain in view for at least this long to make
        // loading it worth our while (even assuming immediate dl from cache)
        var MIN_VISIBLE_TIME = .15;
        var max_zoom = Math.min(this.context.max_zoom_for_time_horizon(MIN_VISIBLE_TIME),
                                curlayer.max_depth || MAX_ZOOM);
        var tiles = _.sortBy(_.map(data, function(v, k) { return unpack_tile(k); }),
                             function(e) { return e.z + (e.anti ? .5 : 0.); });
        var tiles = _.filter(tiles, function(e) { return e.z <= max_zoom; });

        var layer = this;
        
        if (window.MRU_counter == null) {
            MRU_counter = 0;
        }

        if (this.force_ix_rebuild) {
            this.index_offsets = {};
            for (var z = 0; z <= MAX_ZOOM; z++) {
                this.set_offset(z, true, 0, 0);
                this.set_offset(z, false, 0, 0);
                this.clear_tile_ix(z, true);
                this.clear_tile_ix(z, false);
            }
            this.force_ix_rebuild = false;
        }

        var ranges = {};
        var range_basetile = {};
        $.each(tiles, function(i, tile) {
            var key = (tile.anti ? 1 : 0) + ':' + tile.z;
            var r = ranges[key];
            if (r == null) {
                range_basetile[key] = tile;
                ranges[key] = {xmin: tile.x, xmax: tile.x, ymin: tile.y, ymax: tile.y};
            } else {
                var tile_x = unwraparound(range_basetile[key].x, tile.x, Math.max(Math.pow(2., tile.z), TEX_Z_IX_SIZE));
                r.xmin = Math.min(r.xmin, tile_x);
                r.xmax = Math.max(r.xmax, tile_x);
                r.ymin = Math.min(r.ymin, tile.y);
                r.ymax = Math.max(r.ymax, tile.y);
            }
        });
        $.each(ranges, function(k, v) {
            // assert range <= TILE_OFFSET_RESOLUTION

            var pcs = k.split(':');
            var anti = +pcs[0];
            var z = +pcs[1];

            var xoffset = offset(v.xmin, z);
            var yoffset = offset(v.ymin, z);
            var cur_offsets = layer.index_offsets[k];
            if (cur_offsets == null || cur_offsets.x != xoffset || cur_offsets.y != yoffset) {
                layer.index_offsets[k] = {x: xoffset, y: yoffset};
                layer.set_offset(z, anti, xoffset, yoffset);

                layer.clear_tile_ix(z, anti);
                layer.each_fragment_for_z(layer.curlayer.id, z, xoffset, yoffset, function(frag) {
                    frag.setDirty();
                });
            }
        });

        // mark all tiles for LRU if exist in cache
        $.each(tiles, function(i, tile) {
            var ix_entry = layer.tile_index[tilekey(tile)];
            if (ix_entry) {
                ix_entry.mru = MRU_counter;
            }
        });
        this.tiles_by_age = _.sortBy(_.filter(_.pairs(this.tile_index), function(e) {
            return e[1].slot != null;
        }), function(e) {
            return -e[1].mru;
        });

        var split_slot_key = function(key) {
            var pcs = key.split(':');
            return {tex: +pcs[0], x: +pcs[1], y: +pcs[2]};
        };

        this.active_tiles = {};
        _.each(tiles, function(tile) {
            layer.active_tiles[tilekey(tile)] = true;
        });

        $.each(tiles, function(i, tile) {
            var entry = layer.tile_index[tilekey(tile)];
            if (entry != null && !entry.rebuild_z0) {
                return;
            }
            
            layer.tile_index[tilekey(tile)] = {status: 'loading'};
            load_image(curlayer, tile, function(img) {
                var ix_entry = layer.tile_index[tilekey(tile)];
                if (img == null) {
                    ix_entry.status = 'noexist';
                    return;
                }
                ix_entry.status = 'loaded';
                ix_entry.img = img;
                
                if (!layer.active_tiles[tilekey(tile)]) {
                    //console.log('tile moot');
                    delete layer.tile_index[tilekey(tile)];
                    return;
                }

                if (tile.z == 0) {
                    layer.mk_top_level_tile(img);
                    delete ix_entry.rebuild_z0;
                    return;
                }

                var slot = null;
                $.each(layer.free_slots, function(k, v) {
                    // always pick first and bail
                    slot = split_slot_key(k);
                    return false;
                });
                if (slot == null) {
                    //console.log('no slot');
                    var _oldest = layer.tiles_by_age.pop() || [null, null];
                    var oldest_key = _oldest[0];
                    var oldest_entry = _oldest[1];
                    if (oldest_entry == null || oldest_entry.mru == MRU_counter) {
                        // tile cache is full (provision extra space?)
                        console.log('tile cache is full!');
                        return;
                    }
                    
                    slot = oldest_entry.slot;
                    delete layer.tile_index[oldest_key];

                    var pcs = oldest_key.split(':');
                    layer.tile_index_remove(pcs[0], +pcs[1], +pcs[2], +pcs[3]);
                }
                
                ix_entry.slot = slot;
                ix_entry.pending = true;
                delete layer.free_slots[slot.tex + ':' + slot.x + ':' + slot.y];
                layer.pending.push({layer: curlayer, tile: tile, img: img, slot: slot});
                //console.log('loading', tilekey(tile));

                layer.tile_index_add(curlayer.id, tile, slot);
                ix_entry.mru = MRU_counter;
            });
        });
        
        MRU_counter++;

        DEBUG.postMessage({type: 'tiles', data: data}, '*');
    }

    var skirt = 1;
    var seamCorner = mk_canvas(skirt, skirt);
    var seamHoriz = mk_canvas(TILE_SIZE, skirt);
    var seamVert = mk_canvas(skirt, TILE_SIZE);

    this.handlePending = function() {
        var layer = this;
        var tilekey = function(layer, tile) {
            return layer.id + ':' + tile.z + ':' + tile.x + ':' + tile.y;
        }
        var seamCoords = function(slot, dx, dy) {
            var xoffset = (dx < 0 ? -skirt : dx > 0 ? TILE_SIZE : 0);
            var yoffset = (dy < 0 ? -skirt : dy > 0 ? TILE_SIZE : 0);
            return {x: ATLAS_TILE_SIZE * slot.x + TILE_SKIRT + xoffset,
                    y: ATLAS_TILE_SIZE * slot.y + TILE_SKIRT + yoffset};
        }
        var writeImgData = function(slot, dx, dy, getimg) {
            layer.tex_atlas[slot.tex].incrementalUpdate(function(update) {
                var coord = seamCoords(slot, dx, dy);
                update(getimg(), coord.x, coord.y);
            });
        }
        var imgOffset = function(k) {
            return k > 0 ? skirt - TILE_SIZE : 0;
        }

        var handle_neighbor = function(e, dx, dy) {
            var tile = e.tile;
            var slot = e.slot;

            var buf = (dx != 0 && dy != 0 ? seamCorner : dx != 0 ? seamVert : seamHoriz);
            var neighbor = {z: tile.z, x: mod(tile.x + dx, Math.pow(2., tile.z)), y: tile.y + dy};
            var n_entry = layer.tile_index[tilekey(e.layer, neighbor)];
            if (neighbor.y < 0 || neighbor.y >= Math.pow(2., tile.z)) {
                // out of bounds
                writeImgData(slot, dx, dy, function() {
                    buf.context.fillStyle = (dy < 0 ? NORTH_POLE_COLOR : SOUTH_POLE_COLOR);
                    buf.context.fillRect(0, 0, buf.canvas.width, buf.canvas.height);
                    return buf.canvas;
                });
            } else if (n_entry != null && n_entry.slot && !n_entry.pending) {
                //write this edge to other tile
                writeImgData(n_entry.slot, -dx, -dy, function() {
                    buf.context.drawImage(e.img, imgOffset(dx), imgOffset(dy));
                    return buf.canvas;
                });
                //write other tile's edge to this tile
                writeImgData(slot, dx, dy, function() {
                    buf.context.drawImage(n_entry.img, imgOffset(-dx), imgOffset(-dy));
                    return buf.canvas;
                });
            }
        }

        _.each(this.pending, function(e) {
            writeImgData(e.slot, 0, 0, function() { return e.img; });

            for (var dx = -1; dx < 2; dx++) {
                for (var dy = -1; dy < 2; dy++) {
                    if (dx == 0 && dy == 0) {
                        continue;
                    }
                    handle_neighbor(e, dx, dy);
                }
            }

            delete layer.tile_index[tilekey(e.layer, e.tile)].pending;
        });
        this.pending = [];
    }
    
    this.set_offset = function(z, anti, xo, yo) {
        var px = z;
        var py = (anti ? .5 : 0) * TEX_IX_SIZE + TEX_Z_IX_SIZE - 1;
        
        this.tex_index.update(function(ctx, w, h) {
            var buf = ctx.createImageData(1, 1);
            
            buf.data[0] = (xo >> 16) & 0xff;
            buf.data[1] = (xo >> 8) & 0xff;
            buf.data[2] = xo & 0xff;
            buf.data[3] = 255;
            ctx.putImageData(buf, px, py);
            
            buf.data[0] = (yo >> 16) & 0xff;
            buf.data[1] = (yo >> 8) & 0xff;
            buf.data[2] = yo & 0xff;
            buf.data[3] = 255;
            ctx.putImageData(buf, px, py - 1);
        });
    }

    this.clear_tile_ix = function(z, anti) {
        var zx = z % (TEX_IX_SIZE / TEX_Z_IX_SIZE);
        var zy = Math.floor(z / (TEX_IX_SIZE / TEX_Z_IX_SIZE)) + (anti ? .5 : 0) * (TEX_IX_SIZE / TEX_Z_IX_SIZE);
        var size = Math.min(Math.pow(2, z), TEX_Z_IX_SIZE);
        this.tex_index.update(function(ctx, w, h) {
            ctx.fillStyle = '#000';
            ctx.fillRect(zx * TEX_Z_IX_SIZE, zy * TEX_Z_IX_SIZE, size, size);
        });
    }

    this.mk_top_level_tile = function(img) {
        this.tex_z0.update(function(ctx, w, h) {
            ctx.fillStyle = NORTH_POLE_COLOR;
            ctx.fillRect(0, 0, TILE_SIZE, .5*TILE_SIZE);
            ctx.fillStyle = SOUTH_POLE_COLOR;
            ctx.fillRect(0, 1.5*TILE_SIZE, TILE_SIZE, .5*TILE_SIZE);
            ctx.drawImage(img, 0, .5*TILE_SIZE);
        });
    }
    
    this.material = function(params) {
        if (!this.uniforms) {
            this.uniforms = {
                scale: {type: 'f', value: 0.},
                bias: {type: 'f', value: 0.},
                pole: {type: 'v2', value: null},
                pole_t: {type: 'v2', value: null},
                ref_t: {type: 'v2', value: null},
                anti_ref_t: {type: 'v2', value: null},
                tx_ix: {type: 't', value: this.tex_index.tx},
                tx_atlas: {type: 'tv', value: $.map(this.tex_atlas, function(e) { return e.tx; })},
                tx_z0: {type: 't', value: this.tex_z0.tx},
                zoom_blend: {type: 'f', value: 0.},
                blinder_start: {type: 'f', value: 0.},
                blinder_opacity: {type: 'f', value: 0.},

                hp_pole_tile: {type: 'v2', value: null},
                hp_pole_offset: {type: 'v2', value: null},
                hp_ref_tile: {type: 'v2', value: null},
                hp_antiref_tile: {type: 'v2', value: null},
            };
        }
        return new THREE.ShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: configureShader(vertex_shader),
            fragmentShader: configureShader(fragment_shader, params)
        });
    }
    
    this.init();
    this._materials = {
        'image': {
            'sphere': this.material({geo_mode: 'sphere', output_mode: 'tex'}),
            'linear': this.material({geo_mode: 'linear', output_mode: 'tex'}),
            'flat': this.material({geo_mode: 'flat', output_mode: 'tex'}),
        },
        'sampler': {
            'sphere': this.material({geo_mode: 'sphere', output_mode: 'tile'}),
            'linear': this.material({geo_mode: 'linear', output_mode: 'tile'}),
            'flat': this.material({geo_mode: 'flat', output_mode: 'tile'}),
        },
    };
}
    
function MercatorRenderer(GL, $container, getViewportDims, extentN, extentS) {
    this.renderer = GL;
    this.glContext = this.renderer.getContext();

    this.curPole = null;

    // monkeypatch to support tex update sub-image
    var _setTexture = this.renderer.setTexture;
    this.renderer.setTexture = function(texture, slot) {
        if (texture.preUpdate) {
            texture.preUpdate();
        }

        _setTexture(texture, slot);
        
        if (texture.incrementalUpdate) {
            var renderer = this;
            var _gl = this.getContext();
            
            var glFormat = paramThreeToGL(texture.format, _gl);
            var glType = paramThreeToGL(texture.type, _gl);
            
            var first = true;
            var updatefunc = function(image, xoffset, yoffset) {
                if (first) {
                    // texture should already be bound from default setTexture behavior
                    _gl.pixelStorei(_gl.UNPACK_FLIP_Y_WEBGL, texture.flipY);
                    _gl.pixelStorei(_gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, texture.premultiplyAlpha);
                    first = false;
                }
                _gl.texSubImage2D(_gl.TEXTURE_2D, 0, xoffset, yoffset, glFormat, glType, image);
            };
            
            texture.incrementalUpdate(updatefunc);
        }
    }

    this.initViewport = function(dim, merc_min, merc_max, lon_center) {
        lon_center = lon_center == null ? .5 : lon_center;

        this.width_px = dim[0];
        this.height_px = dim[1];
        this.aspect = this.width_px / this.height_px;
        console.log('width', this.width_px, 'height', this.height_px, 'aspect', this.aspect);

        var extent = merc_max - merc_min;
        var vextent = extent / this.aspect;
        this.scale_px = this.width_px / extent;

        this.renderer.setSize(this.width_px, this.height_px);
        this.camera = new THREE.OrthographicCamera(0, this.width_px, this.height_px, 0, -1, 1);
        this.layer.onViewportSet();

        this.setWorldMatrix([
	        new THREE.Matrix4().makeTranslation(-.5 * vextent - lon_center, -merc_min, 0),
	        new THREE.Matrix4().makeRotationZ(-0.5 * Math.PI),
	        new THREE.Matrix4().makeScale(this.scale_px, this.scale_px, 1),
        ]);
    }
    
    this.init = function() {
        this.scene = new THREE.Scene();
        this.group = new THREE.Object3D();
        this.scene.add(this.group);
        this.currentObjs = [];
        this.layer = new TextureLayer(this);

        this.initViewport(getViewportDims(window), -extentS, extentN);
        var merc = this;
        $(window).resize(function() {
            var p0 = merc.xyToWorld(0, .5 * merc.height_px);
            var p1 = merc.xyToWorld(merc.width_px, 0);
            merc.initViewport(getViewportDims(window), p0.y, p1.y, p0.x);
        });
        $container.append(this.renderer.domElement);

        this.init_interactivity();
    }

    this.setLayer = function(layer) {
        this.layer.setLayer(layer);
    }

    this.setWorldMatrix = function(transformations, update) {
        if (update) {
            transformations.splice(0, 0, this.M);
        }
        this.M = _.reduceRight(transformations, function(memo, e) {
            return memo.multiply(e);
        }, new THREE.Matrix4());
        this.toWorld = new THREE.Matrix4().getInverse(this.M);

        this.group.matrix = this.M;
        this.group.matrixAutoUpdate = false;
        this.group.matrixWorldNeedsUpdate = true;

        // todo: set these to class vars -- i reference them everywhere
        var p0 = this.xyToWorld(0, .5 * this.height_px);
        var p1 = this.xyToWorld(this.width_px, 0);
        this.scale_px = this.width_px / (p1.y - p0.y);

        // constrain to limits
        var outofbounds = function(y) {
            var EPSILON = 1e-6;
            return y > MAX_MERC + EPSILON;
        }
        var corrections = [];
        if (outofbounds(p1.y) && outofbounds(-p0.y)) {
            var k = (p1.y - p0.y) / (2. * MAX_MERC);
            corrections.push(new THREE.Matrix4().makeScale(k, k, 1));
        } else if (outofbounds(p1.y)) {
            corrections.push(new THREE.Matrix4().makeTranslation(-this.scale_px * (MAX_MERC - p1.y), 0, 0));
        } else if (outofbounds(-p0.y)) {
            corrections.push(new THREE.Matrix4().makeTranslation(-this.scale_px * (-MAX_MERC - p0.y), 0, 0));
        } else if (Math.floor(p0.x) != 0) {
            // keep map center in the [0,1) coordinate range, both for sanity and preserving precision
            corrections.push(new THREE.Matrix4().makeTranslation(0, -this.scale_px * Math.floor(p0.x), 0));
        }
        // not sure that epsilon fuzziness above is enough to prevent infinite recursion
        _setWorldFailsafe = (window._setWorldFailsafe || 0) + 1;
        if (corrections.length && _setWorldFailsafe < 5) {
            this.setWorldMatrix(corrections, true);
        }
        _setWorldFailsafe--;
    }

    this.xyToWorld = function(x, y) {
        return new THREE.Vector3(x, y, 0).applyMatrix4(this.toWorld);
    }

    this.worldToXY = function(x, y) {
        return new THREE.Vector3(x, y, 0).applyMatrix4(this.M);
    }

    this.zoom = function(x, y, z) {
        // prevent zooming out beyond max extent -- setWorldMatrix would handle this but
        // it leads to an unsightly pan instead
        var p0 = this.xyToWorld(0, this.height_px);
        var p1 = this.xyToWorld(this.width_px, 0);
        z = Math.max(z, (p1.y - p0.y) / (2. * MAX_MERC));

        this.setWorldMatrix([
            new THREE.Matrix4().makeTranslation(-x, -y, 0),
            new THREE.Matrix4().makeScale(z, z, 1),
            new THREE.Matrix4().makeTranslation(x, y, 0),
        ], true);
    }

    this.warp = function(pos, drag_context) {
        var result = this._warp(pos, drag_context);
        this.curPole = result.pole;
        drag_context.down_mll[1] += result.residual;
        this.setWorldMatrix([new THREE.Matrix4().makeTranslation(0, result.residual / 360 * this.scale_px, 0)], true);
    }

    this._warp = function(pos, drag_context) {
        var merc = this.xyToWorld(pos.x, pos.y);
	    var merc_ll = xy_to_ll(merc.x, merc.y);

        var orig_bearing = bearing(drag_context.down_ll, drag_context.down_pole);
        var lon_diff = merc_ll[1] - drag_context.down_mll[1];
        var new_bearing = orig_bearing - lon_diff;
        var pole = line_plotter(drag_context.down_ll, new_bearing)((90 - merc_ll[0]) / DEG_RAD * EARTH_MEAN_RAD);

        var reverse_bearing = bearing(pole, drag_context.down_ll);
        if (reverse_bearing == null) {
            // drag point is now effectively the pole
            var residual = 0;
        } else {
            var residual = lon_norm((180 - reverse_bearing) - merc_ll[1])
        }
        return {pole: pole, residual: residual};
    }

    this.pan = function(pos, drag_context) {
        var delta = [pos.x - drag_context.last_px.x, pos.y - drag_context.last_px.y];
        this.setWorldMatrix([new THREE.Matrix4().makeTranslation(delta[0], delta[1], 0)], true);
    }

    this._drive = function(speed, heading) {
        this.setAnimationContext(new DrivingAnimationContext(this.curPole, speed, heading, this));
    }

    this.init_interactivity = function() {
        var mouse_pos = function(e) {
            var ref = $('#container')[0];
            return {x: e.pageX - ref.offsetLeft, y: ref.offsetHeight - 1 - (e.pageY - ref.offsetTop)};
        }
        this.inertia_context = new MouseTracker(.1);

	    var renderer = this;
        var drag_context = null;
        DRAGCTX = drag_context; // HACK
        $(this.renderer.domElement).bind('contextmenu', function(e) {
            return false;
        });
        var onDoubleRightClick = function(e) {
            //console.log('dblrightclick');
            var pos = mouse_pos(e);
            var merc = renderer.xyToWorld(pos.x, pos.y);
	        var merc_ll = xy_to_ll(merc.x, merc.y);
	        var coords = translate_pole(merc_ll, renderer.curPole);
            renderer.poleAt(coords[0], coords[1]);
        }
        $(this.renderer.domElement).bind('mousedown', function(e) {
            if (e.which == 3) {
                if (clock() - window.LAST_RIGHT_CLICK < .4) {
                    DBL_RIGHT_CLICK = true;
                }
                LAST_RIGHT_CLICK = clock();
            }
            //console.log('mousedown', e.which);
            if (drag_context != null) {
                return;
            }

            drag_context = {
		        'down_px': mouse_pos(e),
		        'down_pole': renderer.curPole,
	        };
            DRAGCTX = drag_context; // HACK
            renderer.inertia_context.addSample([drag_context.down_px.x, drag_context.down_px.y]);
            renderer.setAnimationContext(null);

            var merc = renderer.xyToWorld(drag_context.down_px.x, drag_context.down_px.y);
	        var merc_ll = xy_to_ll(merc.x, merc.y);
            drag_context.down_mll = merc_ll;
	        drag_context.down_ll = translate_pole(merc_ll, drag_context.down_pole);
            drag_context.last_px = drag_context.down_px;
            
            drag_context.mode = (e.which == 3 || e.shiftKey ? 'warp' : 'pan');
        });
        $(document).bind('mousemove', function(e) {
	        var pos = mouse_pos(e);
            //console.log('mousemove', pos.x, pos.y);
            POS = pos;
            renderer.inertia_context.addSample([pos.x, pos.y]);

            /*
            $("#mouseinfo").css({
                top: (e.pageY + 15) + "px",
                left: (e.pageX + 15) + "px"
            });
            */

            if (drag_context == null) {
                return;
            }
            
            renderer[drag_context.mode](pos, drag_context);
            drag_context.last_px = pos;
        });
        $(document).bind('mouseup', function(e) {
            //console.log('mouseup', e.which);
            if (drag_context != null) {
	            var pos = mouse_pos(e);
                var pos = [pos.x, pos.y];
                var velocity = renderer.inertia_context.getSpeed();
                if (vlen(velocity) > 0) {
                    renderer.setAnimationContext(new InertialAnimationContext(pos, velocity, 3, drag_context, function(pos, drag_context) {
                        renderer[drag_context.mode](pos, drag_context);
                    }, renderer));
                }
                drag_context = null;
                DRAGCTX = drag_context; // HACK
            }

            if (e.which == 3 && window.DBL_RIGHT_CLICK) {
                onDoubleRightClick(e);
                DBL_RIGHT_CLICK = false;
            }
        });
        $(document).bind('mouseout', function(e) {
            if (e.relatedTarget != null) {
                // not a 'window leave' event
                return;
            }

            POS = null;
        });
        $(this.renderer.domElement).bind('dblclick', function(e) {
            //console.log('dblclick');
            if (e.shiftKey) {
                onDoubleRightClick(e);
                return;
            }

            var pos = mouse_pos(e);
            renderer.setAnimationContext(new ZoomAnimationContext(pos, 3, 1.5, function(x, y, z) {
                renderer.zoom(x, y, z);
            }));
        });
        
        $(this.renderer.domElement).bind('mousewheel wheel', function(e) {
            e = e.originalEvent;
            var pos = mouse_pos(e);
            // TODO think i need to normalize this more (mac uses a different scale?)
            var delta = (e.wheelDelta ? e.wheelDelta / 120.
                                      : e.deltaY / -3.);
            
            renderer._numScrollEvents++;

            // for now, don't provide any scroll momentum -- assume any momentum
            // is already provided at the hardware level

            // NOTE: firefox seems to fire off many more interim scroll events--
            // would be less expensive to accumulate total scroll then apply one
            // transform per frame rather than per event. but firefox already runs
            // this like a dog anyway, so not going to worry
            renderer.zoom(pos.x, pos.y, Math.pow(1.05, delta));
            return false;
        });
    }

    this.setAnimationContext = function(animctx) {
        this.applyAnimationContext();
        this.animation_context = animctx;
    }

    this.applyAnimationContext = function() {
        if (this.animation_context) {
            this.animation_context.apply();
            if (this.animation_context.finished()) {
                this.animation_context = null;
            }
        }
    }

    this.max_zoom_for_time_horizon = function(interval) {
        // ensure pole is up to date, accounting for delay of tile sampling
        this.applyAnimationContext();
        var futurePole = this.poleInFuture(interval);
        return max_z_overlap(this.curPole[0], distance(this.curPole, futurePole),
                             this.scale_px, this.overzoom - .5 * this.zoom_blend);
    }

    this.poleInFuture = function(interval) {
        var futurepole = null;
        if (this.animation_context) {
            futurepole = this.animation_context.poleAtT(clock() + interval);
        } else if (DRAGCTX && DRAGCTX.mode == 'warp') {
            var pos = DRAGCTX.last_px;
            pos = [pos.x, pos.y];
            var vel = this.inertia_context.getSpeed();
            var futurepos = vadd(pos, vscale(vel, interval));
            futurepole = this._warp({x: futurepos[0], y: futurepos[1]}, DRAGCTX).pole;
        } 
        return futurepole || this.curPole
    }

    var _interp = function(a, b, k) {
        return (1. - k) * a + k * b;
    }
    var computeTex = function(x, y, offset, pole) {
        var merc_ll = xy_to_ll(x, y);
        var ll = translate_pole(merc_ll, pole);
        var r = ll_to_xy(ll[0], ll[1]);
        return [unwraparound(offset.x, r.x), r.y];
    }
    var MIN_CELL_SIZE = 32;
    this.linearInterp = function(x0, x1, y0, y1, offset) {
        var buf = [];
        if (y0 < y1) {
            var renderer = this;
            mp = _.map([[x0, y0], [x1, y0], [x0, y1], [x1, y1]], function(e) {
                return computeTex(e[0], e[1], offset, renderer.curPole);
            });

            this._linearInterp(buf, offset, x0, x1, y0, y1, mp);
        }
        return buf;
    }
    this._linearInterp = function(buf, offset, x0, x1, y0, y1, mp) {
        var width = (y1 - y0);
        var height = (x1 - x0);
        var min_cell_size = 2. * MIN_CELL_SIZE / this.scale_px;
        var terminal = width <= min_cell_size && height <= min_cell_size;

        if (!terminal) {
            var uv_interp = [_interp(mp[0][0], mp[3][0], .5),
                             _interp(mp[0][1], mp[3][1], .5)];
            var p_center = [_interp(x0, x1, .5), _interp(y0, y1, .5)];

            var a = xy_to_ll(uv_interp[0], .5 - uv_interp[1]);
            var b = inv_translate_pole(a, this.curPole);
            var c = ll_to_xy(b[0], b[1]);
            var d = [c.x, .5 - c.y];
            var diff = [wraparound_diff(p_center[0] - d[0]), p_center[1] - d[1]];
            var error = Math.sqrt(Math.pow(diff[0], 2) + Math.pow(diff[1], 2)) * this.scale_px;

            terminal = (error < APPROXIMATION_THRESHOLD);
        }

        if (terminal) {
            var tex = _.map(mp, function(k) { return [k[0] - offset.x, k[1] - offset.y]; });
            buf.push({x0: x0, y0: y0, x1: x1, y1: y1, tex: tex});
        } else {
            var xcenter = _interp(x0, x1, .5);
            var ycenter = _interp(y0, y1, .5);

            if (height / width > Math.sqrt(2.)) {
                var texleft = computeTex(xcenter, y0, offset, this.curPole);
                var texright = computeTex(xcenter, y1, offset, this.curPole);
                this._linearInterp(buf, offset, x0, xcenter, y0, y1, [mp[0], texleft, mp[2], texright]);
                this._linearInterp(buf, offset, xcenter, x1, y0, y1, [texleft, mp[1], texright, mp[3]]);
            } else if (width / height > Math.sqrt(2.)) {
                var textop = computeTex(x0, ycenter, offset, this.curPole);
                var texbottom = computeTex(x1, ycenter, offset, this.curPole);
                this._linearInterp(buf, offset, x0, x1, y0, ycenter, [mp[0], mp[1], textop, texbottom]);
                this._linearInterp(buf, offset, x0, x1, ycenter, y1, [textop, texbottom, mp[2], mp[3]]);
            } else {
                var texleft = computeTex(xcenter, y0, offset, this.curPole);
                var texright = computeTex(xcenter, y1, offset, this.curPole);
                var textop = computeTex(x0, ycenter, offset, this.curPole);
                var texbottom = computeTex(x1, ycenter, offset, this.curPole);
                var texcenter = computeTex(xcenter, ycenter, offset, this.curPole);
                this._linearInterp(buf, offset, x0, xcenter, y0, ycenter, [mp[0], texleft, textop, texcenter]);
                this._linearInterp(buf, offset, x0, xcenter, ycenter, y1, [textop, texcenter, mp[2], texright]);
                this._linearInterp(buf, offset, xcenter, x1, y0, ycenter, [texleft, mp[1], texcenter, texbottom]);
                this._linearInterp(buf, offset, xcenter, x1, ycenter, y1, [texcenter, texbottom, texright, mp[3]]);
            }
        }
    }
    
    this.makeQuad = function(geo_mode, max) {
        var grid = new GridGeometry(max || 1);
        var plane = new THREE.Mesh(grid, this.layer._materials['image'][geo_mode]);
        plane.frustumCulled = false;
        plane.geo_mode = geo_mode;
        plane.update = function(x0, x1, y0, y1, tex) {
            grid.setQuad(0, x0, x1, y0, y1, tex);
        };
        plane.updateAll = function(data) {
            for (var i = 0; i < data.length; i++) {
                var q = data[i];
                grid.setQuad(i, q.x0, q.x1, q.y0, q.y1, q.tex);
            }
            grid.clearQuads(data.length);
        };
        this.group.add(plane);
        this.currentObjs.push(plane);
        return plane;
    }

    this.makeLine = function(color) {
        line = new THREE.Geometry();
        line.vertices.push(new THREE.Vector3(0, 0, -1));
        line.vertices.push(new THREE.Vector3(0, 0, -1));
        this.group.add(new THREE.Line(line, new THREE.LineBasicMaterial({
            color: color,
            opacity: .6,
            linewidth: 2,
            transparent: true
        })));
        return line;
    }

    this.hideLines = function() {
        this.vline.vertices[0] = new THREE.Vector3(0, 0, -1);
        this.vline.vertices[1] = new THREE.Vector3(0, 0, -1);
        this.vline.verticesNeedUpdate = true;
        this.hline.vertices[0] = new THREE.Vector3(0, 0, -1);
        this.hline.vertices[1] = new THREE.Vector3(0, 0, -1);
        this.hline.verticesNeedUpdate = true;
    }

    this.render = function(timestamp) {
        var renderer = this;

        this.applyAnimationContext();
        
        if (!this.currentObjs.length) {
            this.qPolar = this.makeQuad('flat');
            this.qPolarAnti = this.makeQuad('flat');
            this.qLinear = this.makeQuad('linear', 1024);
            this.qLinearAnti = this.makeQuad('linear', 1024);
            this.qGooeyMiddle = this.makeQuad('sphere');

            this.vline = this.makeLine(0x00aaff);
            this.hline = this.makeLine(0xff0000);
        }

        this.setPole(this.curPole[0], this.curPole[1]);
        this.setRefPoint();
        this.setUniforms();
        
        var debug = {};
        if (window.POS) {
            $('#mouseinfo').css('top', 0);

            var p = renderer.xyToWorld(POS.x, POS.y);
            var merc_ll = xy_to_ll(mod(p.x, 1.), p.y);
            var ll = translate_pole(merc_ll, renderer.curPole);

            var xy_prec = prec_digits_for_res(1. / this.scale_px);
            debug.merc_xy = p.x.toFixed(xy_prec) + ' ' + p.y.toFixed(xy_prec);
            var mercllfmt = fmt_pos(merc_ll, 5);
            debug.merc_ll = mercllfmt.lat + ' ' + mercllfmt.lon;

            var dist = EARTH_MEAN_RAD * Math.PI / 180. * (90. - merc_ll[0]);
            var bearing = mod(180. - merc_ll[1], 360.);
            var scale = 2 * Math.PI / renderer.scale_px * Math.cos(merc_ll[0] * Math.PI / 180.) * EARTH_MEAN_RAD;
            var orient = line_plotter(this.curPole, bearing)(dist, true).heading;

            var posfmt = fmt_pos(ll, 5);
            $('#mouseinfo #pos').text(posfmt.lat + ' ' + posfmt.lon);
            if (METRIC) {
                unit = dist < 1000 ? 'm' : 'km';
            } else {
                unit = dist < geomean(2000, 'ft', 1, 'mi') ? 'ft' : 'mi';
            }
            $('#mouseinfo #dist').text(format_with_unit(dist, scale, unit));
            var bearing_prec = prec_digits_for_res(360. / this.scale_px);
            var bearing_cardinal = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][mod(Math.floor(bearing / 45. + .5), 8)];
            $('#mouseinfo #bearing').text(npad(bearing.toFixed(bearing_prec), bearing_prec + 3 + (bearing_prec > 0 ? 1 : 0)) + '\xb0 (' + bearing_cardinal + ')');
            $('#orient img').css('transform', 'rotate(' + (270 - orient) + 'deg)');
            var scalebar = snap_scale(scale, 33);
            $('#mouseinfo #scale #label').text(scalebar.label);
            $('#mouseinfo #scale #bar').css('width', scalebar.size + 'px');

            if (window.COMPANION) {
                var tf = this.layer.curlayer.tilefunc;
                delete this.layer.curlayer.tilefunc;
                COMPANION.postMessage({
                    pole: this.pole,
                    layer: this.layer.curlayer,
                    dist: dist,
                    bearing: bearing,
                }, '*');
                this.layer.curlayer.tilefunc = tf;

                this.vline.vertices[0] = new THREE.Vector3(-10, p.y, .1);
                this.vline.vertices[1] = new THREE.Vector3(10, p.y, .1);
                this.vline.verticesNeedUpdate = true;
                this.hline.vertices[0] = new THREE.Vector3(p.x, p.y, .1);
                this.hline.vertices[1] = new THREE.Vector3(p.x, MAX_MERC, .1);
                this.hline.verticesNeedUpdate = true;
            } else {
                this.hideLines();
            }
        } else {
            $('#mouseinfo').css('top', -1000);
            this.hideLines();

            if (window.COMPANION) {
                var tf = this.layer.curlayer.tilefunc;
                delete this.layer.curlayer.tilefunc;
                COMPANION.postMessage({
                    pole: this.pole,
                    layer: this.layer.curlayer,
                    dist: null,
                    bearing: null,
                }, '*');
                this.layer.curlayer.tilefunc = tf;
            }
        }

        var p0 = renderer.xyToWorld(0, this.height_px);
        var p1 = renderer.xyToWorld(this.width_px, 0);
        var xtop = p0.x;
        var xbottom = p1.x;
        var yleft = p0.y;
        var yright = p1.y;

        var low_prec_cutoff_latrad = Math.acos(Math.min(this.scale_px / Math.pow(2., 23. - PREC_BUFFER), 1.));
        // merc-y cutoff beyond which we must mitigate lack of shader precision
        var low_prec_cutoff = .5 - ll_to_xy(low_prec_cutoff_latrad * 180. / Math.PI, 0).y;

        var absy_min = ((yleft < 0) && (yright > 0) ? 0 : Math.min(Math.abs(yleft), Math.abs(yright)));
        var absy_max = Math.min(Math.max(Math.abs(yleft), Math.abs(yright)), 5.); // cap due to asympote issues
        // merc-y cutoff below which a flat-earth approximation is too crude
        var flat_earth_cutoff = solve_eq(absy_min, absy_max, 1. / this.scale_px, function(x) {
            var lat = xy_to_ll(0, x)[0];
            return flat_earth_error_px(lat, renderer.scale_px, renderer.curPole[0]) < APPROXIMATION_THRESHOLD;
        });
        flat_earth_cutoff = Math.max(flat_earth_cutoff, low_prec_cutoff);

        this.qPolarAnti.update(xtop, xbottom, yleft, -flat_earth_cutoff);
        this.qLinearAnti.updateAll(this.linearInterp(
            xtop,
            xbottom,
            Math.max(-flat_earth_cutoff, p0.y),
            Math.min(-low_prec_cutoff, p1.y),
            this.hp_anti_ref_t));
        this.qGooeyMiddle.update(xtop, xbottom, -low_prec_cutoff, low_prec_cutoff);
        this.qLinear.updateAll(this.linearInterp(
            xtop,
            xbottom,
            Math.max(low_prec_cutoff, p0.y),
            Math.min(flat_earth_cutoff, p1.y),
            this.hp_ref_t));
        this.qPolar.update(xtop, xbottom, flat_earth_cutoff, yright);

        this.layer.handlePending();
        this.renderer.render(this.scene, this.camera);

        var setMaterials = function(output_mode) {
            $.each(renderer.currentObjs, function(i, e) {
                e.material = renderer.layer._materials[output_mode][e.geo_mode];
            });
        }

        if (!this.sampling_in_progress && (this.last_sampling == null || timestamp - this.last_sampling > 1./SAMPLE_TIME_FREQ)) {
            this.sampling_in_progress = true;
            setMaterials('sampler');
            this.layer.sample_coverage(function() {
                renderer.sampling_in_progress = false;
                renderer.last_sampling = clock();
            });
            setMaterials('image');
        }

        DEBUG.postMessage({type: 'frame'}, '*');
        DEBUG.postMessage({type: 'text', data: debug}, '*');

        // just out of curiosity
        if (this._numScrollEvents > 3) {
            console.log(this._numScrollEvents + ' since last frame');
        }
        this._numScrollEvents = 0;
    }

    this.setUniforms = function() {
        this.layer.uniforms.scale.value = this.scale_px;
        this.layer.uniforms.bias.value = this.overzoom;
        this.layer.uniforms.zoom_blend.value = this.zoom_blend;
        this.layer.uniforms.blinder_opacity.value = this.blinder_opacity;

        var p0 = this.xyToWorld(0, 0);
        var p1 = this.xyToWorld(0, this.height_px);
        this.layer.uniforms.blinder_start.value = .5 * (p0.x + p1.x - 1);
    }
    
    this.setPole = function(lat, lon) {
        lon = lon_norm(lon);

        if (!this.pole || lat != this.pole[0] || lon != this.pole[1]) {
            var polefmt = fmt_pos(this.curPole, 5);
            $('#poleinfo .data').text(polefmt.lat + ' ' + polefmt.lon);
            var antipolefmt = fmt_pos(antipode(this.curPole), 5);
            $('#antipoleinfo .data').text(antipolefmt.lat + ' ' + antipolefmt.lon);
        }

        this.pole = [lat, lon];
        this.pole_t = ll_to_xy(lat, lon);
        this.layer.uniforms.pole.value = new THREE.Vector2(lon, lat);
        this.layer.uniforms.pole_t.value = new THREE.Vector2(this.pole_t.x, this.pole_t.y);

        var hp_x = hp_split(this.pole_t.x);
        var hp_y = hp_split(this.pole_t.y);
        this.layer.uniforms.hp_pole_tile.value = new THREE.Vector2(hp_x.coarse, hp_y.coarse);
        this.layer.uniforms.hp_pole_offset.value = new THREE.Vector2(hp_x.fine, hp_y.fine);
    };
    
    this.setRefPoint = function() {
        var renderer = this;
        var snapToSinglePrecision = function(k) {
            return Math.round(k * Math.pow(2, 23)) * Math.pow(2, -23);
        }
        var refPoint = function(lo) {
            var merc = renderer.xyToWorld(lo ? 0 : renderer.width_px, 0.5 * renderer.height_px);
            var merc_ll = xy_to_ll(merc.x, merc.y);
            var ll = translate_pole(merc_ll, renderer.pole);
            var xy = ll_to_xy(ll[0], ll[1]);
            // the shader only has single precision -- ensure we use the exact same value there
            // and in coverage worker, or else we get off-by-one errors in the tile index when
            // pole lon exactly on a tile boundary
            return {x: snapToSinglePrecision(xy.x), y: snapToSinglePrecision(xy.y)};
        }

        this.ref_t = refPoint(false);
        this.layer.uniforms.ref_t.value = new THREE.Vector2(this.ref_t.x, this.ref_t.y);
        this.anti_ref_t = refPoint(true);
        this.layer.uniforms.anti_ref_t.value = new THREE.Vector2(this.anti_ref_t.x, this.anti_ref_t.y);

        var hp_ref_x = hp_split(this.ref_t.x);
        var hp_ref_y = hp_split(this.ref_t.y);
        var hp_antiref_x = hp_split(this.anti_ref_t.x);
        var hp_antiref_y = hp_split(this.anti_ref_t.y);
        this.hp_ref_t = {x: hp_ref_x.coarse, y: hp_ref_y.coarse};
        this.hp_anti_ref_t = {x: hp_antiref_x.coarse, y: hp_antiref_y.coarse};
        this.layer.uniforms.hp_ref_tile.value = new THREE.Vector2(this.hp_ref_t.x, this.hp_ref_t.y);
        this.layer.uniforms.hp_antiref_tile.value = new THREE.Vector2(this.hp_anti_ref_t.x, this.hp_anti_ref_t.y);
    }
    
    this.start = function() {
        var merc = this;
        renderLoop(function(t) { merc.render(t); });
    }
    

    this.poleAt = function(lat, lon, args) {
        args = args || {};
        if (args.duration === 0) {
            this.setAnimationContext(null);
            this.curPole = [lat, lon];
            this.last_sampling = null;
            var dlon = (args.target_heading - args.start_heading) || 0;
            if (dlon != 0) {
                this.setWorldMatrix([new THREE.Matrix4().makeTranslation(0, -dlon / 360 * this.scale_px, 0)], true);
            }
            // TODO support extentS
        } else {
            var curHeight = this.xyToWorld(0, 0).x - this.xyToWorld(0, this.height_px).x;
            var curRight = this.xyToWorld(this.width_px, 0).y;
            var targetHeight = (MAX_MERC + (args.extentS || DEFAULT_EXTENT_S)) / this.aspect;
            var finalHeight = Math.max(curHeight, targetHeight);
            var zoom = finalHeight / curHeight;
            var dhoriz = MAX_MERC - curRight;
            var _ratio = dhoriz / (finalHeight / curHeight - 1);
            var x0 = this.width_px - _ratio * this.scale_px;
            var y0 = this.height_px * .5;

            var that = this;
            this.setAnimationContext(new GoToAnimationContext(this.curPole, [lat, lon], function(p, dh, dt_viewport) {
                that.curPole = p;
                transforms = [];
                transforms.push(new THREE.Matrix4().makeTranslation(0, -dh / 360 * that.scale_px, 0));

                if (Math.abs(zoom - 1) > 1e-9) {
                    var z = Math.pow(zoom, -dt_viewport);
                    transforms.push(new THREE.Matrix4().makeTranslation(-x0, -y0, 0));
                    transforms.push(new THREE.Matrix4().makeScale(z, z, 1));
                    transforms.push(new THREE.Matrix4().makeTranslation(x0, y0, 0));
                } else {
                    transforms.push(new THREE.Matrix4().makeTranslation(dt_viewport * -dhoriz * that.scale_px, 0, 0));
                }

                that.setWorldMatrix(transforms, true);
            }, args));
        }
    }

    this.swapPoles = function() {
        var pole = antipode(this.curPole);
        this.poleAt(pole[0], pole[1], {duration: 2});
    }

    this.init();
}

function hp_split(val) {
    var hp_extent = Math.pow(2., HIGH_PREC_Z_BASELINE);
    var primary = Math.floor(val * hp_extent) / hp_extent;
    var remainder = val - primary;
    return {coarse: primary, fine: remainder};
}

// return max z-level for which tiles may still be in view after
// moving 'distance' away
// positive zoom_bias moves a zoom level's range of view towards the pole
// this is mostly black magic
function max_z_overlap(pole_lat, dist, scale, zoom_bias) {
    var bias = log2(scale / 256) - zoom_bias;
    var lg2dist = log2(dist);

    if (Math.abs(pole_lat) > 85) {
        base_z = MAX_ZOOM;
    } else {
        base_z = Math.max(24.8 - lg2dist + log2(Math.cos(pole_lat / DEG_RAD)), 3);
    }
    return Math.ceil(base_z + Math.max(bias, 0));
}

function load_image(layer, tile, onload) {
    if (tile.z == 0 && layer.no_z0) {
        load_image_bing_hack(layer, onload);
        return;
    }

    var img = new Image();
    img.onload = function() { onload(img); };
    img.onerror = function() { onload(null); }; // 404 or CORS denial
    img.crossOrigin = 'anonymous';
    img.src = layer.tilefunc(tile.z, tile.x, tile.y);
}

function load_image_bing_hack(layer, onload) {
    var num_loaded = 0;
    var num_errors = 0;
    var c = mk_canvas(TILE_SIZE, TILE_SIZE);

    var mk_onload = function(x, y) {
        return function(img) {
            num_loaded++;
            if (img != null) {
                c.context.drawImage(img, x * .5*TILE_SIZE, y * .5*TILE_SIZE, .5*TILE_SIZE, .5*TILE_SIZE);
            } else {
                num_errors++;
            }
            if (num_loaded == 4) {
                if (num_errors == 4) {
                    onload(null);
                } else {
                    onload(c.canvas);
                }
            }
        }
    };

    for (var i = 0; i < 2; i++) {
        for (var j = 0; j < 2; j++) {
            load_image(layer, {z: 1, x: i, y: j}, mk_onload(i, j));
        }
    }
}

function EMViewModel(merc) {
    var that = this;

    this.layers = ko.observableArray();
    this.activeLayer = ko.observable();
    this.pendingLayer = ko.observable();

    this.places = ko.observableArray();

    this.units = ko.observableArray(['metric', 'imperial']);
    this.active_unit = ko.observable();
    this.active_unit.subscribe(function(val) {
        METRIC = (val == 'metric');
    });

    this.load = function(layers, places) {
        var custom_layers = JSON.parse(localStorage.custom_layers || '[]');
        _.each(custom_layers, function(e) { e.custom = true; });
        layers = layers.concat(custom_layers);

        this.layers(_.map(layers, function(e) { return new LayerModel(e, merc, that); }));
        this.selectLayer(this.layers()[0]);

        this.places(_.map(places, function(e) { return new PlaceModel(e, merc); }));
        var current = new PlaceModel({name: 'Current Location', geoloc: true}, merc);
        current.origselect = current.select;
        current.select = function() {
            navigator.geolocation.getCurrentPosition(function(position) {
                current.pos = [position.coords.latitude,
                               position.coords.longitude];
                current.origselect();
            }, function(err) {
                alert('could not get location');
            });
        };
        this.places.splice(0, 0, current);

        this.active_unit(this.units()[0]);
    }

    that.selectLayer = function(layer) {
        if (that.activeLayer()) {
            that.activeLayer().active(false);
        };
        layer.activate();
        that.activeLayer(layer);
    }

    that.removeLayer = function(layer) {
        that.layers.remove(layer);
        that.saveAll();
    }

    this.curAttr = ko.computed(function() {
        return this.activeLayer() ? this.activeLayer().attribution() : '';
    }, this);

    this.newPendingLayer = function() {
        this.pendingLayer(new LayerModel({custom: true}, merc, this));
    }

    this.commitPending = function(layer) {
        if (layer.url()) {
            this.layers.push(layer);
            this.selectLayer(layer);
        }
    }

    this.editContext = function() {
        return new LayerEditContextModel(that, that, {
            field: 'pendingLayer',
            oncommit: 'commitPending',
            commitCaption: 'add',
        });
    }

    this.saveAll = function() {
        var layersToSave = _.map(_.filter(this.layers(), function(e) { return e.custom(); }), function(e) {
            var o = {};
            _.each(e.CUSTOM_FIELDS, function(f) {
                o[f] = e[f]();
            });
            return o;
        });
        localStorage.custom_layers = JSON.stringify(layersToSave);
    }

    this.toggleUnit = function(val) {
        that.active_unit(that.units()[(that.units().indexOf(that.active_unit()) + 1) % that.units().length]);
    }
}

function LayerEditContextModel(root, base, data) {
    var ec = this;
    this.layer = ko.observable(base[data.field]());
    this.commit = function() {
        base[data.oncommit](ec.layer());
        this.cancel();
        root.saveAll();
    }
    this.commitCaption = ko.observable(data.commitCaption);
    this.cancel = function() {
        base[data.field](null);
    }
}

function MouseTracker(window) {
    this.samples = [];
    
    this.purgeSamples = function(t) {
        // remove all samples older than the first one outside the window
        for (var i = 0; i < this.samples.length; i++) {
            if (this.samples[i].t < t - window) {
                break;
            }
        }
        this.samples.splice(i + 1, this.samples.length - (i + 1));
    }

    this.addSample = function(p) {
        var t = clock();
        this.purgeSamples(t);
        this.samples.splice(0, 0, {p: p, t: t});
    }

    this.getSpeed = function() {
        var t = clock();
        this.purgeSamples(t);
        var earliest = this.samples[0];
        var latest = this.samples.slice(-1)[0];
        if (earliest == null || t - earliest.t >= window || earliest.t == latest.t) {
            return [0, 0];
        } else if (t - latest.t < window) {
            var start = latest.p;
            var delta_t = t - latest.t;
        } else {
            var latest_in_window = this.samples.slice(-2, -1)[0];
            var k = (window - (t - latest_in_window.t)) / (latest_in_window.t - latest.t);
            var start = vadd(vscale(latest_in_window.p, 1 - k), vscale(latest.p, k));
            var delta_t = window;
        }
        return [(earliest.p[0] - start[0]) / delta_t,
                (earliest.p[1] - start[1]) / delta_t];
    }
}

function InertialAnimationContext(p0, v0, friction, drag_context, transform, renderer) {
    this.t0 = clock();

    var end_pos = vadd(p0, vscale(v0, 1. / friction));

    this.pos = function(clock_t) {
        var t = clock_t - this.t0;
        var k = (1. - Math.exp(-friction * t)) / friction;
        return vadd(p0, vscale(v0, k));
    }

    this.apply = function() {
        var pos = this.pos(clock());
        var pos = {x: pos[0], y: pos[1]};
        transform(pos, drag_context);
        drag_context.last_px = pos;
    }

    this.getSpeed = function() {
        var t = clock() - this.t0;
        var mouse_speed = vlen(v0) * Math.exp(-friction * t);
        var pos = this.pos(clock());

        if (drag_context.mode == 'pan') {
            return 0;
        } else if (drag_context.mode == 'warp') {
            var merc = renderer.xyToWorld(pos[0], pos[1]);
	        var merc_ll = xy_to_ll(merc.x, merc.y);
            var res = 2 * Math.PI / renderer.scale_px * Math.cos(merc_ll[0] / DEG_RAD);
            return mouse_speed * res * EARTH_MEAN_RAD;
        }
    }
    this.poleAtT = function(clock_t) {
        if (drag_context.mode == 'pan') {
            return null;
        } else if (drag_context.mode == 'warp') {
            var pos = this.pos(clock_t);
            return renderer._warp({x: pos[0], y: pos[1]}, drag_context).pole;
        }
    }

    this.finished = function() {
        return vlen(vdiff(end_pos, this.pos(clock()))) < .25;
    }
}

function ZoomAnimationContext(p, zdelta, period, transform) {
    this.t0 = clock();

    this.cur_k = function() {
        var t = clock() - this.t0;
        var k = logistic(8*(t / period - .5), zdelta);
        return k;
    }

    this.apply = function() {
        var k = this.cur_k();
        var dk = k - (this.last_k || 0);
        transform(p.x, p.y, Math.pow(2, dk));
        this.last_k = k;
    }

    this.getSpeed = function() {
        return 0;
    }
    this.poleAtT = function(clock_t) {
        return null;
    }

    this.finished = function() {
        return (clock() - this.t0) > period;
    }
}

function logistic(x, k) {
    k = k || 1.;
    return k / (1 + Math.exp(-x));
}

function dlogistic(x, k) {
    k = k || 1.;
    return k * Math.exp(-x) / Math.pow(1 + Math.exp(-x), 2);
}

function goto_parameters(dist, v0) {
    // find the necessary scaling for the logistic function such that the distance
    // covered between the two points where v=v0 is our required distance
    var yscale = solve_eq(Math.max(dist, 4*v0), dist + 4*v0, .01, function(k) {
        var _d = k - 4*k*v0 / (k + Math.sqrt(k*k - 4*k*v0));
        return _d > dist;
    });
    // find the coordinate where v=v0
    var xmax = Math.log((yscale + Math.sqrt(yscale*yscale - 4*yscale*v0)) / (2*v0) - 1);
    var y0 = logistic(-xmax, yscale);
    return {yscale: yscale, xmax: xmax, y0: y0};
}

function GoToAnimationContext(start, end, transform, args) {
    this.t0 = clock();

    this.duration = args.duration || 5.;
    this.v0 = args.v0 || 2.;

    var dist = distance(start, end);
    var init_heading = bearing(start, end);
    var plotter = line_plotter(start, init_heading);
    var end_heading = plotter(dist, true).heading;

    if (args.target_heading != null && args.start_heading != null) {
        this.heading_change = lon_norm((args.target_heading - end_heading) - (args.start_heading - init_heading));
    } else {
        this.heading_change = 0;
    }

    var params = goto_parameters(dist, this.v0);
    var period = this.duration * params.xmax / goto_parameters(Math.PI * EARTH_MEAN_RAD, this.v0).xmax;
    var zoomoutperiod = .5;

    this.last_heading = init_heading;
    this.last_k = {pole: 0, viewport: 0};

    this.k = function(clock_t) {
        var t = Math.min(clock_t - this.t0, period);
        var x = 2 * params.xmax * (t / period - .5);

        var pole_k = logistic(x, params.yscale) - params.y0;
        var viewport_k = logistic(8*(t / zoomoutperiod - .5));

        return {pole: pole_k, viewport: viewport_k};
    }

    this.apply = function() {
        var k = this.k(clock());
        var p = plotter(k.pole, true);
        var dh = (p.heading - this.last_heading) + (k.pole - this.last_k.pole) / params.yscale * this.heading_change;
        transform(p.p, dh, k.viewport - this.last_k.viewport);
        this.last_k = k;
        this.last_heading = p.heading;
    }

    this.getSpeed = function() {
        var t = Math.min(clock() - this.t0, period);
        var x = 2 * params.xmax * (t / period - .5);
        return dlogistic(x, params.yscale);
    }

    this.poleAtT = function(clock_t) {
        return plotter(this.k(clock_t).pole);
    }

    this.finished = function() {
        var t = clock() - this.t0;
        return (t > period && t > zoomoutperiod);
    }
}

function DrivingAnimationContext(start, speed, heading, merc) {
    this.t0 = clock();

    var plotter = line_plotter(start, heading);

    this.apply = function() {
        var t = clock() - this.t0;
        merc.curPole = plotter(speed * t);
    }

    this.getSpeed = function() {
        return speed;
    }

    this.poleAtT = function(clock_t) {
        var t = clock_t - this.t0;
        return plotter(speed * t);
    }

    this.finished = function() {
        return false;
    }
}

function LayerModel(data, merc, root) {
    var that = this;

    this.setID = function() {
        this.id = Math.floor(Math.random()*Math.pow(2, 32)).toString(16);
    }
    this.setID();
    this.attr = data.attr;
    this.no_z0 = data.no_z0;

    this.url = ko.observable(data.url);
    this.name = ko.observable(data.name);
    this.max_depth = ko.observable(data.max_depth);
    this.custom = ko.observable(data.custom);
    this.active = ko.observable(false);

    this.pending = ko.observable(false);

    this.tilefunc = ko.computed(function() {
        return this.url() ? compile_tile_spec(this.url()) : null;
    }, this);
    this.attribution = ko.computed(function() {
        return '&copy; ' + _.map(this.attr, function(e) {
            if (typeof e == 'string') {
                return e;
            } else {
                return '<a target="_blank" href="' + e[1] + '">' + e[0] + '</a>';
            }
        }).join(', ');
    }, this);
    this.displayName = ko.computed(function() {
        return this.name() || '\u2014custom layer\u2014';
    }, this);

    this.preview_url = ko.observable();
    this.preview_status = ko.observable();
    this.tilefunc.subscribe(function(val) {
        that.preview_status('loading');
        that.preview_url(val(0, 0, 0));
        var img = new Image();
        img.onload = function() {
            that.preview_status('success');
        };
        img.onerror = function() {
            that.preview_status('error');
        };
        img.src = that.preview_url();
    });

    this.activate = function(force) {
        if (this.active() && !force) {
            return;
        }
        this.active(true);
        merc.setLayer(this.to_obj());
    }

    this.to_obj = function() {
        return {
            id: this.id,
            url: this.url(),
            tilefunc: this.tilefunc(),
            max_depth: this.max_depth(),
            no_z0: this.no_z0,
        };
    }

    this.CUSTOM_FIELDS = ['name', 'url', 'max_depth'];
    this.edit = function() {
        this.pending(new LayerModel({}));
        _.each(this.CUSTOM_FIELDS, function(e) {
            that.pending()[e](that[e]());
        });
    }

    this.save = function(layer) {
        _.each(this.CUSTOM_FIELDS, function(e) {
            that[e](layer[e]());
        });

        this.setID(); // invalidate any tiles loaded already
        if (this.active()) {
            this.activate(true);
        }
    }

    this.editContext = function() {
        return new LayerEditContextModel(root, that, {
            field: 'pending',
            oncommit: 'save',
            commitCaption: 'save',
        });
    }
}

function PlaceModel(data, merc) {
    this.name = ko.observable(data.name);
    this.pos = data.pos;
    this.lon_center = data.lon_center;
    this.antipode = data.antipode;
    this.byline = ko.observable(data.desc);
    this.geoloc = ko.observable(data.geoloc);
    this.default = data.default;

    this.select = function() {
        this._select();
    }

    this._select = function(hard) {
        var args = {};
        if (hard) {
            args.duration = 0;
        }
        if (this.lon_center != null) {
            var p = merc.xyToWorld(0, .5 * merc.height_px);
            args.start_heading = 180 - xy_to_ll(p.x, 0)[1];
            args.target_heading = this.lon_center;
        }
        if (this.antipode) {
            args.extentS = MAX_MERC;
        }
        merc.poleAt(this.pos[0], this.pos[1], args);
    }
}

API_KEYS = {
    bing: 'AsK5lEUmEKKiXE2_QpZBfLW6QJXAUNZL9x0D9u0uOQv5Mfjcz-duXV1qX2GFg-N_',
    mapquest: 'Fmjtd%7Cluur2dubll%2C20%3Do5-9arlqa', // caution: url-encoded
}

var tile_specs = [
    {
        name: 'Google Map',
        url: 'https://mts{s:0-3}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}',
        attr: ['Google'],
    },
    {
        name: 'Google Satellite',
        url: 'https://mts{s:0-3}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
        attr: ['Google'],
    },
    {
        name: 'Google Terrain',
        url: 'https://mts{s:0-3}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}',
        max_depth: 15,
        attr: ['Google'],
    },
    {
        name: 'Google Transit',
        url: 'http://mts{s:0-3}.google.com/vt/lyrs=m,transit&opts=r&x={x}&y={y}&z={z}',
        attr: ['Google'],
    },
    {
        name: 'Mapbox Terrain',
        url: 'https://{s:abcd}.tiles.mapbox.com/v3/mrgriscom.i8gjfm3i/{z}/{x}/{y}.png',
        attr: [['Mapbox', 'https://www.mapbox.com/about/maps/'], ['OpenStreetMap contributors', 'http://www.openstreetmap.org/copyright']],
    },
    {
        name: '"Space Station" by Mapbox',
        url: 'https://{s:abcd}.tiles.mapbox.com/v3/examples.3hqcl3di/{z}/{x}/{y}.jpg',
        attr: [['Mapbox', 'https://www.mapbox.com/about/maps/'], ['OpenStreetMap contributors', 'http://www.openstreetmap.org/copyright']],
    },
    {
        name: '"Zombie World" by Mapbox',
        url: 'https://{s:abcd}.tiles.mapbox.com/v3/examples.fb8f9523/{z}/{x}/{y}.jpg',
        attr: [['Mapbox', 'https://www.mapbox.com/about/maps/'], ['OpenStreetMap contributors', 'http://www.openstreetmap.org/copyright']],
    },
    {
        name: 'Pinterest theme by Stamen/Mapbox',
        url: 'https://{s:abcd}.tiles.mapbox.com/v3/examples.map-51f69fea/{z}/{x}/{y}.jpg',
        attr: [['Pinterest'], ['OpenStreetMap contributors', 'http://www.openstreetmap.org/copyright']],
    },
    {
        name: 'Bing Map',
        url: 'http://ak.t{s:0-3}.tiles.virtualearth.net/tiles/r{qt}?g=2432&shading=hill&n=z&key=' + API_KEYS.bing,
        no_z0: true,
        attr: ['Microsoft', 'Nokia'],
    },
    {
        name: 'Bing Satellite',
        url: 'http://ak.t{s:0-3}.tiles.virtualearth.net/tiles/a{qt}?g=2432&n=z&key=' + API_KEYS.bing,
        no_z0: true,
        attr: ['Microsoft', 'Nokia'],
    },
    {
        name: 'Bing Hybrid',
        url: 'http://ak.t{s:0-3}.tiles.virtualearth.net/tiles/h{qt}?g=2432&n=z&key=' + API_KEYS.bing,
        no_z0: true,
        attr: ['Microsoft', 'Nokia'],
    },
    /*
    {
        name: 'Mapquest Open',
        url: 'http://otile{s:1-4}.mqcdn.com/tiles/1.0.0/map/{z}/{x}/{y}.png',
        attr: ['Mapquest', ['OpenStreetMap contributors', 'http://www.openstreetmap.org/copyright']],
    },
    */
    {
        name: 'OSM Mapnik',
        url: 'http://{s:abc}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        attr: [['OpenStreetMap contributors', 'http://www.openstreetmap.org/copyright']],
    },
];

landmarks = [{
    name: 'Arc de Triomphe',
    pos: [48.87379, 2.29504],
    desc: 'the \'spokes\' of this central plaza become parallel lines'
}, {
    name: 'St. Peter\'s Basilica',
    pos: [41.90224, 12.45725]
}, {
    name: 'Mecca',
    pos: [21.42251, 39.82616]
}, {
    name: 'US Capitol',
    pos: [38.88980, -77.00919]
}, {
    name: 'Tip of Cape Cod',
    pos: [42.03471, -70.17058],
    desc: '\'unrolling\' of a natural spiral formation'
}, {
    name: 'Vulcan Point',
    pos: [14.00926, 120.99610],
    desc: 'island inside a lake inside an island inside a lake inside an island'
}, {
    name: 'St. Helena',
    pos: [-15.93788, -5.71189],
    lon_center: 0,
    desc: 'a remote island'
}, {
    name: 'Spain/New Zealand Antipode',
    pos: [43.56060, -7.41384],
    lon_center: 120,
    antipode: true,
    desc: 'two buildings exactly opposite the planet from each other'
}, {
    name: 'Cape Town',
    pos: [-33.90768, 18.39219],
    lon_center: 120
}, {
    name: 'Dubai',
    pos: [25.11739, 55.13432]
}, {
    name: 'Atlanta',
    pos: [33.74503, -84.39005],
    desc: 'a dendritic network of highways heading off to destinations near and far'
}, {
    name: 'Boston',
    pos: [42.35735, -71.05961],
    lon_center: 280,
    default: true,
}, {
    name: '"View of the World from 9th Avenue"',
    pos: [40.76847, -73.98493],
    lon_center: -90,
    desc: 'compare to <a target="_blank" href="http://www.mappery.com/maps/A-View-of-World-from-9th-Avenue-Map.jpg">the original</a>'
}, {
    name: 'Bondi Beach',
    pos: [-33.89123, 151.27748]
}, {
    name: 'Ft. Jefferson',
    pos: [24.63025, -82.87126]
}, {
    name: 'Christ the Redeemer',
    pos: [-22.95192, -43.21049]
}, {
    name: 'UTA Flight 772 Memorial',
    pos: [16.86491, 11.95374]
}, {
    name: 'Great Bend of Brahmaputra',
    pos: [29.56799, 95.39003]
}, {
    name: 'Mississippi River Delta',
    pos: [29.14828, -89.25165],
}, {
    name: 'Lake Victoria',
    pos: [-1.79620, 33.39377],
}, {
    name: '\xc5land',
    pos: [60.03177, 20.89280],
    lon_center: 0,
}, {
    name: 'North Pole',
    pos: [90, 0]
}, {
    name: 'South Pole',
    pos: [-90, 0]
}];

//=== UTIL ===

function loadShader(name) {
    var content = null;
    $.ajax(name + '.glsl', {
        async: false,
        success: function(data) {
            content = data;
        }
    });
    return _.template(content);
}

function configureShader(template, context) {
    context = context || {};

    constants = [
        'TILE_SIZE',
        'MAX_ZOOM',
        'TILE_OFFSET_RESOLUTION',
        'TEX_Z_IX_SIZE',
        'TEX_IX_CELLS',
        'TEX_IX_SIZE',
        'ATLAS_TEX_SIZE',
        'ATLAS_TILE_SIZE',
        'TILE_FRINGE_WIDTH',
        'TILE_SKIRT',
    ];
    const_ctx = {};
    _.each(constants, function(e) {
        const_ctx[e] = window[e];
    });
    context.constants = const_ctx;

    context.num_atlas_pages = NUM_ATLAS_PAGES;

    //console.log(template(context));
    return template(context);
}

function renderLoop(render) {
    var cb = function(timestamp) {
        render(clock());
        requestAnimationFrame(cb);
    }
    requestAnimationFrame(cb);
}

function clock() {
    return window.performance.now() / 1000;
}





function compile_tile_spec(spec, no_guess) {
    var converters = {
        z: function(zoom, x, y) { return zoom; },
        x: function(zoom, x, y) { return x; },
        y: function(zoom, x, y) { return y; },
        '-y': function(zoom, x, y) { return Math.pow(2, zoom) - 1 - y; },
        s: function(zoom, x, y, arg) {
            var k = x + y;
            if (arg.alphabet) {
                return arg.alphabet[k % arg.alphabet.length];
            } else {
                return arg.min + k % (arg.max - arg.min + 1);
            }
        },
        qt: function(zoom, x, y, arg) {
            var bin_digit = function(h, i) {
                return Math.floor(h / Math.pow(2, i) % 2);
            }
            
            var qt = '';
            for (var i = zoom - 1; i >= 0; i--) {
                var q = 2 * bin_digit(y, i) + bin_digit(x, i);
                qt += (arg != null ? arg[q] : q);
            }
            return qt;
        },
    };
    var parse_args = {
        s: function(arg) {
            if (arg.indexOf('-') == -1) {
                return {alphabet: arg.split('')};
            } else {
                var bounds = arg.split('-');
                return {min: +bounds[0], max: +bounds[1]};
            }
        }
    }

    regex = new RegExp('{(.+?)(:.+?)?}', 'g');
    var _converters = {};
    var found = {};
    spec.replace(regex, function(full_match, key, args) {
        if (!args) {
            args = null;
        } else {
            args = args.substring(1);
        }

        var converter = converters[key.toLowerCase()];
        if (converter) {
            found[key.toLowerCase()] = true;
            var arg_preprocessor = parse_args[key.toLowerCase()];
            if (arg_preprocessor) {
                args = arg_preprocessor(args);
            }
            _converters[key] = function(z, x, y) {
                return converter(z, x, y, args);
            }
        }
    });

    var valid_spec = (found.z && found.x && (found.y || found['-y'])) || found.qt;
    if (!valid_spec && !no_guess) {
        var LONDON_CENTER = [.5, .333];
        return guess_spec(spec, LONDON_CENTER);
    }

    return function(zoom, x, y) {
        return spec.replace(regex, function(full_match, key, args) {
            var converter = _converters[key];
            return (converter ? converter(zoom, x, y) : full_match);
        });
    }
}

function guess_spec(spec, known_point) {
    // try to deduce from sample tile of known location
    var numbers = [];
    spec.replace(/[^A-Za-z]\d+(?![A-Za-z])/g, function(match) {
        numbers.push(+match.substring(1));
    });
    numbers = _.sortBy(numbers, function(e) { return e; });
    var mapping = {};
    _.each(numbers, function(e) {
        if (e >= 6 && e <= 22) {
            mapping.z = e;
            return;
        }
        if (mapping.z) {
            for (var i = 0; i < 2; i++) {
                var ref = Math.floor(known_point[i] * Math.pow(2, mapping.z));
                var diff = Math.abs(ref - e);
                if (diff <= 3 * Math.pow(2, Math.max(mapping.z - 6, 0))) {
                    mapping[i == 0 ? 'x' : 'y'] = e;
                }
            }
        }
    });
    var rev_mapping = {};
    _.each(mapping, function(v, k) {
        rev_mapping[v] = k;
    });
    var new_spec = spec.replace(/[^A-Za-z]\d+(?![A-Za-z])/g, function(match) {
        if (rev_mapping[match.substring(1)]) {
            return match[0] + '{' + rev_mapping[match.substring(1)] + '}';
        } else {
            return match;
        }
    });
    return compile_tile_spec(new_spec, true);
}







// couldn't get a reference to this function inside the three.js code; copied
function paramThreeToGL (p, _gl) {

    if ( p === THREE.RepeatWrapping ) return _gl.REPEAT;
    if ( p === THREE.ClampToEdgeWrapping ) return _gl.CLAMP_TO_EDGE;
    if ( p === THREE.MirroredRepeatWrapping ) return _gl.MIRRORED_REPEAT;
    
    if ( p === THREE.NearestFilter ) return _gl.NEAREST;
    if ( p === THREE.NearestMipMapNearestFilter ) return _gl.NEAREST_MIPMAP_NEAREST;
    if ( p === THREE.NearestMipMapLinearFilter ) return _gl.NEAREST_MIPMAP_LINEAR;
    
    if ( p === THREE.LinearFilter ) return _gl.LINEAR;
    if ( p === THREE.LinearMipMapNearestFilter ) return _gl.LINEAR_MIPMAP_NEAREST;
    if ( p === THREE.LinearMipMapLinearFilter ) return _gl.LINEAR_MIPMAP_LINEAR;
    
    if ( p === THREE.UnsignedByteType ) return _gl.UNSIGNED_BYTE;
    if ( p === THREE.UnsignedShort4444Type ) return _gl.UNSIGNED_SHORT_4_4_4_4;
    if ( p === THREE.UnsignedShort5551Type ) return _gl.UNSIGNED_SHORT_5_5_5_1;
    if ( p === THREE.UnsignedShort565Type ) return _gl.UNSIGNED_SHORT_5_6_5;
    
    if ( p === THREE.ByteType ) return _gl.BYTE;
    if ( p === THREE.ShortType ) return _gl.SHORT;
    if ( p === THREE.UnsignedShortType ) return _gl.UNSIGNED_SHORT;
    if ( p === THREE.IntType ) return _gl.INT;
    if ( p === THREE.UnsignedIntType ) return _gl.UNSIGNED_INT;
    if ( p === THREE.FloatType ) return _gl.FLOAT;
    
    if ( p === THREE.AlphaFormat ) return _gl.ALPHA;
    if ( p === THREE.RGBFormat ) return _gl.RGB;
    if ( p === THREE.RGBAFormat ) return _gl.RGBA;
    if ( p === THREE.LuminanceFormat ) return _gl.LUMINANCE;
    if ( p === THREE.LuminanceAlphaFormat ) return _gl.LUMINANCE_ALPHA;
    
    if ( p === THREE.AddEquation ) return _gl.FUNC_ADD;
    if ( p === THREE.SubtractEquation ) return _gl.FUNC_SUBTRACT;
    if ( p === THREE.ReverseSubtractEquation ) return _gl.FUNC_REVERSE_SUBTRACT;
    
    if ( p === THREE.ZeroFactor ) return _gl.ZERO;
    if ( p === THREE.OneFactor ) return _gl.ONE;
    if ( p === THREE.SrcColorFactor ) return _gl.SRC_COLOR;
    if ( p === THREE.OneMinusSrcColorFactor ) return _gl.ONE_MINUS_SRC_COLOR;
    if ( p === THREE.SrcAlphaFactor ) return _gl.SRC_ALPHA;
    if ( p === THREE.OneMinusSrcAlphaFactor ) return _gl.ONE_MINUS_SRC_ALPHA;
    if ( p === THREE.DstAlphaFactor ) return _gl.DST_ALPHA;
    if ( p === THREE.OneMinusDstAlphaFactor ) return _gl.ONE_MINUS_DST_ALPHA;
    
    if ( p === THREE.DstColorFactor ) return _gl.DST_COLOR;
    if ( p === THREE.OneMinusDstColorFactor ) return _gl.ONE_MINUS_DST_COLOR;
    if ( p === THREE.SrcAlphaSaturateFactor ) return _gl.SRC_ALPHA_SATURATE;
    
    return 0;

};

function mk_canvas(w, h) {
    var $c = $('<canvas />');
    $c.attr('width', w);
    $c.attr('height', h);
    var c = $c[0];
    var ctx = c.getContext('2d');
    return {canvas: c, context: ctx};
}



// mod that doesn't suck for negative numbers
function mod(a, b) {
    return ((a % b) + b) % b;
}

function wraparound_diff(diff, rng) {
    rng = rng || 1.;
    return mod(diff + .5 * rng, rng) - .5 * rng;
}

function unwraparound(base, val, rng) {
    return base + wraparound_diff(val - base, rng);
}

function lon_norm(lon) {
    return mod(lon + 180., 360.) - 180.;
}

function prof(tag, func, ctx) {
    var start = window.performance.now();
    func.call(ctx);
    var end = window.performance.now();
    console.log(tag, (end - start).toFixed(3) + ' ms');
}

function npad(n, pad) {
    var s = '' + n;
    while (s.length < pad) {
        s = '0' + s;
    }
    return s;
}

function fmt_ll(k, dir, pad, prec) {
    return dir[k >= 0 ? 0 : 1] + npad(Math.abs(k).toFixed(prec), prec + 1 + pad) + '\xb0';
};

function fmt_pos(ll, prec) {
    return {
        lat: fmt_ll(ll[0], 'NS', 2, prec),
        lon: fmt_ll(ll[1], 'EW', 3, prec)
    };
}

function antipode(ll) {
    return [-ll[0], lon_norm(ll[1] + 180.)];
}

function log2(x) {
    return Math.log(x) / Math.LN2;
}

function prec_digits_for_res(delta) {
    return Math.max(-Math.round(Math.log(delta) / Math.LN10), 0);
}

ADD_COMMAS = new RegExp('\\B(?=(?:\\d{3})+(?!\\d))', 'g');
function format_with_unit(val, delta, unit) {
    // omg fuck javascript
    val /= UNITS[unit];
    if (delta != null) {
        delta /= UNITS[unit];
        var num = val.toFixed(prec_digits_for_res(delta));
    } else {
        var num = val.toPrecision(8);
        for (var i = num.length - 1; num[i] == '0'; i--);
        if (num[i] == '.') {
            i--;
        }
        num = num.substring(0, i + 1);
    }
    if (num.indexOf('.') != -1) {
        var fuck = num.split('.');
        num = fuck[0].replace(ADD_COMMAS, ',') + '.' + fuck[1];
    } else {
        num = num.replace(ADD_COMMAS, ',');
    }
    return num + ' ' + unit;
}

function niceRoundNumber(x, stops, orderOfMagnitude) {
    var orderOfMagnitude = orderOfMagnitude || 10;
    var stops = stops || [1, 2, 5];
    // numbers will snap to .1, .2, .5, 1, 2, 5, 10, 20, 50, 100, 200, etc.

    var xLog = Math.log(x) / Math.log(orderOfMagnitude);
    var exponent = Math.floor(xLog);
    var xNorm = Math.pow(orderOfMagnitude, xLog - exponent);

    var getStop = function(i) {
        return (i == stops.length ? orderOfMagnitude * stops[0] : stops[i]);
    }
    var cutoffs = $.map(stops, function(e, i) {
        var multiplier = getStop(i + 1);
        var cutoff = Math.sqrt(e * multiplier);
        if (cutoff >= orderOfMagnitude) {
            multiplier /= orderOfMagnitude;
            cutoff /= orderOfMagnitude;
        }
        return {cutoff: cutoff, mult: multiplier};
    });
    cutoffs = _.sortBy(cutoffs, function(co) { return co.cutoff; });

    var bucket = matchThresholds(xNorm, $.map(cutoffs, function(co) { return co.cutoff; }), true);
    var multiplier = (bucket == -1 ? cutoffs.slice(-1)[0].mult / orderOfMagnitude : cutoffs[bucket].mult);
    return Math.pow(orderOfMagnitude, exponent) * multiplier;
}

function matchThresholds(val, thresholds, returnIndex) {
    var cat = (returnIndex ? -1 : '-');
    $.each(thresholds, function(i, e) {
        if (e <= val) {
            cat = (returnIndex ? i : e);
        } else {
            return false;
        }
    });
    return cat;
}

UNITS = {
    'cm': 1e-2,
    'm': 1,
    'km': 1e3,
    'in': .0254,
    'ft': .3048,
    'mi': 1609.344,
};

function geomean(x, xu, y, yu) {
    return Math.sqrt(x * y * UNITS[xu] * UNITS[yu]);
}

function snap_scale(scale, target_size) {
    var target_len = scale * target_size;
    if (METRIC) {
        var len = niceRoundNumber(target_len);
        if (len < 1) {
            var unit = 'cm';
        } else if (len < 1000) {
            var unit = 'm';
        } else {
            var unit = 'km';
        }
    } else {
        if (target_len < UNITS.in) {
            var unit = 'in';
            var len = niceRoundNumber(target_len / UNITS[unit]);
        } else if (target_len < geomean(6, 'in', 1, 'ft')) {
            var unit = 'in';
            var len = niceRoundNumber(target_len / UNITS[unit], [1, 3, 6], 12);
        } else if (target_len < geomean(2000, 'ft', 1, 'mi')) {
            var unit = 'ft';
            var len = Math.min(niceRoundNumber(target_len / UNITS[unit]), 2000);
        } else {
            var unit = 'mi';
            var len = Math.max(niceRoundNumber(target_len / UNITS[unit]), 1);
        }
        len *= UNITS[unit];
    }
    return {label: format_with_unit(len, null, unit), size: len / scale};
}
