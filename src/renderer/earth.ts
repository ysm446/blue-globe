// 写実的な地球。地表写真、夜の街明かり、大気の縁、雲の層を描く。
// 雲は天気モードのときだけ表示し (setCloudsEnabled)、地表より少し高い別の球に載せる。
// 回すと地面とずれて動くので、ボリューム雲を使わなくても高さが感じられる
import * as THREE from 'three';
import { easeFade, stepFade } from './fade';
import type { RegionDetail } from './region-detail';
import { TILE_DEGREES, WINDOW_TILES } from './tile-window';

const CLOUD_ALTITUDE = 0.012; // 実際より高い。視差が見える程度に誇張している
const DEFAULT_CLOUD_SHADOW = 0.55;
const REGION_LIGHTS = 1.8; // にじませず、都市の中の濃淡が残る明るさ
const REGION_CLOUD_ALTITUDE = 0.002; // 斜めに見ると誇張した分だけ雲が地面からずれるので、地域ビューでは実際に近づける
const REGION_HAZE = 0.3; // 縁の青は地球全体を見るためのもので、斜めの視点では画面の大半に乗ってしまう
const REGION_ATMOSPHERE_THINNESS = 3; // 大気の層も地球全体を見るために厚い。そのままだと空全体が青くなる

const VS = /* glsl */ `
varying vec3 vPos;
varying vec2 vUv;
void main() {
  vPos = position;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// SphereGeometry の UV は u=0 が経度 -180 度、v=1 が北極。雲マップは左端が -180 度、1 行目が北端。
// 別の点の UV を引くときは atan の継ぎ目でミップマップが乱れないよう、元の UV の微分を渡す
const CLOUD_SAMPLING_GLSL = /* glsl */ `
uniform sampler2D uCloud;
vec2 cloudUvOf(vec3 n) {
  float angle = atan(n.z, -n.x);
  float u = angle / 6.28318530718 + (angle < 0.0 ? 1.0 : 0.0);
  return vec2(u, 0.5 - asin(clamp(n.y, -1.0, 1.0)) / 3.14159265359);
}
float cloudAt(vec3 n, vec2 dx, vec2 dy) {
  return textureGrad(uCloud, cloudUvOf(n), dx, dy).r;
}
`;

const EARTH_FS = /* glsl */ `
precision highp float;
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform float uShadowAmount;
uniform float uCloudAltitude;
uniform float uShadowStrength;
uniform float uHaze;
uniform vec3 uSunDir;
uniform float uRegion;
uniform float uHasRelief;
uniform float uHasDetail;
uniform sampler2D uRelief;
uniform sampler2D uDetailDay;
uniform sampler2D uDetailNight;
uniform sampler2D uDetailMask;
uniform vec2 uDetailCenter;
varying vec3 vPos;
varying vec2 vUv;
${CLOUD_SAMPLING_GLSL}
void main() {
  vec3 n = normalize(vPos);
  vec3 view = normalize(cameraPosition - vPos);
  float ndl = dot(n, uSunDir);
  float light = smoothstep(-0.06, 0.55, ndl);
  float dayMask = smoothstep(-0.1, 0.1, ndl);

  vec3 day = texture2D(uDay, vUv).rgb;
  float night = texture2D(uNight, vUv).r;
  if (uRegion > 0.0) {
    // 高解像度の画像と境目が出ないよう、地域ビューでは周囲も同じ種類の画像にする
    if (uHasRelief > 0.5) day = mix(day, texture2D(uRelief, vUv).rgb, uRegion);
    if (uHasDetail > 0.5) {
      // タイルの列と行で表した座標。列は範囲の中心から連続させ、日付変更線で途切れないようにする
      float lon = atan(n.z, -n.x) * 57.29577951 - 180.0;
      float centerLon = uDetailCenter.x * ${TILE_DEGREES.toFixed(2)} - 180.0;
      float offset = mod(lon - centerLon + 180.0, 360.0) - 180.0;
      vec2 tile = vec2(
        uDetailCenter.x + offset / ${TILE_DEGREES.toFixed(2)},
        (90.0 - asin(clamp(n.y, -1.0, 1.0)) * 57.29577951) / ${TILE_DEGREES.toFixed(2)}
      );
      vec2 fromCenter = abs(tile - uDetailCenter);
      float half_ = ${(WINDOW_TILES / 2).toFixed(1)};
      float inside = smoothstep(half_, half_ - 0.5, max(fromCenter.x, fromCenter.y));
      vec2 detailUv = tile / ${WINDOW_TILES.toFixed(1)};
      vec2 dx = dFdx(detailUv);
      vec2 dy = dFdy(detailUv);
      vec2 mask = texture2D(uDetailMask, detailUv).rg * inside * uRegion;
      day = mix(day, textureGrad(uDetailDay, detailUv, dx, dy).rgb, mask.r);
      night = mix(night, textureGrad(uDetailNight, detailUv, dx, dy).r, mask.g);
    }
  }
  float ocean = smoothstep(0.02, 0.1, day.b - day.r);

  // 雲の影。太陽が低いほど長く伸びる
  float shadow = 0.0;
  if (uShadowAmount > 0.0 && dayMask > 0.0) {
    vec3 toSun = normalize(uSunDir - n * ndl + vec3(1e-5));
    float sinZenith = sqrt(max(1.0 - ndl * ndl, 0.0));
    float reach = min(uCloudAltitude * sinZenith / max(ndl, 0.12), 0.08);
    float caster = cloudAt(normalize(n + toSun * reach), dFdx(vUv), dFdy(vUv));
    shadow = smoothstep(0.15, 0.75, caster) * uShadowStrength * uShadowAmount;
  }

  vec3 color = day * 1.5 * light * (1.0 - shadow);

  // 太陽の映り込み (海だけ)
  vec3 halfway = normalize(uSunDir + view);
  color += vec3(1.0, 0.92, 0.8) * pow(max(dot(n, halfway), 0.0), 90.0) * 4.0 * ocean * (1.0 - shadow) * dayMask;

  // 街明かりは夜側だけ
  float lights = pow(smoothstep(0.1, 1.0, night), 1.4) * (1.0 - dayMask);
  // 画面の白より明るくして、にじませる。地域ビューは街の形が見えるよう、にじまない明るさに抑える
  color += vec3(1.0, 0.6, 0.26) * lights * mix(4.5, ${REGION_LIGHTS.toFixed(1)}, uRegion);

  // 回して触ったときに場所が分かるよう、夜側でも陸と海がうっすら見える光を残す。
  // 地域ビューの画像は海が明るいので、海を特に暗くする
  float nightFill = mix(1.0, mix(0.7, 0.3, ocean), uRegion);
  color += (day * vec3(0.22, 0.27, 0.4) + vec3(0.003, 0.006, 0.014)) * (1.0 - dayMask) * nightFill;

  // 地表から見える大気 (縁ほど青い)。昼側だけ
  float fresnel = pow(1.0 - max(dot(n, view), 0.0), 3.2);
  color += vec3(0.22, 0.48, 1.0) * fresnel * smoothstep(-0.15, 0.45, ndl) * 1.2 * uHaze;
  color += vec3(0.07, 0.16, 0.34) * light * 0.35 * uHaze;

  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

const CLOUD_FS = /* glsl */ `
precision highp float;
uniform float uHaze;
uniform vec3 uSunDir;
uniform float uFade;
varying vec3 vPos;
varying vec2 vUv;
${CLOUD_SAMPLING_GLSL}
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
  vec3 n = normalize(vPos);
  vec3 view = normalize(cameraPosition - vPos);
  vec2 dx = dFdx(vUv);
  vec2 dy = dFdy(vUv);
  float base = textureGrad(uCloud, vec2(vUv.x, 1.0 - vUv.y), dx, dy).r;
  if (base < 0.01) discard;

  // 細部。厚いところは元データの形を保つ。ごく薄いところはノイズを濃さに比例させ、
  // ノイズだけで白い塊ができないようにする
  vec3 warp = vec3(fbm(n * 9.0 + 1.3), fbm(n * 9.0 + 7.1), 0.0) - 0.5;
  float detail = fbm(n * 38.0 + warp * 1.6);
  float noiseAmount = min(base * 1.1, 0.32) * (1.0 - smoothstep(0.4, 0.9, base));
  float d = clamp(base + (detail - 0.5) * noiseAmount, 0.0, 1.0);

  // 半透明。光の通りにくさは厚みに対して指数的で、縁では視線が雲を長く通るので濃くなる
  float pathLength = 1.0 / max(dot(n, view), 0.25);
  float opticalDepth = d * d * 1.2 + d * 0.75;
  // 厚みに掛けるので、厚い雲から先に見え始め、薄い雲が後から広がる
  opticalDepth *= mix(1.0, pathLength, 0.45) * uFade;
  // 縁はぼかす。ここで切れると、地球の輪郭が雲の形でギザギザになる
  float limb = smoothstep(0.0, 0.14, dot(n, view));
  float alpha = (1.0 - exp(-opticalDepth)) * limb;

  // 立体感。太陽の方向へ数点たどり、手前にある雲に遮られた分だけ暗くする
  float ndl = dot(n, uSunDir);
  vec3 toSun = normalize(uSunDir - n * ndl + vec3(1e-5));
  float blocked = 0.0;
  blocked += cloudAt(normalize(n + toSun * 0.005), dx, dy) * 0.4;
  blocked += cloudAt(normalize(n + toSun * 0.012), dx, dy) * 0.3;
  blocked += cloudAt(normalize(n + toSun * 0.024), dx, dy) * 0.2;
  blocked += cloudAt(normalize(n + toSun * 0.042), dx, dy) * 0.1;
  float slope = sqrt(max(1.0 - ndl * ndl, 0.0)); // 真上からの光では陰ができない
  float relief = blocked - base * 0.75;
  float transmit = clamp(exp(-max(blocked, 0.0) * 1.15 * slope) + (-relief) * 0.9 * slope, 0.0, 1.0);

  float light = smoothstep(-0.06, 0.5, ndl);
  float dusk = smoothstep(-0.08, 0.02, ndl) * (1.0 - smoothstep(0.02, 0.28, ndl));
  vec3 sunColor = mix(vec3(1.0, 0.99, 0.97), vec3(1.0, 0.6, 0.36), dusk * 0.8);
  // 影の部分は黒くせず、空の光を受けた青灰色にする
  vec3 lit = mix(vec3(0.3, 0.36, 0.48), vec3(0.88), transmit);
  vec3 color = lit * sunColor * light + vec3(0.016, 0.021, 0.036);

  // 縁の雲にも大気の青を重ねる
  float fresnel = pow(1.0 - max(dot(n, view), 0.0), 3.2);
  color += vec3(0.16, 0.36, 0.8) * fresnel * smoothstep(-0.15, 0.45, ndl) * 0.7 * uHaze;

  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}
`;

// 地球の外側に見える大気の光。裏面だけを描く少し大きい球で表す
const ATMOSPHERE_FS = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform float uThinness;
varying vec3 vPos;
void main() {
  vec3 n = normalize(vPos);
  vec3 ray = normalize(vPos - cameraPosition);
  // 視線が地球の中心に最も近づく高さで濃さを決める。大気の中から上を向く視線では、カメラの高さになる
  float along = dot(cameraPosition, ray);
  float closest = along < 0.0 ? sqrt(max(dot(cameraPosition, cameraPosition) - along * along, 0.0)) : length(cameraPosition);
  closest = 1.0 + (closest - 1.0) * uThinness;
  float exitAngle = sqrt(max(1.0 - pow(closest / length(vPos), 2.0), 0.0));
  float inner = smoothstep(0.0, 0.38, exitAngle);
  float lit = smoothstep(-0.25, 0.55, dot(n, uSunDir));
  float a = pow(inner, 2.6) * lit * 0.9;
  gl_FragColor = vec4(vec3(0.27, 0.55, 1.0) * a, a);
  #include <colorspace_fragment>
}
`;

export class RealisticEarth {
  readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly cloudMesh: THREE.Mesh;
  private readonly cloudMaterial: THREE.ShaderMaterial;
  private readonly sunDir = new THREE.Vector3(1, 0, 0);
  private cloudTexture: THREE.DataTexture | null = null;
  private cloudsWanted = false;
  private cloudFade = 0;
  private readonly haze = { value: 1 };
  private readonly atmosphereThinness = { value: 1 };

  constructor(private readonly radius: number) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uDay: { value: null },
        uNight: { value: null },
        uCloud: { value: null },
        uShadowAmount: { value: 0 },
        uCloudAltitude: { value: CLOUD_ALTITUDE },
        uShadowStrength: { value: DEFAULT_CLOUD_SHADOW },
        uHaze: this.haze,
        uRegion: { value: 0 },
        uHasRelief: { value: 0 },
        uHasDetail: { value: 0 },
        uRelief: { value: null },
        uDetailDay: { value: null },
        uDetailNight: { value: null },
        uDetailMask: { value: null },
        uDetailCenter: { value: new THREE.Vector2() },
        uSunDir: { value: this.sunDir },
      },
      vertexShader: VS,
      fragmentShader: EARTH_FS,
    });
    this.group.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 192, 128), this.material));

    this.cloudMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCloud: { value: null },
        uSunDir: { value: this.sunDir },
        uFade: { value: 0 },
        uHaze: this.haze,
      },
      vertexShader: VS,
      fragmentShader: CLOUD_FS,
      transparent: true,
      depthWrite: false,
    });
    this.cloudMesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius + CLOUD_ALTITUDE, 192, 128),
      this.cloudMaterial,
    );
    this.cloudMesh.renderOrder = 2; // 海岸線より上に重ねる
    this.cloudMesh.visible = false;
    this.group.add(this.cloudMesh);

    this.group.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(radius * 1.07, 128, 96),
        new THREE.ShaderMaterial({
          uniforms: { uSunDir: { value: this.sunDir }, uThinness: this.atmosphereThinness },
          vertexShader: VS,
          fragmentShader: ATMOSPHERE_FS,
          side: THREE.BackSide,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
  }

  setTextures(day: THREE.Texture, night: THREE.Texture): void {
    this.material.uniforms.uDay.value = day;
    this.material.uniforms.uNight.value = night;
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.sunDir.copy(direction);
  }

  // blend は 0 が地球ビュー、1 が地域ビュー
  setRegionBlend(blend: number): void {
    const altitude = THREE.MathUtils.lerp(CLOUD_ALTITUDE, REGION_CLOUD_ALTITUDE, blend);
    this.material.uniforms.uCloudAltitude.value = altitude;
    this.cloudMesh.scale.setScalar((this.radius + altitude) / (this.radius + CLOUD_ALTITUDE));
    this.haze.value = THREE.MathUtils.lerp(1, REGION_HAZE, blend);
    this.atmosphereThinness.value = THREE.MathUtils.lerp(1, REGION_ATMOSPHERE_THINNESS, blend);
    this.material.uniforms.uRegion.value = blend;
  }

  setCloudShadow(strength: number): void {
    this.material.uniforms.uShadowStrength.value = strength;
  }

  setRelief(texture: THREE.Texture | null): void {
    this.material.uniforms.uRelief.value = texture;
    this.material.uniforms.uHasRelief.value = texture ? 1 : 0;
  }

  setRegionDetail(detail: RegionDetail | null): void {
    const { uniforms } = this.material;
    uniforms.uHasDetail.value = detail ? 1 : 0;
    uniforms.uDetailDay.value = detail?.day ?? null;
    uniforms.uDetailNight.value = detail?.night ?? null;
    uniforms.uDetailMask.value = detail?.mask ?? null;
    if (detail) uniforms.uDetailCenter.value = detail.center;
  }

  // data は 1 画素 1 バイトの雲の濃さ。1 行目が北端、左端が経度 -180 度
  setCloudData(nx: number, ny: number, data: Uint8Array): void {
    const texture = new THREE.DataTexture(
      data as Uint8Array<ArrayBuffer>,
      nx,
      ny,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    this.cloudTexture?.dispose();
    this.cloudTexture = texture;
    this.material.uniforms.uCloud.value = texture;
    this.cloudMaterial.uniforms.uCloud.value = texture;
  }

  setCloudsEnabled(enabled: boolean): void {
    this.cloudsWanted = enabled;
  }

  // 地球ごと隠すときは途中の状態を残さない。次に見せるときは最初から現れる
  hideCloudsNow(): void {
    this.cloudFade = 0;
    this.applyCloudFade();
  }

  // 毎フレーム呼ぶ。データが届くまでは現れ始めない
  updateClouds(dt: number): void {
    this.cloudFade = stepFade(this.cloudFade, this.cloudsWanted && this.cloudTexture !== null, dt);
    this.applyCloudFade();
  }

  get cloudProgress(): number {
    return this.cloudFade;
  }

  private applyCloudFade(): void {
    const amount = easeFade(this.cloudFade);
    this.cloudMesh.visible = amount > 0;
    this.cloudMaterial.uniforms.uFade.value = amount;
    this.material.uniforms.uShadowAmount.value = amount;
  }
}
