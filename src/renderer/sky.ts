// 実際の星、太陽、月。方向は本物で、太陽と月の大きさは見やすさのために誇張している
import * as THREE from 'three';
import { lonLatToVector3 } from './globe';
import { siderealDegrees, sublunarPoint, subsolarPoint } from './astro';
import starCatalog from './data/stars.json';

const STAR_DISTANCE = 90;
const SUN_DISTANCE = 85;
const SUN_HALF_SIZE = 22;
const MOON_DISTANCE = 60;
const MOON_RADIUS = 0.8; // 実際の約 3 倍

// [赤経, 赤緯, 等級, B-V 色指数] の配列 (Hipparcos 由来、6 等星まで)
const STARS = starCatalog as unknown as Array<[number, number, number, number]>;

const STAR_VS = /* glsl */ `
attribute vec3 starColor;
attribute float mag;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = starColor;
  float flux = pow(10.0, -0.4 * mag); // 等級から実際の明るさの比へ
  // 明るい星は画面の白を超える値にして、にじませる
  vAlpha = clamp(0.5 + 0.5 * pow(flux, 0.25), 0.0, 1.0) * (1.0 + 3.0 * pow(flux, 0.5));
  gl_PointSize = uPixelRatio * clamp(1.5 + 3.6 * pow(flux, 0.33), 1.5, 9.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const STAR_FS = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.25, d) * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
  #include <colorspace_fragment>
}
`;

// 月の模様は実データではなく、ノイズで作った見た目だけのもの
const MOON_VS = /* glsl */ `
varying vec3 vNormalDir;
void main() {
  vNormalDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MOON_FS = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
varying vec3 vNormalDir;
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
void main() {
  vec3 n = normalize(vNormalDir);
  float maria = smoothstep(0.42, 0.62, fbm(n * 3.2 + 4.0));
  float albedo = mix(0.82, 0.42, maria) * (0.88 + 0.24 * fbm(n * 22.0));
  float shade = pow(max(dot(n, uSunDir), 0.0), 0.7);
  gl_FragColor = vec4(vec3(albedo) * shade * 2.4 + vec3(0.006, 0.007, 0.011), 1.0);
  #include <colorspace_fragment>
}
`;

// 太陽は常にカメラを向く板に、計算で光を描く。画像だと暗い部分の階調が足りず、
// 明るさを上げたときに同心円や点の模様が出る
const SUN_VS = /* glsl */ `
varying vec2 vOffset;
void main() {
  vOffset = position.xy;
  vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  center.xy += position.xy * ${SUN_HALF_SIZE.toFixed(1)};
  gl_Position = projectionMatrix * center;
}
`;

const SUN_FS = /* glsl */ `
precision highp float;
varying vec2 vOffset;
void main() {
  float d = length(vOffset);
  // 明るい部分を広げるとブルームの処理で四角くにじむので、中心だけを小さく明るくする。
  // 周りの光はここで丸く描く
  float core = smoothstep(0.02, 0.012, d) * 4.0;
  float glow = (0.0009 / (d * d + 0.0009) * 1.5 + 0.012 / (d + 0.03) * 0.35) * smoothstep(1.0, 0.2, d);
  gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * core + vec3(1.0, 0.84, 0.62) * glow, 1.0);
  #include <colorspace_fragment>
}
`;

function createStars(pixelRatio: number): THREE.Points {
  const positions = new Float32Array(STARS.length * 3);
  const colors = new Float32Array(STARS.length * 3);
  const mags = new Float32Array(STARS.length);
  const position = new THREE.Vector3();
  const color = new THREE.Color();
  STARS.forEach(([ra, dec, mag, bv], i) => {
    // 恒星時 0 の配置で置き、時刻の分は回転で与える
    lonLatToVector3(ra, dec, STAR_DISTANCE, position).toArray(positions, i * 3);
    const warm = Math.min(1, Math.max(0, (bv + 0.3) / 1.8));
    color.setRGB(0.72 + warm * 0.28, 0.82 + warm * 0.02, 1 - warm * 0.5).toArray(colors, i * 3);
    mags[i] = mag;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('starColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('mag', new THREE.BufferAttribute(mags, 1));
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: pixelRatio } },
      vertexShader: STAR_VS,
      fragmentShader: STAR_FS,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  points.frustumCulled = false;
  return points;
}

function createSun(): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      vertexShader: SUN_VS,
      fragmentShader: SUN_FS,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  mesh.frustumCulled = false;
  return mesh;
}

export class Sky {
  readonly group = new THREE.Group();
  readonly sunDir = new THREE.Vector3(1, 0, 0);
  readonly moonDir = new THREE.Vector3(0, 0, 1);
  readonly sunPosition = new THREE.Vector3(1, 0, 0);
  private readonly stars: THREE.Points;
  private readonly sun = createSun();
  private readonly moon: THREE.Mesh;

  constructor(pixelRatio: number) {
    this.stars = createStars(pixelRatio);
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(MOON_RADIUS, 64, 48),
      new THREE.ShaderMaterial({
        uniforms: { uSunDir: { value: this.sunDir } },
        vertexShader: MOON_VS,
        fragmentShader: MOON_FS,
      }),
    );
    this.group.add(this.stars, this.sun, this.moon);
  }

  setTime(date: Date): void {
    // 星は恒星時の分だけ西へ回る (three.js の Y 回転は経度を増やす向き)
    this.stars.rotation.y = THREE.MathUtils.degToRad(-siderealDegrees(date) % 360);
    const sun = subsolarPoint(date);
    lonLatToVector3(sun.lon, sun.lat, 1, this.sunDir);
    this.sunPosition.copy(this.sunDir).multiplyScalar(SUN_DISTANCE);
    this.sun.position.copy(this.sunPosition);
    const moon = sublunarPoint(date);
    lonLatToVector3(moon.lon, moon.lat, 1, this.moonDir);
    this.moon.position.copy(this.moonDir).multiplyScalar(MOON_DISTANCE);
  }
}
