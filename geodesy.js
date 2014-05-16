EARTH_MEAN_RAD = 6371009.0
DEG_RAD = 180. / Math.PI;

function is_zero(x) {
    var EPSILON = 1.0e-9
    return Math.abs(x) < EPSILON;
}

// dot product
function dotp(a, b) {
    var result = 0;
    for (var i = 0; i < a.length; i++) {
        result += a[i] * b[i];
    }
    return result;
}

// cross product
// 3-vectors only
function crossp(a, b) {
    var result = Array(3);
    for (var i = 0; i < 3; i++) {
        var t = (i + 1) % 3;
        var u = (i + 2) % 3;
        result[i] = a[t] * b[u] - a[u] * b[t];
    }
    return result;
}

// length of vector
function vlen(v) {
    var sum = 0;
    for (var i = 0; i < v.length; i++) {
        sum += v[i] * v[i];
    }
    return Math.sqrt(sum);
}

// scale vector by scalar 'k'
function vscale(v, k) {
    var result = Array(v.length);
    for (var i = 0; i < v.length; i++) {
        result[i] = k * v[i];
    }
    return result;
}

// add two vectors
function vadd(a, b) {
    var result = Array(a.length);
    for (var i = 0; i < a.length; i++) {
        result[i] = a[i] + b[i];
    }
    return result;
}

// a - b
function vdiff(a, b) {
    return vadd(a, vscale(b, -1));
}

// normalize vector; return null if length 0
function vnorm(v) {
    var norm = vlen(v);
    if (is_zero(norm)) {
        return null;
    }
    return vscale(v, 1. / norm);
}

// return portion of 'b' orthogonal to 'a', and cosine between 'a' and 'b'
// 'a' and 'b' are unit vectors
function vortho(a, b) {
    var cos = dotp(a, b);
    return {
        v: vadd(b, vscale(a, -cos)),
        cos: cos,
    };
}

// create angle vector given orthogonal basis vectors 'u' and 'v', and angle 'theta' in radians
function vangle(u, v, theta) {
    return vadd(vscale(u, Math.cos(theta)), vscale(v, Math.sin(theta)));
}

// return a function(theta) that rotates 'v' around 'axis' by angle 'theta'
// clockwise when looking from 'axis' toward origin
// 'v' and 'axis' are unit 3-vectors; need not be orthogonal
function vrotator(v, axis) {
    var orth = vortho(axis, v);
    var axial = vscale(axis, orth.cos);
    var vd = crossp(orth.v, axis);
    return function(theta) {
        return vadd(axial, vangle(orth.v, vd, theta));
    };
}

// lat/lon to unit 3-vector
function ll_to_xyz(ll) {
    var rlat = ll[0] / DEG_RAD;
    var rlon = ll[1] / DEG_RAD;
    var latcos = Math.cos(rlat);
    return [Math.cos(rlon) * latcos, Math.sin(rlon) * latcos, Math.sin(rlat)];
}

// unit 3-vector to lat/lon
function xyz_to_ll(v) {
    var x = v[0];
    var y = v[1];
    var z = v[2];
    var rlon = (is_zero(x) && is_zero(y) ? 0 : Math.atan2(y, x));
    var rlat = Math.atan2(z, vlen([x, y]));
    return [rlat * DEG_RAD, rlon * DEG_RAD];
}

// return 'north' and 'east' vectors for a given position vector
function orientate(vp) {
    var east = vnorm(crossp([0, 0, 1], vp));
    if (east == null) {
        // pole
        east = [0, -vp[2], 0];
    }
    north = crossp(vp, east);
    return {n: north, e: east};
}

// return heading vector for position and heading
function vhead(vp, heading) {
    var rhead = heading / DEG_RAD;
    var basis = orientate(vp);
    return vangle(basis.n, basis.e, rhead);
}

// compute heading from from position and direction vector
function headv(vp, vdir) {
    var basis = orientate(vp);
    return Math.atan2(dotp(vdir, basis.e), dotp(vdir, basis.n)) * DEG_RAD;
}

// distance between p0 and p1 in meters (in radians if 'in_rad' is true)
function distance(p0, p1, in_rad) {
    var v0 = ll_to_xyz(p0);
    var v1 = ll_to_xyz(p1);
    var orth = vortho(v0, v1);
    return (in_rad ? 1 : EARTH_MEAN_RAD) * Math.atan2(vlen(orth.v), orth.cos);
}

// return compass bearing from src to dst; null if src/dst are antipodal
// if src is polar, treat direction of 0 longitude as north
function bearing(src, dst) {
    var v0 = ll_to_xyz(src);
    var v1 = ll_to_xyz(dst);
    var orth = vortho(v0, v1);
    if (is_zero(vlen(orth.v))) {
        return null;
    }
    return headv(v0, orth.v)
}

function plotv(vp, vdir, theta, incl_new_heading) {
    var vp2 = vangle(vp, vdir, theta);
    var p = xyz_to_ll(vp2);
    if (incl_new_heading) {
        var vdir2 = vangle(vdir, vscale(vp, -1.), theta);
        var heading = headv(vp2, vdir2);
        return {p: p, heading: heading};
    }
    return p;
}

// return a function(dist)
function line_plotter(p, heading) {
    var vp = ll_to_xyz(p);
    var vdir = vhead(vp, heading);
    return function(dist, incl_new_heading) {
        return plotv(vp, vdir, dist / EARTH_MEAN_RAD, incl_new_heading);
    };
}

// return a function(theta)
function arc_plotter(p, dist) {
    var vp = ll_to_xyz(p);
    var ref = ll_to_xyz(line_plotter(p, 0)(dist));
    var rot = vrotator(ref, vp);
    return function(theta) {
        return xyz_to_ll(rot(theta / DEG_RAD));
    }
}

function max_lon_extent(lat, radius) {
    var k = Math.sin(radius / EARTH_MEAN_RAD) / Math.cos(lat / DEG_RAD);
    return (Math.abs(k) > 1. ? Math.PI : Math.asin(k)) * DEG_RAD;
}

function interpolate_curve(func, anchors, error_thresh, min_dt) {
    var points = [];
    var _interp = function(lo, hi, flo, fhi) {
        if (Math.abs(hi - lo) <= min_dt) {
            return;
        }
        
        var mid = .5 * (lo + hi);
        var fmid = func(mid);
        if (error_thresh(fmid, flo, fhi)) {
            _interp(lo, mid, flo, fmid);
            points.push(fmid);
            _interp(mid, hi, fmid, fhi);
        }
    };

    for (var i = 0; i < anchors.length - 1; i++) {
        var lo = anchors[i];
        var hi = anchors[i + 1];
        var flo = func(lo);
        var fhi = func(hi);
        points.push(flo);
        _interp(lo, hi, flo, fhi);
    }
    points.push(fhi);
    return points;
}





function base_point(p0, dist) {
    if (dist / EARTH_MEAN_RAD > .5 * Math.PI) {
        // antipode
        return [-p0[0], lon_norm(p0[1] + 180.)];
    } else {
        return p0;
    }
}

function lineplot(p0, heading, maxdist, scale_px) {
    return mapplot(
        line_plotter(p0, heading),
        // don't start at zero to avoid clipping error when using antipole as basis
        [1e-6 * maxdist, .5 * maxdist, maxdist],
        base_point(p0, maxdist), scale_px, 100
    );
}

function circplot(p0, radius, scale_px) {
    return mapplot(
        arc_plotter(p0, radius),
        [0, 60, 120, 180, 240, 300, 360],
        base_point(p0, radius), scale_px, 1
    );
}

function mapplot(plotter, anchors, pbase, scale_px, min_dt) {
    var base_merc = ll_to_xy(pbase[0], pbase[1]);
    base_merc = [base_merc.x, base_merc.y];

    return _.map(interpolate_curve(
        function(t) {
            var ll = plotter(t);
            var xy = ll_to_xy(ll[0], ll[1]);
            return {ll: ll, xy: [xy.x, xy.y]};
        },
        anchors,
        function(fmid, flo, fhi) {
            var approx = vadd(vscale(flo.xy, .5), vscale(fhi.xy, .5));
            var diff = vlen(vdiff(fmid.xy, approx));

            var remoteness = vlen(vdiff(approx, base_merc));
            var MAX_VIEWPORT_RADIUS = 1024;
            var threshold_scale = Math.max(remoteness * scale_px / MAX_VIEWPORT_RADIUS, 1.);

            var threshold = .25 / scale_px * threshold_scale;
            return diff > threshold;
        },
        min_dt
    ), function(e) { return [unwraparound(pbase[1], e.ll[1], 360), e.ll[0]]; });
}
