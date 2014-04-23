// -*- mode: c -*-

varying vec2 merc;
varying vec2 altUV;

void main() {
    merc = uv;
    altUV = uv2;
    gl_Position = projectionMatrix * 
                  modelViewMatrix * 
                  vec4(position, 1.0);
}
