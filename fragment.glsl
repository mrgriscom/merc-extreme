// -*- mode: c -*-

#define PI  3.1415926535
#define PI2 6.2831853071
#define TILE_SIZE 256.
#define ATLAS_TEX_SIZE 4096.

// TODO lots of constants in here that should be tied to js constants

uniform vec2 pole;    // lat/lon degrees
uniform vec2 pole_t;  // maptile coordinates
uniform vec2 ref_t;
uniform float scale;  // pixels per earth circumference (undistorted)
uniform float bias;   // overzoom is capped at 2^bias

uniform vec2 hp_pole_tile;
uniform vec2 hp_pole_offset;

varying vec2 merc;  // projected mercator unit coordinates: lon:[-180,180] => x:[0,1], lat:0 => y:0

uniform sampler2D tx_ix;
uniform sampler2D tx_atlas[1];
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

    float latrot = rpole.t - .5 * PI;
    vec3 xyz_trans = mat3( // shift lat +90 to pole lat
        cos(latrot), 0, sin(latrot),
        0, 1, 0,
        -sin(latrot), 0, cos(latrot)
    ) * xyz;
    xyz_to_llr(xyz_trans, llr_trans);
    llr_trans.s += rpole.s; // shift lon 0 to pole lon
}

void tex_lookup_by_tile(in float z, in bool anti_pole, in vec2 tile, in vec2 tile_p, out int tex_id, out vec2 offset, out vec2 atlas_p) {
    vec4 x_offset_enc = texture2D(tx_ix, (vec2(z, 256.*float(anti_pole)+63.) + .5) / 512.);
    vec4 y_offset_enc = texture2D(tx_ix, (vec2(z, 256.*float(anti_pole)+62.) + .5) / 512.);
    offset = 32. * vec2(256 * int(255. * x_offset_enc.r) + int(255. * x_offset_enc.g),
                        256 * int(255. * y_offset_enc.r) + int(255. * y_offset_enc.g));

    vec4 slot_enc = texture2D(tx_ix, (64. * vec2(mod(z, 8.), floor(z / 8.) + 4. * float(anti_pole)) - offset + tile + .5) / 512.);
    tex_id = int(255. * slot_enc.r) - 1;
    int slot_x = int(255. * slot_enc.g);
    int slot_y = int(255. * slot_enc.b);
    atlas_p = (vec2(slot_x, slot_y) + tile_p) / (ATLAS_TEX_SIZE / TILE_SIZE);
}

void tex_lookup(in float z, in bool anti_pole, in vec2 abs_map, out int tex_id, out vec2 tile, out vec2 offset, out vec2 atlas_p) {
    vec2 abs_map_z = abs_map * pow(2., z);
    tile = floor(abs_map_z);
    vec2 tile_p = mod(abs_map_z, 1.);

    tex_lookup_by_tile(z, anti_pole, tile, tile_p, tex_id, offset, atlas_p);
}

void frag_val(in float z, in vec2 abs_map, in vec2 tile, in vec2 offset, in int tex_id, in vec2 atlas_p, out vec4 val) {
    if (z == 0.) {
        val = texture2D(tx_z0, vec2(abs_map.s, .5 * (abs_map.t + .5)));
    } else if (tile.s < offset.s || tile.t < offset.t || tile.s >= offset.s + 64. || tile.t >= offset.t + 64.) {
        val = vec4(1, 0, 0, 1);
    } else if (tex_id >= 0) {
        val = texture2D(tx_atlas[0], atlas_p);
    } else {
        val = vec4(.65, .7, .75, 1.);
    }
}

void hp_reco(in vec2 told, in vec2 oold, out vec2 tnew, out vec2 onew) {
  oold += fract(told);
  tnew = floor(told) + floor(oold);
  onew = fract(oold);
}


void main() {
    vec2 merc_rad = (merc + vec2(-.5, 0)) * PI2; // projected mercator radians: lon:[-180:180] => x:[-pi, pi]
    vec2 geo_rad = vec2(merc_rad.s, 2. * atan(exp(merc_rad.t)) - .5 * PI); // geographic coordinates, radians

    vec2 abs_geo_rad;
    translate_pole(geo_rad, pole, abs_geo_rad);

    vec2 abs_merc_rad = vec2(abs_geo_rad.s, log(tan(.5 * abs_geo_rad.t + .25 * PI))); // projected mercator coordinates, radians
    mat3 merc_map_tx = mat3(
      1./PI2, 0, 0,
      0, -1./PI2, 0,
      .5, .5, 1
    );
    vec2 abs_map = vec2(merc_map_tx * vec3(abs_merc_rad.s, abs_merc_rad.t, 1.)); // map tile coordiantes: lon:[-180,180] => x:[0,1], lat:[-90,90] => y:[+inf,-inf]
    abs_map.x = mod(abs_map.x, 1.);

    bool out_of_bounds = (abs_map.t < 0. || abs_map.t >= 1.);
    bool out_of_bounds_fuzzy = (abs_map.t < -0.5 || abs_map.t >= 1.5);
    bool anti_pole = (merc.t < 0.);
    float res = PI2 / scale * cos(geo_rad.t); // radians per pixel

    // compensate for the fact the map imagery is mercator projected, and has higher resolution towards the poles
    float base_distortion = cos(abs_geo_rad.t);
    float base_res = PI2 / TILE_SIZE * base_distortion; // radians per pixel offered by the lowest zoom layer
    float fzoom = log2(base_res / res) - bias; // necessary zoom level (on a continuous scale)

#ifdef MODE_TILE

    float z_enc;
    vec2 tile_enc;

    float z = max(ceil(fzoom), 0.);

    if (out_of_bounds) {
        z_enc = 255.;
    } else {
        vec2 tile = floor(abs_map * pow(2., z));
        vec2 ref_t2;

        z_enc = z;
        if (anti_pole) {
            z_enc += 32.;
            ref_t2 = vec2(mod(ref_t.s + .5, 1.), 1. - ref_t.t); // antipode
        } else {
            ref_t2 = ref_t;
        }

        vec2 ref_tile = floor(ref_t2 * pow(2., z));
        tile_enc = (tile - ref_tile) + 128.;
    }

    gl_FragColor = vec4(z_enc / 255., tile_enc.s / 255., tile_enc.t / 255., 1.);

#endif

#ifdef MODE_TEX

    // TODO maybe: blending across zoom level transitions

    float z = ceil(fzoom);
    z = max(z, 0.); // TODO mipmap for zoom level 0 (-z is lod)

    // testing
    float zmax = 30.; //16.;
    z = min(z, zmax);

    // TODO want to support linear blending -- means must be incorporated into tile cache texture
    if (out_of_bounds_fuzzy) {
        gl_FragColor = vec4(1, 1, 0, 1);
    } else {     

        int tex_id;
        vec2 tile;
        vec2 offset;
        vec2 atlas_p;

        tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);

        
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }       
        if (tex_id < 0 && z > 0.) {
          z -= 1.;
          tex_lookup(z, anti_pole, abs_map, tex_id, tile, offset, atlas_p);
        }


        vec4 valA;

        float prec_buffer = 3.;
        if (true && abs(geo_rad.t) > acos(min(scale / pow(2., 23. - prec_buffer), 1.))) {
          float dist = 2. * exp(-merc.t * PI2) / PI2 / cos(radians(pole.t));
          vec2 ray = dist * vec2(sin(merc_rad.s), cos(merc_rad.s));

          vec2 tnew;
          vec2 onew;
          hp_reco(hp_pole_tile * pow(2., z - 16.), hp_pole_offset * pow(2., z) + ray * pow(2., z), tnew, onew);
          // need to mod tile_x

          int tex_id;
          vec2 offset;
          vec2 atlas_p;
          tex_lookup_by_tile(z, anti_pole, tnew, onew, tex_id, offset, atlas_p);
          frag_val(z, abs_map, tile, offset, tex_id, atlas_p, valA);

          valA = .95 * valA + .05 * vec4(1.,0.,1.,1.);
        } else {
          frag_val(z, abs_map, tile, offset, tex_id, atlas_p, valA);
        }
        gl_FragColor = valA; //(1. - (z - fzoom)) * valA + (z - fzoom) * valB;
        //gl_FragColor = vec4(z / 22., floor(mod(tile.s, 2.)), floor(mod(tile.t, 2.)), 1.);
   
    }
#endif

}

