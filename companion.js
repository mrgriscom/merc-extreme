
TileLayer = L.TileLayer.extend({
    getTileUrl: function (tilePoint) {
        if (!this._toUrl) {
            this._toUrl = compile_tile_spec(this._url);
        }
        return this._toUrl(this._getZoomForUrl(), tilePoint.x, tilePoint.y);
    }
});


function init_companion() {
    var map = new L.Map('map', {
        fadeAnimation: false,
        zoomAnimation: false,
        attributionControl: false,
    });
    map.addControl(new L.Control.Scale({
        maxWidth: 125,
	    position: 'bottomright',                       
	}));
  
    window.addEventListener("message", function(e) {
        update(map, e.data);
    }, false);
}

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

function update(map, data) {
    if (map.cur_layer == null || map.cur_layer.tag != data.layer.id) {
        var new_layer = mk_layer(data.layer);
        map.addLayer(new_layer, true);
        if (map.cur_layer) {
            map.removeLayer(map.cur_layer);
        }
        map.cur_layer = new_layer;
    }
    map.setView(data.pole, map.getZoom() || 1);

    if (map.geodata) {
        map.removeLayer(map.geodata);
    }
    geodata = new L.geoJson(mk_geojson(data, 256 * Math.pow(2, map.getZoom())), {
        style: function(feature) {
            return {
                color: feature.properties.name == 'arc' ? 'blue' : 'red',
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
        maxZoom: layer.max_depth || MAX_ZOOM,
        minZoom: layer.no_z0 ? 1 : 0,
    };
    // TODO attribution
    var maplayer = new TileLayer(layer.url, opts);
    maplayer.tag = layer.id;
    return maplayer;
}
