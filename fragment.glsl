// -*- mode: c -*-

#define PI   3.1415926535
#define PI2  6.2831853071
#define PI_2 1.5707963267
#define PI_4 0.7853981633

<% _.each(constants, function(v, k) { %>
#define <%= k %> float(<%= v %>)
<% }); %>

uniform vec2 pole;    // lat/lon degrees
uniform vec2 pole_t;  // maptile coordinates
uniform vec2 ref_t;
uniform vec2 anti_ref_t;
uniform float scale;  // pixels per earth circumference (undistorted)
uniform float bias;   // overzoom is capped at 2^bias
uniform float zoom_blend;
uniform float blinder_start;

uniform vec2 hp_pole_tile;
uniform vec2 hp_pole_offset;

uniform vec2 hp_ref_tile;
uniform vec2 hp_antiref_tile;

varying vec2 merc;  // projected mercator unit coordinates: lon:[-180,180] => x:[0,1], lat:0 => y:0
varying vec2 altUV;

uniform sampler2D tx_ix;
uniform sampler2D tx_atlas[<%= num_atlas_pages %>];
uniform sampler2D tx_z0;

void llr_to_xyz(in vec2 llr, out vec3 xyz) {
    xyz = vec3(cos(llr.s) * cos(llr.t), sin(llr.s) * cos(llr.t), sin(llr.t));
}

void xyz_to_llr(in vec3 xyz, out vec2 llr) {
    // don't use asin(z) because of precision issues
    llr = vec2(atan(xyz.y, xyz.x), atan(xyz.z, length(vec2(xyz.x, xyz.y))));
}

// reverse polar shift, i.e., shift lat/lon 90,0 to coordinates of fake_pole
void translate_pole(in vec2 llr, in vec2 fake_pole, out vec2 llr_trans) {
    vec2 rpole = radians(fake_pole);
    vec3 xyz;
    llr_to_xyz(llr, xyz);

    float latrot = rpole.t - PI_2;
    vec3 xyz_trans = mat3( // shift lat +90 to pole lat
        cos(latrot), 0, sin(latrot),
        0, 1, 0,
        -sin(latrot), 0, cos(latrot)
    ) * xyz;
    xyz_to_llr(xyz_trans, llr_trans);
    llr_trans.s += rpole.s; // shift lon 0 to pole lon
}

// given tile coordinates, find the location of the relevant tile in the texture atlas
void tex_lookup_atlas(in float z, in bool anti_pole, in vec2 tile,
                      out int tex_id, out vec2 atlas_t, out bool atlas_oob) {
    vec4 x_offset_enc = texture2D(tx_ix, (vec2(z, (.5 * TEX_IX_CELLS * float(anti_pole) + 1.) * TEX_Z_IX_SIZE - 1.) + .5) / TEX_IX_SIZE);
    vec4 y_offset_enc = texture2D(tx_ix, (vec2(z, (.5 * TEX_IX_CELLS * float(anti_pole) + 1.) * TEX_Z_IX_SIZE - 2.) + .5) / TEX_IX_SIZE);
    vec2 offset = TILE_OFFSET_RESOLUTION * vec2(65536. * floor(255. * x_offset_enc.r) + 256. * floor(255. * x_offset_enc.g) + floor(255. * x_offset_enc.b),
                                                65536. * floor(255. * y_offset_enc.r) + 256. * floor(255. * y_offset_enc.g) + floor(255. * y_offset_enc.b));

    vec2 z_cell = vec2(mod(z, TEX_IX_CELLS), floor(z / TEX_IX_CELLS) + TEX_IX_CELLS * .5 * float(anti_pole));
    vec2 ix_offset = tile - offset;
    ix_offset.s = mod(ix_offset.s, TEX_Z_IX_SIZE);
    vec2 ix_cell = TEX_Z_IX_SIZE * z_cell + ix_offset;

    vec4 slot_enc = texture2D(tx_ix, (ix_cell + .5) / TEX_IX_SIZE);
    tex_id = int(255. * slot_enc.r) - 1;
    int slot_x = int(255. * slot_enc.g);
    int slot_y = int(255. * slot_enc.b);
    atlas_t = vec2(slot_x, slot_y);

    atlas_oob = (ix_offset.s >= TEX_Z_IX_SIZE || ix_offset.t < 0. || ix_offset.t >= TEX_Z_IX_SIZE);
}

// given tile coordinates, get texture atlas coordinates suitable for actual texture access
void tex_lookup_coord(in float z, in bool anti_pole, in vec2 tile, in vec2 tile_p,
                      out int tex_id, out vec2 atlas_p, out bool atlas_oob) {
    vec2 atlas_t;
    tex_lookup_atlas(z, anti_pole, tile, tex_id, atlas_t, atlas_oob);
    atlas_p = (ATLAS_TILE_SIZE * atlas_t + TILE_SIZE * tile_p + TILE_SKIRT) / ATLAS_TEX_SIZE;
}

// given "world" coordinates (like tile coordinates but for z0), get texture atlas coordinates
void tex_lookup_abs(in float z, in bool anti_pole, in vec2 abs_map,
                    out int tex_id, out vec2 atlas_p, out bool atlas_oob) {
    vec2 abs_map_z = abs_map * exp2(z);
    vec2 tile = floor(abs_map_z);
    vec2 tile_p = mod(abs_map_z, 1.);
    tex_lookup_coord(z, anti_pole, tile, tile_p, tex_id, atlas_p, atlas_oob);
}

// look up the texture value for a position, handling various exceptional cases
void tex_lookup_val(in float z, in vec2 abs_map, in bool atlas_oob, in int tex_id, in vec2 atlas_p, out vec4 val) {
    if (z == 0. || abs_map.t < 0. || abs_map.t >= 1.) {
        // note: just out-of-bounds pixels will only ever blend with the z0 texture, regardless
        // of the appropriate zoom level
        val = texture2D(tx_z0, vec2(abs_map.s, .5 * (abs_map.t + .5)));
    } else if (atlas_oob) {
        val = vec4(1, 0, 0, 1);
    } else if (tex_id >= 0) {
      <% for (var i = 0; i < num_atlas_pages; i++) { %>
        if (tex_id == <%= i %>) {
            val = texture2D(tx_atlas[<%= i %>], atlas_p);
        }
      <% } %>
    } else {
        val = vec4(.65, .7, .75, 1);
    }
}

void fringe(in float tile, in float tile_p, out float mode) {
    bool fringelo = tile_p < TILE_FRINGE_WIDTH;
    bool fringehi = tile_p > 1. - TILE_FRINGE_WIDTH;
    bool fringeparent = mod(tile, 2.) == 0. ? tile_p < 2. * TILE_FRINGE_WIDTH : tile_p > 1. - 2. * TILE_FRINGE_WIDTH;

    if (TILE_FRINGE_WIDTH < 1./3. ? fringeparent && !(fringelo || fringehi) : !fringeparent) {
        mode = 3.;
    } else {
        mode = 2. * float(fringehi) + float(fringelo);
    }
}

// perform addition on a 'high precision' number
void hp_reco(in vec2 told, in vec2 oold, out vec2 tnew, out vec2 onew) {
  oold += fract(told);
  tnew = floor(told) + floor(oold);
  onew = fract(oold);
}

void abs_antipode(in vec2 abs, out vec2 anti) {
  anti = vec2(mod(abs.s + .5, 1.), 1. - abs.t);
}

void main() {
    vec2 merc_rad = (merc + vec2(-.5, 0)) * PI2; // projected mercator radians: lon:[-180:180] => x:[-pi, pi]
    bool anti_pole = (merc.t < 0.);

    float proj_scale_factor;
    float abs_geo_lat;
    vec2 abs_map;
    vec2 tile;
    bool out_of_bounds;

  <% if (geo_mode == 'flat' || geo_mode == 'linear' || output_mode == 'tile') { %>
    vec2 tile_p;
    vec2 base_tile;
    vec2 base_offset;
  <% } %>

  <% if (geo_mode == 'flat') { %>

    base_tile = hp_pole_tile;
    base_offset = hp_pole_offset;
    float theta = merc_rad.s;
    if (anti_pole) {
      vec2 anti_tile;
      abs_antipode(base_tile, anti_tile);
      base_tile = anti_tile;
      base_offset.t = -base_offset.t;
      theta = -theta;
    }

    float dist_rad = 2. * exp(-abs(merc_rad.t)); // distance to pole (radians)
    float dist = dist_rad / PI2 / cos(radians(pole.t)); // dist in unit merc
    vec2 ray = dist * vec2(sin(theta), cos(theta));
    base_offset += ray;

    proj_scale_factor = dist_rad;
    abs_geo_lat = radians(pole.t) + dist_rad * cos(theta);

  <% } else if (geo_mode == 'linear') { %>

    base_tile = (anti_pole ? hp_antiref_tile : hp_ref_tile);
    base_offset = altUV;

  <% } %>

  <% if (geo_mode == 'sphere' || geo_mode == 'linear') { %>
    vec2 geo_rad = vec2(merc_rad.s, 2. * atan(exp(merc_rad.t)) - PI_2); // geographic coordinates, radians
    proj_scale_factor = cos(geo_rad.t);

    vec2 abs_geo_rad;
    translate_pole(geo_rad, pole, abs_geo_rad);
    abs_geo_lat = abs_geo_rad.t;
  <% } %>
  
  <% if (geo_mode == 'sphere') { %>
    vec2 abs_merc_rad = vec2(abs_geo_rad.s, log(tan(.5 * abs_geo_rad.t + PI_4))); // projected mercator coordinates, radians
    mat3 merc_map_tx = mat3(
        1./PI2, 0, 0,
        0, -1./PI2, 0,
        .5, .5, 1
    );

    abs_map = vec2(merc_map_tx * vec3(abs_merc_rad.s, abs_merc_rad.t, 1.)); // map tile coordiantes: lon:[-180,180] => x:[0,1], lat:[-90,90] => y:[+inf,-inf]
    abs_map.s = mod(abs_map.s, 1.);
    out_of_bounds = (abs_map.t < 0. || abs_map.t >= 1.);
  <% } %>

    float res = PI2 / scale * proj_scale_factor; // radians per pixel
    // compensate for the fact the map imagery is mercator projected, and has higher resolution towards the poles
    float base_res = PI2 / TILE_SIZE * cos(abs_geo_lat); // radians per pixel offered by the lowest zoom layer
    float fzoom = min(log2(base_res / res) - bias + .5 * zoom_blend, MAX_ZOOM); // necessary zoom level (on a continuous scale)
    float z = max(ceil(fzoom), 0.); // without clamping, -z would be the lod for mipmap of z0
    float zblend = (fract(fzoom) == 0. ? 1. : min(fract(fzoom) / zoom_blend, 1.)); // fract(fzoom) == 0 special case needed due to z = ceil(fzoom)

  <% if (geo_mode == 'flat' || geo_mode == 'linear') { %>
    hp_reco(base_tile * exp2(z), base_offset * exp2(z), tile, tile_p);
    tile.s = mod(tile.s, exp2(z));

    out_of_bounds = (tile.s < 0. || tile.t < 0. || tile.s >= exp2(z) || tile.t >= exp2(z));
    abs_map = (tile + tile_p) * exp2(-z); // don't think this var would ever be needed in these modes
  <% } %>


  <% if (output_mode == 'tile') { %>

    // zoom level - 5 bits
    // anti-pole - 1 bit
    // zoom bleed - 1 bit
    // tile fringe - 2 bits each for x, y
    // offset from ref - 6 bits each for x, y
    // 1 bit left over... primary vs. secondary overlay?

    float z_enc;
    bool zoom_bleed;
    vec2 tile_enc;
    float xfringe_enc;
    float yfringe_enc;

    if (out_of_bounds) {
        z_enc = 31.;
    } else {
      <% if (geo_mode == 'sphere') { %>
        tile = floor(abs_map * exp2(z));
        tile_p = fract(abs_map * exp2(z));
      <% } %>

        z_enc = z;
        zoom_bleed = (zblend < 1.);

        vec2 ref = anti_pole ? anti_ref_t : ref_t;
        vec2 ref_tile = floor(ref * exp2(z));
        vec2 diff = tile - ref_tile;
        diff.s = mod(diff.s + exp2(z - 1.), exp2(z)) - exp2(z - 1.); // handle wraparound
        tile_enc = diff + 32.; // 2^(# offset bits - 1)

        fringe(tile.s, tile_p.s, xfringe_enc);
        fringe(tile.t, tile_p.t, yfringe_enc);
    }

    gl_FragColor = vec4(
        (float(anti_pole) * 64. + float(zoom_bleed) * 32. + z_enc) / 255.,
        (xfringe_enc * 64. + tile_enc.s) / 255.,
        (yfringe_enc * 64. + tile_enc.t) / 255.,
        1);

  <% } %>

  <% if (output_mode == 'tex') { %>

    int tex_id;
    bool z_oob;
    vec2 atlas_p;

  <% if (geo_mode == 'sphere') { %>
    tex_lookup_abs(z, anti_pole, abs_map, tex_id, atlas_p, z_oob);
  <% } else if (geo_mode == 'flat' || geo_mode == 'linear') { %>
    tex_lookup_coord(z, anti_pole, tile, tile_p, tex_id, atlas_p, z_oob);
  <% } %>

    float z_orig = z;
    bool zoob_orig = z_oob;
  <% for (var i = 0; i < constants.MAX_ZOOM; i++) { %>        
    if (tex_id < 0 && z > 0.) {
        z -= 1.;
      <% if (geo_mode == 'sphere') { %>
        tex_lookup_abs(z, anti_pole, abs_map, tex_id, atlas_p, z_oob);
      <% } else if (geo_mode == 'flat' || geo_mode == 'linear') { %>
        vec2 _tile = .5 * tile;
        vec2 _offset = .5 * tile_p;
        hp_reco(_tile, _offset, tile, tile_p);
        tex_lookup_coord(z, anti_pole, tile, tile_p, tex_id, atlas_p, z_oob);
      <% } %>
    }
  <% } %>

    vec4 result;
    tex_lookup_val(z, abs_map, z_oob, tex_id, atlas_p, result);

    if (zoom_blend > 0.) {
        vec4 parent = result;
        if (!(z < z_orig || z == 0. || zblend == 1.)) {

            // only one iteration; we don't care if parent tile is not loaded
            z -= 1.;
          <% if (geo_mode == 'sphere') { %>
            tex_lookup_abs(z, anti_pole, abs_map, tex_id, atlas_p, z_oob);
          <% } else if (geo_mode == 'flat' || geo_mode == 'linear') { %>
            vec2 _tile = .5 * tile;
            vec2 _offset = .5 * tile_p;
            hp_reco(_tile, _offset, tile, tile_p);
            tex_lookup_coord(z, anti_pole, tile, tile_p, tex_id, atlas_p, z_oob);
          <% } %>

            if (tex_id >= 0) {
                tex_lookup_val(z, abs_map, z_oob, tex_id, atlas_p, parent);
            }
        }
        result = mix(parent, result, zblend);
    }

    // tint according to geo_mode for debugging
    //if (true) {
    if (false) {
      vec4 tint = result;
   <% if (geo_mode == 'linear') { %>
      tint = vec4(0, 1, 0, 1);
   <% } else if (geo_mode == 'flat') { %>
      tint = vec4(1, 0, 1, 1);
   <% } %> 
      result = mix(result, tint, .1);
    }

    if (floor(merc.x - blinder_start) != 0.) {
      result = mix(result, vec4(0, 0, 0, 1), .3);
    }

    gl_FragColor = result;
  <% } %>

}

