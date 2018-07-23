
TileLayer = L.TileLayer.extend({
    getTileUrl: function (tilePoint) {
        return this._toUrl(this._getZoomForUrl(), tilePoint.x, tilePoint.y);
    }
});


function init_companion() {
    LAYERS = load_tile_specs();
    
    var map = new L.Map('map', {
        attributionControl: false,
        zoomControl: false,

        dragging: false,
        touchZoom: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,

        //fadeAnimation: false,
        //zoomAnimation: false,
    });
    map.addControl(new L.Control.Scale({
        maxWidth: 125,
	    position: 'bottomright',                       
	}));
  
    window.addEventListener("message", function(e) {
        update(map, e.data);
    }, false);
}

// nicely split up geometry that crosses the IDL
function process_geo(points) {
    var segments = [];
    var segment = [];
    for (var i = 0; i < points.length - 1; i++) {
        var a = points[i];
        var b = points[i + 1];
        segment.push(a);
        if (Math.abs(a[0] - b[0]) > 180.) {
            segment.push([unwraparound(a[0], b[0], 360), b[1]]);
            segments.push(segment);
            segment = [];
            segment.push([unwraparound(b[0], a[0], 360), a[1]]);
        }
    }
    segment.push(b);
    segments.push(segment);
    return segments;
}

function mk_geojson(data, scale_px) {
    var geojson = {
        type: 'FeatureCollection',
        features: []
    };
    var addMulti = function(props, points) {
        // need to split into separate linestring features because
        // leaflet geojson has issues with multi*
        _.each(process_geo(points), function(e) {
            geojson.features.push({
                type: 'Feature',
                properties: props,
                geometry: {
                    type: 'LineString', //'MultiLineString',
                    coordinates: e,
                }
            });
        });
    }
    addMulti({name: 'arc'}, circplot(data.pole, data.dist, scale_px));
    addMulti({name: 'line'}, lineplot(data.pole, data.bearing, data.dist, scale_px)); 
    return geojson;
}

ZOOM_TIMEOUT = .5;
LAST_ZOOM_CHANGE = null;
function update(map, data) {
    // map layer
    if (map.cur_layer == null || map.cur_layer.tag != data.layer.id) {
        var new_layer = mk_layer(data.layer);
        map.addLayer(new_layer, true);
        if (map.cur_layer) {
            map.removeLayer(map.cur_layer);
        }
        map.cur_layer = new_layer;
    }

    if (data.dist == null) {
        map.setView(data.pole, map.getZoom(), {pan: {animate: false}});
        map.fitWorld({pan: {animate: false}});
        if (map.geodata) {
            map.removeLayer(map.geodata);
        }
        return;
    }

    // dimensions and viewport to determine zoom level
    if (data.dist / EARTH_MEAN_RAD < .5 * Math.PI) {
        var center = data.pole;
        var dist = data.dist;
    } else {
        var center = antipode(data.pole);
        var dist = Math.PI * EARTH_MEAN_RAD - data.dist;
    }
    var lon_extent = max_lon_extent(center[0], dist);
    var lat_extent = dist / EARTH_MEAN_RAD * DEG_RAD;
    var bounds = new L.latLngBounds([Math.max(center[0] - lat_extent, -85.05), center[1] - lon_extent],
                                [Math.min(center[0] + lat_extent, 85.05), center[1] + lon_extent])

    // update zoom
    var current_zoom = map.getZoom();
    if (clock() - (LAST_ZOOM_CHANGE || -999) > ZOOM_TIMEOUT) {
        map.fitBounds(bounds, {
            padding: [60, 60],
            pan: {animate: false},
        });
    }
    if (map.getZoom() != current_zoom) {
        LAST_ZOOM_CHANGE = clock();
    }

    // update center
    map.setView(center, map.getZoom(), {pan: {animate: false}});

    // draw
    if (map.geodata) {
        map.removeLayer(map.geodata);
    }
    geodata = new L.geoJson(mk_geojson(data, 256 * Math.pow(2, map.getZoom())), {
        style: function(feature) {
            return {
                color: feature.properties.name == 'arc' ? '#0af' : 'red',
                opacity: .8,
                weight: 2,
            }
        },
        onEachFeature: function (feature, layer) {
            layer.options.smoothFactor = 0;
        }
    });
    map.addLayer(geodata);
    map.geodata = geodata;
}

function mk_layer(layer) {
    var opts = {
        maxZoom: layer.max_depth || 19,
        minZoom: layer.no_z0 ? 1 : 0,
    };
    var maplayer = new TileLayer(null, opts);
    if (layer.url != null) {
        maplayer._toUrl = compile_tile_spec(layer.url);
    } else {
	var spec = _.find(LAYERS, function(e) { return e.key == layer.key; });
	maplayer._toUrl = spec.urlgen();
    }    
    maplayer.tag = layer.id;
    return maplayer;
}
