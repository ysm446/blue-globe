// 複数のシェーダーで共有する GLSL
export const FULLSCREEN_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const VALUE_NOISE_GLSL = /* glsl */ `
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 3.1;
    a *= 0.5;
  }
  return v;
}
`;

// 画素ごとに決まる 0〜1 の値 (interleaved gradient noise)。階調の帯や、歩幅の刻みの縞を隠す
export const PIXEL_JITTER_GLSL = /* glsl */ `
float pixelJitter() {
  return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
}
`;

// 雲に当たる太陽の色。ndl は法線と太陽の方向の内積で、太陽が低いと赤くなる
export const CLOUD_SUN_COLOR_GLSL = /* glsl */ `
vec3 cloudSunColor(float ndl) {
  float dusk = smoothstep(-0.08, 0.02, ndl) * (1.0 - smoothstep(0.02, 0.28, ndl));
  return mix(vec3(1.0, 0.99, 0.97), vec3(1.0, 0.6, 0.36), dusk * 0.8);
}
`;
