// 実際の星、惑星、太陽、月。方向は本物で、月の大きさは見やすさのために少し誇張している
import * as THREE from 'three';
import { VALUE_NOISE_GLSL } from './glsl';
import { lonLatToVector3 } from './globe';
import { siderealDegrees, starIntensity, sublunarPoint, subsolarPoint } from './astro';
import { PLANETS, planetSky } from './planets';
import starCatalog from './data/stars.json';

const STAR_DISTANCE = 90;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const SUN_DISTANCE = 85;
const SUN_HALF_SIZE = 22;
const MOON_DISTANCE = 60;
const MOON_RADIUS = 0.4; // 実際の約 1.5 倍。太陽の芯はほぼ実際の大きさなので、並んだときに差が目立たない程度にする

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

// 月の模様は実データではなく、ノイズで作った見た目だけのもの。
// 明るさは地球の雲 (約 0.86) より十分暗くする。実際の月の反射率は約 0.12 で、地球と並ぶと灰色に見える。
// 満月は縁まで平坦に明るい (強い逆散乱) ので、縁の暗さは弱い曲線にする
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
${VALUE_NOISE_GLSL}
void main() {
  vec3 n = normalize(vNormalDir);
  float maria = smoothstep(0.42, 0.62, fbm(n * 3.2 + 4.0));
  float albedo = mix(0.36, 0.18, maria) * (0.88 + 0.24 * fbm(n * 22.0));
  float shade = pow(max(dot(n, uSunDir), 0.0), 0.35);
  gl_FragColor = vec4(vec3(albedo) * shade + vec3(0.006, 0.007, 0.011), 1.0);
  #include <colorspace_fragment>
}
`;

// 太陽は常にカメラを向く板に、計算で光を描く。画像だと暗い部分の階調が足りず、
// 明るさを上げたときに同心円や点の模様が出る
const SUN_VS = /* glsl */ `
uniform float uHalfSize;
varying vec2 vOffset;
void main() {
  vOffset = position.xy;
  vec4 center = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  center.xy += position.xy * uHalfSize;
  gl_Position = projectionMatrix * center;
}
`;

const SUN_FS = /* glsl */ `
precision highp float;
uniform vec3 uTint;
varying vec2 vOffset;
void main() {
  float d = length(vOffset);
  // 明るい部分を広げるとブルームの処理で四角くにじむので、中心だけを小さく明るくする。
  // 周りの光はここで丸く描く
  float core = smoothstep(0.02, 0.012, d) * 4.0;
  float glow = (0.0009 / (d * d + 0.0009) * 1.5 + 0.012 / (d + 0.03) * 0.35) * smoothstep(1.0, 0.2, d);
  gl_FragColor = vec4((vec3(1.0, 0.97, 0.9) * core + vec3(1.0, 0.84, 0.62) * glow) * uTint, 1.0);
  #include <colorspace_fragment>
}
`;

// 色指数から色へ。色で明るさが変わらないよう、輝度を 1 に揃える
function setStarColor(bv: number, color: THREE.Color): THREE.Color {
  const warm = Math.min(1, Math.max(0, (bv + 0.3) / 1.8));
  const r = 0.72 + warm * 0.28;
  const g = 0.82 + warm * 0.02;
  const b = 1 - warm * 0.5;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return color.setRGB(r / luminance, g / luminance, b / luminance);
}

type StarUniforms = { uPixelRatio: { value: number }; uBrightness: { value: number } };

// 星と惑星で同じ描き方と明るさの倍率を使う
function createPoints(count: number, uniforms: StarUniforms): THREE.Points {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('starColor', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute('intensity', new THREE.BufferAttribute(new Float32Array(count), 1));
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      uniforms,
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

function createStars(uniforms: StarUniforms): THREE.Points {
  const points = createPoints(STARS.length, uniforms);
  const { position, starColor, intensity } = points.geometry.attributes;
  const vector = new THREE.Vector3();
  const color = new THREE.Color();
  STARS.forEach(([ra, dec, mag, bv], i) => {
    // 恒星時 0 の配置で置き、時刻の分は回転で与える
    lonLatToVector3(ra, dec, STAR_DISTANCE, vector).toArray(position.array, i * 3);
    setStarColor(bv, color).toArray(starColor.array, i * 3);
    intensity.array[i] = starIntensity(mag);
  });
  return points;
}

// halfSize は板の半分の大きさ。描く距離に対する比で、見かけの大きさが決まる
export function createSun(halfSize: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      uniforms: { uHalfSize: { value: halfSize }, uTint: { value: new THREE.Vector3(1, 1, 1) } },
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

// 太陽の板の大きさと描く距離の比。太陽系の場面でも、地球から見たときに同じ見かけになるよう使う
export const SUN_SIZE_RATIO = SUN_HALF_SIZE / SUN_DISTANCE;

export class Sky {
  readonly group = new THREE.Group();
  readonly sunDir = new THREE.Vector3(1, 0, 0);
  readonly moonDir = new THREE.Vector3(0, 0, 1);
  readonly sunPosition = new THREE.Vector3(1, 0, 0);
  // 名前を添えるための、惑星の世界座標での位置
  readonly planets = PLANETS.map((planet) => ({ name: planet.name, position: new THREE.Vector3() }));
  private readonly starUniforms: StarUniforms;
  // 太陽系の場面でも同じ星を描くので、形と見た目は共有する
  readonly stars: THREE.Points;
  private readonly planetPoints: THREE.Points;
  private readonly planetOffsets = PLANETS.map(() => new THREE.Vector3()); // カメラから見た位置
  private readonly sun = createSun(SUN_HALF_SIZE);
  private readonly moon: THREE.Mesh;

  constructor(pixelRatio: number) {
    this.starUniforms = { uPixelRatio: { value: pixelRatio }, uBrightness: { value: 1 } };
    this.stars = createStars(this.starUniforms);
    // 惑星は星と同じ座標で置き、星と一緒に回す
    this.planetPoints = createPoints(PLANETS.length, this.starUniforms);
    this.stars.add(this.planetPoints);
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

  // 星と太陽は無限に遠いものとして、カメラを中心に置く。カメラがどこへ動いても星空がずれない。
  // 月は地球を中心に回るので動かさない。描く前に毎フレーム呼ぶ
  follow(camera: THREE.Vector3): void {
    this.stars.position.copy(camera);
    this.sunPosition.copy(this.sunDir).multiplyScalar(SUN_DISTANCE).add(camera);
    this.sun.position.copy(this.sunPosition);
    this.planetOffsets.forEach((offset, i) => this.planets[i].position.copy(offset).add(camera));
  }

  // 地平線の近くで大気を長く通った太陽の色。白は (1, 1, 1)
  setSunTint(tint: THREE.Vector3): void {
    (this.sun.material as THREE.ShaderMaterial).uniforms.uTint.value.copy(tint);
  }

  // 太陽系の場面が星と太陽を描く間は、こちらでは月だけを描く
  setBackdropVisible(visible: boolean): void {
    this.stars.visible = visible;
    this.sun.visible = visible;
  }

  // 星を回している角度 (恒星時の分)。太陽系の場面とこの場面の向きを合わせるのに使う
  get siderealRotation(): number {
    return this.stars.rotation.y;
  }

  setPixelRatio(pixelRatio: number): void {
    this.starUniforms.uPixelRatio.value = pixelRatio;
  }

  // 全ての星と惑星に同じ倍率を掛ける。互いの明るさの比は変わらない
  setStarBrightness(brightness: number): void {
    this.starUniforms.uBrightness.value = brightness;
  }

  setTime(date: Date): void {
    // 星は恒星時の分だけ西へ回る (three.js の Y 回転は経度を増やす向き)
    this.stars.rotation.y = THREE.MathUtils.degToRad(-siderealDegrees(date) % 360);
    this.stars.updateMatrix();
    this.updatePlanets(date);
    const sun = subsolarPoint(date);
    lonLatToVector3(sun.lon, sun.lat, 1, this.sunDir);
    const moon = sublunarPoint(date);
    lonLatToVector3(moon.lon, moon.lat, 1, this.moonDir);
    this.moon.position.copy(this.moonDir).multiplyScalar(MOON_DISTANCE);
  }

  private updatePlanets(date: Date): void {
    const { position, starColor, intensity } = this.planetPoints.geometry.attributes;
    const color = new THREE.Color();
    planetSky(date).forEach((planet, i) => {
      const local = lonLatToVector3(planet.ra, planet.dec, STAR_DISTANCE);
      local.toArray(position.array, i * 3);
      setStarColor(planet.bv, color).toArray(starColor.array, i * 3);
      intensity.array[i] = starIntensity(planet.magnitude);
      this.planetOffsets[i].copy(local).applyAxisAngle(Y_AXIS, this.stars.rotation.y);
    });
    position.needsUpdate = true;
    starColor.needsUpdate = true;
    intensity.needsUpdate = true;
  }
}
