// 実際の星、太陽、月。方向は本物で、太陽と月の大きさは見やすさのために誇張している
import * as THREE from 'three';
import { lonLatToVector3 } from './globe';
import { siderealDegrees, starIntensity, sublunarPoint, subsolarPoint } from './astro';
import starCatalog from './data/stars.json';

const STAR_DISTANCE = 90;
const SUN_DISTANCE = 85;
const SUN_HALF_SIZE = 22;
const MOON_DISTANCE = 60;
const MOON_RADIUS = 0.8; // 実際の約 3 倍

// [赤経, 赤緯, 等級, B-V 色指数] の配列 (Hipparcos 由来、6 等星まで)
const STARS = starCatalog as unknown as Array<[number, number, number, number]>;

// 明るさは等級どおりの比で計算する。明るい星は中心が白く飽和し、飽和した範囲の大きさと周りの光で差が出る。
// 値をブルームのしきい値より低く抑える。ブルームに通すと明るい点が四角くにじむので、周りの光はここで丸く描く
const STAR_SHARPNESS_RADIUS = 0.5; // 中心の広がり (CSS ピクセル)。小さいほど鋭い
const STAR_FADE_LEVEL = 0.002; // ここまで暗くなる範囲を描く
const STAR_PEAK = 1.9; // 中心の上限
const STAR_MAX_HALO = 0.6; // 周りの光の上限。中心との合計がブルームのしきい値 (2.6) を超えない値にする

const STAR_VS = /* glsl */ `
attribute vec3 starColor;
attribute float intensity;
uniform float uPixelRatio;
uniform float uBrightness;
varying vec3 vColor;
varying float vIntensity;
varying float vSigma;
varying float vPointSize;
varying float vHalo;
varying float vHaloRadius;
void main() {
  vColor = starColor;
  vIntensity = intensity * uBrightness;
  vSigma = ${STAR_SHARPNESS_RADIUS.toFixed(2)} * uPixelRatio;
  float coreRadius = vSigma * sqrt(2.0 * log(max(vIntensity / ${STAR_FADE_LEVEL.toFixed(3)}, 1.5)));
  vHalo = min(vIntensity * 0.05, ${STAR_MAX_HALO.toFixed(2)});
  vHaloRadius = vSigma * (2.0 + 9.0 * clamp(log(max(vIntensity, 1.0)) / log(30.0), 0.0, 1.0));
  vPointSize = 2.0 * max(coreRadius, vHaloRadius) + 2.0;
  gl_PointSize = vPointSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const STAR_FS = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vIntensity;
varying float vSigma;
varying float vPointSize;
varying float vHalo;
varying float vHaloRadius;
void main() {
  float r = length(gl_PointCoord - 0.5) * vPointSize;
  float core = min(vIntensity * exp(-r * r / (2.0 * vSigma * vSigma)), ${STAR_PEAK.toFixed(1)});
  float t = clamp(1.0 - r / vHaloRadius, 0.0, 1.0);
  float halo = vHalo * t * t / (1.0 + r * r / (4.0 * vSigma * vSigma));
  gl_FragColor = vec4(vColor * (core + halo), 1.0); // 加算合成は透明度を掛けるので 1 にする
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
  gl_FragColor = vec4(vec3(albedo) * shade * 1.3 + vec3(0.006, 0.007, 0.011), 1.0);
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
  const intensities = new Float32Array(STARS.length);
  const position = new THREE.Vector3();
  const color = new THREE.Color();
  STARS.forEach(([ra, dec, mag, bv], i) => {
    // 恒星時 0 の配置で置き、時刻の分は回転で与える
    lonLatToVector3(ra, dec, STAR_DISTANCE, position).toArray(positions, i * 3);
    const warm = Math.min(1, Math.max(0, (bv + 0.3) / 1.8));
    // 色で明るさが変わらないよう、輝度を 1 に揃える
    const r = 0.72 + warm * 0.28;
    const g = 0.82 + warm * 0.02;
    const b = 1 - warm * 0.5;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    color.setRGB(r / luminance, g / luminance, b / luminance).toArray(colors, i * 3);
    intensities[i] = starIntensity(mag);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('starColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('intensity', new THREE.BufferAttribute(intensities, 1));
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: pixelRatio }, uBrightness: { value: 1 } },
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

  setPixelRatio(pixelRatio: number): void {
    (this.stars.material as THREE.ShaderMaterial).uniforms.uPixelRatio.value = pixelRatio;
  }

  // 全ての星に同じ倍率を掛ける。星同士の明るさの比は変わらない
  setStarBrightness(brightness: number): void {
    (this.stars.material as THREE.ShaderMaterial).uniforms.uBrightness.value = brightness;
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
