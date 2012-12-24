varying vec2 merc;

void main() {
    merc = uv;
    gl_Position = projectionMatrix * 
                  modelViewMatrix * 
                  vec4(position, 1.0);
}
