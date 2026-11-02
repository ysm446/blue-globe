// 写実的な地球。地表写真、夜の街明かり、大気の縁、雲の層を描く。
// 雲は天気モードのときだけ表示し (setCloudsEnabled)、地表より少し高い別の球に載せる。
// 回すと地面とずれて動くので、ボリューム雲を使わなくても高さが感じられる。
// 地域ビューで近づくと立体の雲 (volume-clouds.ts) に入れ替える
import * as THREE from 'three';
import { stepFade } from './fade';
import { CLOUD_SUN_COLOR_GLSL, VALUE_NOISE_GLSL } from './glsl';
import { easeInOut } from './math';
import type { RegionDetail } from './region-detail';
import { TILE_DEGREES, WINDOW_TILES } from './tile-window';
import { BAKED_SHADOW_GLSL, CLOUD_UV_GLSL, VolumeClouds } from './volume-clouds';

export const CLOUD_ALTITUDE = 0.012; // 実際より高い。視差が見える程度に誇張している
const OPEN_SEA_COLOR = ['0.0006', '0.0015', '0.007']; // 地球ビューの地表の画像の沖の色 (線形)。世界中でほぼ同じ
const COAST_MIP_LEVEL = 2; // 水域のマスクの縮小段階。1 画素が約 20km で、この範囲を海岸の近くとして扱う
const COAST_TEXEL_U = 4 / 8192; // 縮小段階での 1 画素の大きさ
const COAST_TEXEL_V = 4 / 4096;
const COAST_REACH = 2; // 沖の色を取りに行く距離 (縮小段階の画素数)
// 太陽の映り込みの広がりと強さ。NASA EPIC の地球の写真の、明るさと大きさに合わせた値
const WAVE_SLOPE_VARIANCE = 0.016;
const GLINT_STRENGTH = 0.9;
const GLINT_MAX = 0.4;
const REGION_CLOUD_ALTITUDE = 0.002; // 斜めに見ると誇張した分だけ雲が地面からずれるので、地域ビューでは実際に近づける
const REGION_HAZE = 0.3; // 縁の青は地球全体を見るためのもので、斜めの視点では画面の大半に乗ってしまう
const REGION_ATMOSPHERE_THINNESS = 3; // 大気の層も地球全体を見るために厚い。そのままだと空全体が青くなる
// 立体の雲は遠くから見ても差が出ないので、この高さより上では平らな雲に戻す
const VOLUME_FULL_ALTITUDE = 0.6;
const VOLUME_START_ALTITUDE = 0.85;
const SHADOW_ON_HAZE = 0.8; // 立体の雲の影が大気の青を暗くする割合
const SHADOW_LIFT = 0.006; // 立体の雲の影をずらすために足す高さ (約 38km)
const SHADOW_MIN_SLOPE = 0.5; // 太陽が真上に近くても、この傾きの分は影をずらす

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
${CLOUD_UV_GLSL}
float cloudAt(vec3 n, vec2 dx, vec2 dy) {
  return textureGrad(uCloud, cloudUvOf(n), dx, dy).r;
}
`;

const EARTH_FS = /* glsl */ `
precision highp float;
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uWater;
uniform float uShadowAmount;
uniform float uCloudAltitude;
uniform float uShadowStrength;
uniform float uGlintStrength;
uniform float uHaze;
uniform vec3 uSunDir;
uniform float uRegion;
uniform float uHasDetail;
uniform sampler2D uDetailDay;
uniform sampler2D uDetailNight;
uniform sampler2D uDetailWater;
uniform sampler2D uDetailMask;
uniform vec2 uDetailCenter;
uniform float uBakedShadowMix;
varying vec3 vPos;
varying vec2 vUv;
${CLOUD_SAMPLING_GLSL}
${BAKED_SHADOW_GLSL}
// 海岸の近くを判定するための、水域のマスクの縮小段階
float coastWater(vec2 uv) {
  return textureLod(uWater, uv, ${COAST_MIP_LEVEL.toFixed(1)}).r;
}
void main() {
  vec3 n = normalize(vPos);
  vec3 view = normalize(cameraPosition - vPos);
  float ndl = dot(n, uSunDir);
  float light = smoothstep(-0.06, 0.55, ndl);
  float dayMask = smoothstep(-0.1, 0.1, ndl);

  vec3 day = texture2D(uDay, vUv).rgb;
  float night = texture2D(uNight, vUv).r;
  float waterMask = texture2D(uWater, vUv).r;
  if (uRegion > 0.0 && uHasDetail > 0.5) {
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
    vec3 mask = texture2D(uDetailMask, detailUv).rgb * inside * uRegion;
    day = mix(day, textureGrad(uDetailDay, detailUv, dx, dy).rgb, mask.r);
    night = mix(night, textureGrad(uDetailNight, detailUv, dx, dy).r, mask.g);
    waterMask = mix(waterMask, textureGrad(uDetailWater, detailUv, dx, dy).r, mask.b);
  }
  // 水域はマスクで決める。凍った海はマスクでは水域なので、画像の白さで除く
  float ice = smoothstep(0.25, 0.5, min(day.r, min(day.g, day.b)));
  float ocean = smoothstep(0.25, 0.55, waterMask) * (1.0 - ice);
  if (uRegion > 0.0) {
    // 地域ビューの画像は海底の地形が写っているので、海は地球ビューの画像の色にする。
    // その画像は粗く海岸に陸の色がにじむので、海岸の近くは少し沖の色を使う。入り江などで沖の色を取れなければ外洋の色にする
    vec2 step_ = vec2(${COAST_TEXEL_U.toFixed(6)}, ${COAST_TEXEL_V.toFixed(6)});
    vec2 towardSea = vec2(
      coastWater(vUv + vec2(step_.x, 0.0)) - coastWater(vUv - vec2(step_.x, 0.0)),
      coastWater(vUv + vec2(0.0, step_.y)) - coastWater(vUv - vec2(0.0, step_.y))
    );
    towardSea /= max(length(towardSea), 0.001);
    float nearCoast = 1.0 - smoothstep(0.75, 1.0, coastWater(vUv));
    vec2 seaUv = vUv + towardSea * step_ * ${COAST_REACH.toFixed(1)} * nearCoast;
    float seaFound = smoothstep(0.75, 1.0, coastWater(seaUv));
    vec3 sea = mix(vec3(${OPEN_SEA_COLOR.join(', ')}), textureGrad(uDay, seaUv, dFdx(vUv), dFdy(vUv)).rgb, seaFound);
    day = mix(day, sea, ocean * uRegion);
  }

  // 雲の影。太陽が低いほど長く伸びる
  float shadow = 0.0;
  if (uShadowAmount > 0.0 && dayMask > 0.0) {
    vec3 toSun = normalize(uSunDir - n * ndl + vec3(1e-5));
    float sinZenith = sqrt(max(1.0 - ndl * ndl, 0.0));
    float reach = min(uCloudAltitude * sinZenith / max(ndl, 0.12), 0.08);
    float caster = cloudAt(normalize(n + toSun * reach), dFdx(vUv), dFdy(vUv));
    shadow = smoothstep(0.15, 0.75, caster) * uShadowStrength * uShadowAmount;
    // 立体の雲の影。太陽から見た雲の濃さの画像から引く。範囲の外は上の影のまま
    if (uBakedShadowMix > 0.0) {
      // 実際の高さのままだと影はほぼ雲の真下に隠れるので、雲がもっと高いものとして影をずらす
      float lift = min(${SHADOW_LIFT.toFixed(4)} * max(sinZenith, ${SHADOW_MIN_SLOPE.toFixed(1)}) / max(ndl, 0.12), 0.08);
      vec2 bakeUv = bakedUvOf(vPos + toSun * lift - uBakeCenter);
      // 雲の陰に隠れない部分が少ないので、スライダーの同じ値でも平らな雲の影より濃くする
      float strength = 1.0 - pow(1.0 - uShadowStrength, 1.5);
      float baked = (1.0 - textureLod(uBakedShadow, bakeUv, 0.0).r) * strength * uShadowAmount;
      shadow = mix(shadow, baked, bakedCoverage(bakeUv) * uBakedShadowMix);
    }
  }

  vec3 color = day * 1.5 * light * (1.0 - shadow);

  // 太陽の映り込み (水域だけ)。波の傾きの分布 (Cox-Munk) と、水面の反射率 (Fresnel) から求める
  vec3 halfway = normalize(uSunDir + view);
  float facingSun = max(max(dot(n, halfway), 0.0), 0.001);
  float tanSq = (1.0 - facingSun * facingSun) / (facingSun * facingSun);
  float waterFresnel = 0.02 + 0.98 * pow(1.0 - max(dot(view, halfway), 0.0), 5.0);
  float glintPeak = ${GLINT_STRENGTH.toFixed(1)} * waterFresnel
    / (3.14159265 * ${WAVE_SLOPE_VARIANCE.toFixed(3)} * 4.0 * max(dot(n, view), 0.05) * pow(facingSun, 4.0));
  // 太陽が低いと式の値が昼の数十倍になる。実際に光を弱める大気や波の陰は描かないので、なめらかに抑える。
  // 分布を掛ける前に抑え、光が平らに頭打ちにならないようにする
  glintPeak = ${GLINT_MAX.toFixed(1)} * (1.0 - exp(-glintPeak / ${GLINT_MAX.toFixed(1)}));
  float glint = uGlintStrength * glintPeak * exp(-tanSq / ${WAVE_SLOPE_VARIANCE.toFixed(3)});
  color += vec3(1.0, 0.92, 0.8) * glint * ocean * (1.0 - shadow) * dayMask;

  // 街明かりは夜側だけ
  float lights = pow(smoothstep(0.1, 1.0, night), 1.4) * (1.0 - dayMask);
  color += vec3(1.0, 0.6, 0.26) * lights * 4.5; // 画面の白より明るくして、にじませる

  // 回して触ったときに場所が分かるよう、夜側でも陸と海がうっすら見える光を残す。
  // 地域ビューの陸の画像は明るいので、陸だけ暗くする
  float nightFill = mix(1.0, mix(0.7, 1.0, ocean), uRegion);
  color += (day * vec3(0.22, 0.27, 0.4) + vec3(0.003, 0.006, 0.014)) * (1.0 - dayMask) * nightFill;

  // 地表から見える大気 (縁ほど青い)。昼側だけ
  float fresnel = pow(1.0 - max(dot(n, view), 0.0), 3.2);
  // 海の色はほとんどがこの青なので、地表の色だけを暗くしても海には影が見えない。立体の雲の影はこの青も暗くする
  float hazeShade = 1.0 - shadow * uBakedShadowMix * ${SHADOW_ON_HAZE.toFixed(1)};
  color += vec3(0.22, 0.48, 1.0) * fresnel * smoothstep(-0.15, 0.45, ndl) * 1.2 * uHaze * hazeShade;
  color += vec3(0.07, 0.16, 0.34) * light * 0.35 * uHaze * hazeShade;

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
${VALUE_NOISE_GLSL}
${CLOUD_SUN_COLOR_GLSL}
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
  // 影の部分は黒くせず、空の光を受けた青灰色にする
  vec3 lit = mix(vec3(0.3, 0.36, 0.48), vec3(0.88), transmit);
  vec3 color = lit * cloudSunColor(ndl) * light + vec3(0.016, 0.021, 0.036);

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
  private readonly volume: VolumeClouds;
  private volumeEnabled = false;
  private volumeMix = 0; // 0 は平らな雲だけ、1 は立体の雲だけ

  constructor(private readonly radius: number) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uDay: { value: null },
        uNight: { value: null },
        uWater: { value: null },
        uCloud: { value: null },
        uShadowAmount: { value: 0 },
        uCloudAltitude: { value: CLOUD_ALTITUDE },
        uShadowStrength: { value: 0 },
        uGlintStrength: { value: 1 },
        uHaze: this.haze,
        uRegion: { value: 0 },
        uHasDetail: { value: 0 },
        uDetailDay: { value: null },
        uDetailNight: { value: null },
        uDetailWater: { value: null },
        uDetailMask: { value: null },
        uDetailCenter: { value: new THREE.Vector2() },
        uBakedShadowMix: { value: 0 },
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

    this.volume = new VolumeClouds(radius, this.sunDir, this.haze);
    this.group.add(this.volume.mesh);
    Object.assign(this.material.uniforms, this.volume.bakeUniforms);

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

  setTextures(day: THREE.Texture, night: THREE.Texture, water: THREE.Texture): void {
    this.material.uniforms.uDay.value = day;
    this.material.uniforms.uNight.value = night;
    this.material.uniforms.uWater.value = water;
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.sunDir.copy(direction);
  }

  // blend は 0 が地球ビュー、1 が地域ビュー。cameraAltitude は地表からのカメラの高さ
  setRegionBlend(blend: number, cameraAltitude: number): void {
    const altitude = THREE.MathUtils.lerp(CLOUD_ALTITUDE, REGION_CLOUD_ALTITUDE, blend);
    this.material.uniforms.uCloudAltitude.value = altitude;
    this.cloudMesh.scale.setScalar((this.radius + altitude) / (this.radius + CLOUD_ALTITUDE));
    this.haze.value = THREE.MathUtils.lerp(1, REGION_HAZE, blend);
    this.atmosphereThinness.value = THREE.MathUtils.lerp(1, REGION_ATMOSPHERE_THINNESS, blend);
    this.material.uniforms.uRegion.value = blend;
    this.volumeMix = this.volumeEnabled
      ? THREE.MathUtils.smoothstep(blend, 0.5, 0.95) *
        (1 - THREE.MathUtils.smoothstep(cameraAltitude, VOLUME_FULL_ALTITUDE, VOLUME_START_ALTITUDE))
      : 0;
  }

  setVolumeCloudsEnabled(enabled: boolean): void {
    this.volumeEnabled = enabled;
  }

  // 立体の雲の影を焼く範囲の中心にする地表の点と、そこからカメラまでの距離
  setVolumeShadowFocus(center: THREE.Vector3, distance: number): void {
    this.volume.setShadowFocus(center, distance);
  }

  // 画面を描く前に呼ぶ
  renderVolumeClouds(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    this.volume.render(renderer, camera);
  }

  // 1 は NASA EPIC の地球の写真に合わせた強さ
  setGlintStrength(strength: number): void {
    this.material.uniforms.uGlintStrength.value = strength;
  }

  setCloudShadow(strength: number): void {
    this.material.uniforms.uShadowStrength.value = strength;
  }

  setRegionDetail(detail: RegionDetail | null): void {
    const { uniforms } = this.material;
    uniforms.uHasDetail.value = detail ? 1 : 0;
    uniforms.uDetailDay.value = detail?.atlases.day ?? null;
    uniforms.uDetailNight.value = detail?.atlases.night ?? null;
    uniforms.uDetailWater.value = detail?.atlases.water ?? null;
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
    this.volume.setCloudTexture(texture);
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
    const amount = easeInOut(this.cloudFade);
    const flat = amount * (1 - this.volumeMix);
    this.cloudMesh.visible = flat > 0;
    this.cloudMaterial.uniforms.uFade.value = flat;
    this.volume.setAmount(amount * this.volumeMix);
    this.material.uniforms.uShadowAmount.value = amount;
    this.material.uniforms.uBakedShadowMix.value = this.volume.shadowReady ? this.volumeMix : 0;
  }
}
