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
    vec4 x_offset_enc = texture2D(tx_ix, (vec2(z, (4. * float(anti_pole) + 1.) * TEX_Z_IX_SIZE - 1.) + .5) / TEX_IX_SIZE);
    vec4 y_offset_enc = texture2D(tx_ix, (vec2(z, (4. * float(anti_pole) + 1.) * TEX_Z_IX_SIZE - 2.) + .5) / TEX_IX_SIZE);
    vec2 offset = TILE_OFFSET_RESOLUTION * vec2(256 * int(255. * x_offset_enc.r) + int(255. * x_offset_enc.g),
                                                256 * int(255. * y_offset_enc.r) + int(255. * y_offset_enc.g));

    vec2 z_cell = vec2(mod(z, TEX_IX_CELLS), floor(z / TEX_IX_CELLS) + TEX_IX_CELLS * .5 * float(anti_pole));
    vec2 ix_cell = TEX_Z_IX_SIZE * z_cell - offset + tile;
    vec4 slot_enc = texture2D(tx_ix, (ix_cell + .5) / TEX_IX_SIZE);
    tex_id = int(255. * slot_enc.r) - 1;
    int slot_x = int(255. * slot_enc.g);
    int slot_y = int(255. * slot_enc.b);
    atlas_t = vec2(slot_x, slot_y);

    atlas_oob = (tile.s < offset.s || tile.t < offset.t ||
                 tile.s >= offset.s + TEX_Z_IX_SIZE || tile.t >= offset.t + TEX_Z_IX_SIZE);
}

// given tile coordinates, get texture atlas coordinates suitable for actual texture access
void tex_lookup_coord(in float z, in bool anti_pole, in vec2 tile, in vec2 tile_p,
                      out int tex_id, out vec2 atlas_p, out bool atlas_oob) {
    vec2 atlas_t;
    tex_lookup_atlas(z, anti_pole, tile, tex_id, atlas_t, atlas_oob);
    atlas_p = (atlas_t + tile_p) / (ATLAS_TEX_SIZE / TILE_SIZE);
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
    if (z == 0. || abs_map.t < 0. || abs_map.t > 1.) {
        // note: just out-of-bounds pixels will only ever blend with the z0 texture, regardless
        // of the appropriate zoom level
        val = texture2D(tx_z0, vec2(abs_map.s, .5 * (abs_map.t + .5)));
    } else if (atlas_oob) {
        val = vec4(1, 0, 0, 1);
    } else if (tex_id >= 0) {
        val = texture2D(tx_atlas[<%= num_atlas_pages - 1 %>], atlas_p);
    } else {
        val = vec4(.65, .7, .75, 1.);
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

  <% if (geo_mode == 'flat') { %>

    vec2 tile_p;

    vec2 base_tile;
    vec2 base_offset;
    vec2 ray;

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
    ray = dist * vec2(sin(theta), cos(theta));

    proj_scale_factor = dist_rad;
    abs_geo_lat = radians(pole.t) + dist_rad * cos(theta);

  <% } else if (geo_mode == 'linear') { %>

    vec2 tile_p;

    vec2 base_tile;

    if (anti_pole) {
      base_tile = hp_antiref_tile;
    } else {
      base_tile = hp_ref_tile;
    }

    vec2 geo_rad = vec2(merc_rad.s, 2. * atan(exp(merc_rad.t)) - PI_2); // geographic coordinates, radians
    proj_scale_factor = cos(geo_rad.t);

    vec2 abs_geo_rad;
    translate_pole(geo_rad, pole, abs_geo_rad);
    abs_geo_lat = abs_geo_rad.t;
   
  <% } else { %>

    vec2 geo_rad = vec2(merc_rad.s, 2. * atan(exp(merc_rad.t)) - PI_2); // geographic coordinates, radians
    proj_scale_factor = cos(geo_rad.t);

    vec2 abs_geo_rad;
    translate_pole(geo_rad, pole, abs_geo_rad);
    abs_geo_lat = abs_geo_rad.t;

    vec2 abs_merc_rad = vec2(abs_geo_rad.s, log(tan(.5 * abs_geo_rad.t + PI_4))); // projected mercator coordinates, radians
    mat3 merc_map_tx = mat3(
        1./PI2, 0, 0,
        0, -1./PI2, 0,
        .5, .5, 1
    );

    abs_map = vec2(merc_map_tx * vec3(abs_merc_rad.s, abs_merc_rad.t, 1.)); // map tile coordiantes: lon:[-180,180] => x:[0,1], lat:[-90,90] => y:[+inf,-inf]
    abs_map.x = mod(abs_map.x, 1.);
    
  <% } %>

    // compensate for the fact the map imagery is mercator projected, and has higher resolution towards the poles
    float res = PI2 / scale * proj_scale_factor; // radians per pixel
    float base_res = PI2 / TILE_SIZE * cos(abs_geo_lat); // radians per pixel offered by the lowest zoom layer
    float fzoom = log2(base_res / res) - bias; // necessary zoom level (on a continuous scale)
    float z = clamp(ceil(fzoom), 0., MAX_ZOOM); // without clamping, -z would be the lod for mipmap of z0

    bool out_of_bounds;

  <% if (geo_mode == 'flat') { %>
    hp_reco(base_tile * exp2(z), (base_offset + ray) * exp2(z), tile, tile_p);
    tile.s = mod(tile.s, exp2(z));

    out_of_bounds = (tile.s < 0. || tile.t < 0. || tile.s >= exp2(z) || tile.t >= exp2(z));
    abs_map = (tile + tile_p) * exp2(-z);
  <% } else if (geo_mode == 'linear') { %>
    hp_reco(base_tile * exp2(z), altUV * exp2(z), tile, tile_p);
    tile.s = mod(tile.s, exp2(z));

    out_of_bounds = (tile.s < 0. || tile.t < 0. || tile.s >= exp2(z) || tile.t >= exp2(z));
    abs_map = (tile + tile_p) * exp2(-z);
  <% } else { %>
    out_of_bounds = (abs_map.t < 0. || abs_map.t >= 1.);
  <% } %>


  <% if (output_mode == 'tile') { %>

     // zoom level - 5 bits
     // anti-pole - 1 bit
     // zoom bleed - 1 bit
     // tile fringe + dir - 5 bits
     // x offset - 6 bits
     // y offset - 6 bits

    float z_enc;
    vec2 tile_enc;

    if (out_of_bounds) {
        z_enc = 255.;
    } else {
      <% if (geo_mode != 'flat') { %>
        tile = floor(abs_map * exp2(z));
      <% } %>
        vec2 ref;

        z_enc = z;
        if (anti_pole) {
            z_enc += 32.; // next power of 2 >= MAX_ZOOM
            ref = anti_ref_t;
        } else { 
            ref = ref_t;
        }

        vec2 ref_tile = floor(ref * exp2(z));
        tile_enc = (tile - ref_tile) + 32.; // 2^(# offset bits - 1)
    }

    gl_FragColor = vec4(z_enc / 255., tile_enc.s / 255., tile_enc.t / 255., 1.);

  <% } %>

  <% if (output_mode == 'tex') { %>

    int tex_id;
    bool z_oob;
    vec2 atlas_p;

  <% if (geo_mode == 'flat') { %>
    tex_lookup_coord(z, anti_pole, tile, tile_p, tex_id, atlas_p, z_oob);
  <% } else { %>
    tex_lookup_abs(z, anti_pole, abs_map, tex_id, atlas_p, z_oob);
  <% } %>
  <% for (var i = 0; i < constants.MAX_ZOOM; i++) { %>        
    if (tex_id < 0 && z > 0.) {
        z -= 1.;
      <% if (geo_mode == 'flat') { %>
        vec2 _tile = .5 * tile;
        vec2 _offset = .5 * tile_p;
        hp_reco(_tile, _offset, tile, tile_p);
        tex_lookup_coord(z, anti_pole, tile, tile_p, tex_id, atlas_p, z_oob);
      <% } else { %>
        tex_lookup_abs(z, anti_pole, abs_map, tex_id, atlas_p, z_oob);
      <% } %>
    }
  <% } %>

    vec4 valA;
    tex_lookup_val(z, abs_map, z_oob, tex_id, atlas_p, valA);

   <% if (geo_mode == 'linear') { %>
      valA = .9 * valA + .1 * vec4(1., 1., 0., 1.);
   <% } %> 

    gl_FragColor = valA;
  <% } %>

}

