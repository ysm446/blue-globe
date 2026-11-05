// 写実的な地球。地表写真、夜の街明かり、大気の縁、雲の層を描く。
// 雲は天気モードのときだけ表示し (setCloudsEnabled)、地表より少し高い別の球に載せる。
// 回すと地面とずれて動くので、ボリューム雲を使わなくても高さが感じられる。
// 地球ビューでも地域ビューでも、近づくと立体の雲 (volume-clouds.ts) に入れ替える。
// 新しい時刻の雲は一瞬で切り替えず、見えている雲から線形に混ぜて入れ替える (cloud-blend.ts)
import * as THREE from 'three';
import { CloudBlend } from './cloud-blend';
import { stepFade } from './fade';
import { moonlightStrength } from './astro';
import { CLOUD_SUN_COLOR_GLSL, FULLSCREEN_VS, MOONLIGHT_GLSL, VALUE_NOISE_GLSL } from './glsl';
import { easeInOut } from './math';
import type { RegionDetail } from './region-detail';
import { TILE_DEGREES, WINDOW_TILES } from './tile-window';
import { BAKED_SHADOW_GLSL, CLOUD_UV_GLSL, flatCloudAltitude, VolumeClouds, type CloudStyle } from './volume-clouds';

export const CLOUD_ALTITUDE = 0.008; // 実際より高い。視差が見える程度に誇張している
const SHADOW_ALTITUDE = 0.002; // 影の長さを決める高さ (約 13km)。描く高さの誇張をそのまま使うと、境目の近くの影が数百 km に伸びる
const OPEN_SEA_COLOR = ['0.0006', '0.0015', '0.007']; // 地球ビューの地表の画像の沖の色 (線形)。世界中でほぼ同じ
const COAST_MIP_LEVEL = 2; // 水域のマスクの縮小段階。1 画素が約 20km で、この範囲を海岸の近くとして扱う
const COAST_TEXEL_U = 4 / 8192; // 縮小段階での 1 画素の大きさ
const COAST_TEXEL_V = 4 / 4096;
const COAST_REACH = 2; // 沖の色を取りに行く距離 (縮小段階の画素数)
// 太陽の映り込みの広がりと強さ。NASA EPIC の地球の写真の、明るさと大きさに合わせた値
const WAVE_SLOPE_VARIANCE = 0.016;
const GLINT_STRENGTH = 0.9;
const GLINT_MAX = 0.4;
const SHADOW_REBAKE_STEP = 0.1; // 雲を入れ替えている間、この割合だけ進むごとに立体の雲の影を焼き直す
const REGION_CLOUD_ALTITUDE = 0.002; // 斜めに見ると誇張した分だけ雲が地面からずれるので、地域ビューでは実際に近づける
const REGION_HAZE = 0.3; // 縁の青は地球全体を見るためのもので、斜めの視点では画面の大半に乗ってしまう
const ATMOSPHERE_SCALE_HEIGHT = 0.02; // 縁の青い光が 1/e になる高さ (約 130km)。明るさは 2 乗で効くので半分になるのは約 45km
const REGION_ATMOSPHERE_THINNESS = 3; // 大気の層も地球全体を見るために厚い。そのままだと空全体が青くなる
// 縁の青と大気の層は、視点 (地球・地域) ではなくカメラの高さで変える。視点の切り替えに合わせると、
// 寄り始めた直後のまだ高い位置で急に変わって見える。この高さより下で地域ビューの見た目、上で地球ビューの見た目
const REGION_ATMOSPHERE_FULL_ALTITUDE = 0.25; // 既定の地域ビューは約 0.17
const REGION_ATMOSPHERE_START_ALTITUDE = 1.4; // 既定の地球ビューは 2.3
// 立体の雲は遠くから見ても差が出ないので、この高さより上では平らな雲に戻す
const VOLUME_FULL_ALTITUDE = 0.6;
const VOLUME_START_ALTITUDE = 0.85;
const SHADOW_ON_HAZE = 0.8; // 立体の雲の影が大気の青を暗くする割合
const SHADOW_LIFT = 0.006; // 立体の雲の影をずらすために足す高さ (約 38km)
const CITY_LIGHT_EXTINCTION = 3; // 雲が街明かりを遮る強さ。厚い雲 (濃さ 1) で約 5% まで弱まる
// 街明かりの暈。低い大気で散った光が、街のまわりをふんわり明るくする。
// 街明かりの画像には氷や雪の淡い明るさも写っているので、街明かりだけを取り出した縮小画像を先に作り、その縮小段階を引いてぼかす
const GLOW_MAP_SIZE = [1024, 512]; // 1 画素が約 40km
const GLOW_MAP_TAPS = 8; // 縮小画像の 1 画素に、元の画像の 8×8 画素を集める
const GLOW_FAR_LOD = 2; // 1 画素が約 160km
const GLOW_BRIGHTNESS = 0.6; // 設定が 100% のときの明るさ。にじみのしきい値 (2.6) より十分低くし、白く飛ばさない
const GLOW_MAX_PATH = 2; // 斜めに見るほど大気を長く通って強くにじむ。真上から見たときに対する上限

// 街明かりの描画と同じ式で、街明かりの画像から光だけを取り出して縮小する
const GLOW_MAP_FS = /* glsl */ `
precision highp float;
uniform sampler2D uNight;
uniform vec2 uSourceTexel;
varying vec2 vUv;
void main() {
  float sum = 0.0;
  for (int y = 0; y < ${GLOW_MAP_TAPS}; y++) {
    for (int x = 0; x < ${GLOW_MAP_TAPS}; x++) {
      vec2 offset = (vec2(float(x), float(y)) - ${((GLOW_MAP_TAPS - 1) / 2).toFixed(1)}) * uSourceTexel;
      sum += pow(smoothstep(0.1, 1.0, textureLod(uNight, vUv + offset, 0.0).r), 1.4);
    }
  }
  gl_FragColor = vec4(sum / ${(GLOW_MAP_TAPS * GLOW_MAP_TAPS).toFixed(1)}, 0.0, 0.0, 1.0);
}
`;
// 夜側の補助光で明るい地表を抑える。この明るさ (線形) までの陸と海は変えない
const NIGHT_FILL_KNEE = 0.1;
const NIGHT_FILL_FALLOFF = 0.7; // 氷床 (約 0.97) で約 5 分の 1 になる。強くすると濃淡が消えて、わずかな色味の差が目立つ

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
uniform float uCityGlow;
uniform sampler2D uGlowMap;
varying vec3 vPos;
${MOONLIGHT_GLSL}
${CLOUD_SUN_COLOR_GLSL}
varying vec2 vUv;
${CLOUD_SAMPLING_GLSL}
${BAKED_SHADOW_GLSL}
// 縮小段階をそのまま引くと、粗い段の画素の四角が見える。半画素ずらした 4 点をならして角を丸める
float glowAt(vec2 uv, float lod) {
  vec2 half_ = 0.5 * exp2(lod) / vec2(${GLOW_MAP_SIZE[0].toFixed(1)}, ${GLOW_MAP_SIZE[1].toFixed(1)});
  return 0.25 * (
    textureLod(uGlowMap, uv + vec2(half_.x, half_.y), lod).r +
    textureLod(uGlowMap, uv + vec2(-half_.x, half_.y), lod).r +
    textureLod(uGlowMap, uv + vec2(half_.x, -half_.y), lod).r +
    textureLod(uGlowMap, uv + vec2(-half_.x, -half_.y), lod).r
  );
}
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
    vec2 detailUv = tile / ${WINDOW_TILES.toFixed(1)};
    vec2 dx = dFdx(detailUv);
    vec2 dy = dFdy(detailUv);
    // 範囲の外側は反対側の端のタイルの置き場所につながっている。遠くで粗い縮小画像を使うほど広く混ざるので、
    // 1 画素の広さ (タイル数) に合わせて手前から薄くする
    float blur = max(length(dx), length(dy)) * ${WINDOW_TILES.toFixed(1)};
    float inside = smoothstep(half_, half_ - 0.5 - 2.0 * blur, max(fromCenter.x, fromCenter.y));
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

  // 雲の影。太陽が低いほど長く伸びる。長さは描く高さではなく実際に近い高さで決める
  float shadow = 0.0;
  if (uShadowAmount > 0.0 && dayMask > 0.0) {
    vec3 toSun = normalize(uSunDir - n * ndl + vec3(1e-5));
    float sinZenith = sqrt(max(1.0 - ndl * ndl, 0.0));
    float reach = min(min(uCloudAltitude, ${SHADOW_ALTITUDE.toFixed(4)}) * sinZenith / max(ndl, 0.12), 0.08);
    float caster = cloudAt(normalize(n + toSun * reach), dFdx(vUv), dFdy(vUv));
    shadow = smoothstep(0.15, 0.75, caster) * uShadowStrength * uShadowAmount;
    // 立体の雲の影。太陽から見た雲の濃さの画像から引く。範囲の外は上の影のまま
    if (uBakedShadowMix > 0.0) {
      // 実際の高さのままだと影はほぼ雲の真下に隠れるので、雲がもっと高いものとして影をずらす。
      // 太陽が真上のときは真下に落とす。真上でもずらすと、向きが定まらず天頂を越えるときに反転した
      float lift = min(${SHADOW_LIFT.toFixed(4)} * sinZenith / max(ndl, 0.12), 0.08);
      vec2 bakeUv = bakedUvOf(vPos + toSun * lift - uBakeCenter);
      // 雲の陰に隠れない部分が少ないので、スライダーの同じ値でも平らな雲の影より濃くする
      float strength = 1.0 - pow(1.0 - uShadowStrength, 1.5);
      float baked = (1.0 - textureLod(uBakedShadow, bakeUv, 0.0).r) * strength * uShadowAmount;
      shadow = mix(shadow, baked, bakedCoverage(bakeUv) * uBakedShadowMix);
    }
  }

  // 境目の近くでは雲と同じく太陽の色を赤くする。雲だけ橙で地表が昼の色のままだと釣り合わない
  vec3 sunColor = cloudSunColor(ndl);
  vec3 color = day * 1.5 * light * sunColor * (1.0 - shadow);

  // 太陽の映り込み (水域だけ)。波の傾きの分布 (Cox-Munk) と、水面の反射率 (Fresnel) から求める
  vec3 halfway = normalize(uSunDir + view);
  float facingSun = max(max(dot(n, halfway), 0.0), 0.001);
  float tanSq = (1.0 - facingSun * facingSun) / (facingSun * facingSun);
  // pow は底が負だと NaN になる。正面の画素では誤差で内積が 1 をわずかに超えるので、1 で抑える
  float waterFresnel = 0.02 + 0.98 * pow(1.0 - clamp(dot(view, halfway), 0.0, 1.0), 5.0);
  float glintPeak = ${GLINT_STRENGTH.toFixed(1)} * waterFresnel
    / (3.14159265 * ${WAVE_SLOPE_VARIANCE.toFixed(3)} * 4.0 * max(dot(n, view), 0.05) * pow(facingSun, 4.0));
  // 太陽が低いと式の値が昼の数十倍になる。実際に光を弱める大気や波の陰は描かないので、なめらかに抑える。
  // 分布を掛ける前に抑え、光が平らに頭打ちにならないようにする
  glintPeak = ${GLINT_MAX.toFixed(1)} * (1.0 - exp(-glintPeak / ${GLINT_MAX.toFixed(1)}));
  float glint = uGlintStrength * glintPeak * exp(-tanSq / ${WAVE_SLOPE_VARIANCE.toFixed(3)});
  color += vec3(1.0, 0.92, 0.8) * sunColor * glint * ocean * (1.0 - shadow) * dayMask;

  // 街明かりは夜側だけ
  float lights = pow(smoothstep(0.1, 1.0, night), 1.4) * (1.0 - dayMask);
  // 街明かりは画面の白より明るいので、雲を半透明で重ねるだけでは透けて見える。光そのものを雲の濃さで弱める。
  // 視線が雲の層を通る点の濃さを引くと、描かれている雲と位置が揃う
  if (uShadowAmount > 0.0) {
    vec3 throughCloud = normalize(n + view * uCloudAltitude / max(dot(n, view), 0.25));
    lights *= exp(-cloudAt(throughCloud, dFdx(vUv), dFdy(vUv)) * ${CITY_LIGHT_EXTINCTION.toFixed(1)} * uShadowAmount);
  }
  color +=vec3(1.0, 0.6, 0.26) * lights * 4.5; // 画面の白より明るくして、にじませる

  // 街明かりの暈。遠くから見て 1 画素が縮小段階より広いときは、その画素の広さに合わせて粗い段を引く
  if (uCityGlow > 0.0 && dayMask < 1.0) {
    vec2 texels = vUv * vec2(${GLOW_MAP_SIZE[0].toFixed(1)}, ${GLOW_MAP_SIZE[1].toFixed(1)});
    float pixelLod = log2(max(max(length(dFdx(texels)), length(dFdy(texels))), 1.0));
    float glow = glowAt(vUv, max(0.0, pixelLod + 1.0)) * 0.7 + glowAt(vUv, max(${GLOW_FAR_LOD.toFixed(1)}, pixelLod + 1.0)) * 0.3;
    float path = min(1.0 / max(dot(n, view), 0.01), ${GLOW_MAX_PATH.toFixed(1)});
    float glowLight = glow * path * uCityGlow * ${GLOW_BRIGHTNESS.toFixed(2)} * (1.0 - dayMask);
    if (uShadowAmount > 0.0) {
      vec3 throughCloud = normalize(n + view * uCloudAltitude / max(dot(n, view), 0.25));
      glowLight *= exp(-cloudAt(throughCloud, dFdx(vUv), dFdy(vUv)) * ${CITY_LIGHT_EXTINCTION.toFixed(1)} * uShadowAmount);
    }
    color += vec3(1.0, 0.55, 0.22) * glowLight;
  }

  // 回して触ったときに場所が分かるよう、夜側でも陸と海がうっすら見える光を残す。
  // 地域ビューの陸の画像は明るいので、陸だけ暗くする
  float nightFill = mix(1.0, mix(0.7, 1.0, ocean), uRegion);
  // 地表の色に比例させるだけだと、昼の画像で白い氷床や雪が夜でも光って見える。明るい地表ほど抑える
  float dayPeak = max(max(day.r, max(day.g, day.b)), ${NIGHT_FILL_KNEE.toFixed(1)});
  vec3 nightDay = day * pow(dayPeak / ${NIGHT_FILL_KNEE.toFixed(1)}, -${NIGHT_FILL_FALLOFF.toFixed(1)});
  color += (nightDay * vec3(0.22, 0.27, 0.4) + vec3(0.003, 0.006, 0.014)) * (1.0 - dayMask) * nightFill;
  // 地表は雲より暗いので、月明かりは地表の色の分だけ返す。明るい氷や雪は補助光と同じく抑える
  color += nightDay * moonlightAt(n, ndl) * nightFill;

  // 地表から見える大気 (縁ほど青い)。昼側だけ。真下の画素では内積が 1 を超えて NaN にならないよう抑える
  float fresnel = pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 3.2);
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
${MOONLIGHT_GLSL}
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
  // 雲は海や陸よりずっと白いので、月夜にいちばん明るく見える。陰は太陽の光の陰を流用し、薄く付ける
  color += moonlightAt(n, ndl) * mix(0.6, 1.0, transmit);

  // 縁の雲にも大気の青を重ねる
  float fresnel = pow(1.0 - clamp(dot(n, view), 0.0, 1.0), 3.2);
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
  // 視線が最も低く通る点での太陽の高さ。0 で昼と夜の境目
  vec3 lowest = along < 0.0 ? cameraPosition - ray * along : cameraPosition;
  float sunHeight = dot(normalize(lowest), uSunDir);
  closest = 1.0 + (closest - 1.0) * uThinness;
  float exitAngle = sqrt(max(1.0 - pow(closest / length(vPos), 2.0), 0.0));
  float inner = smoothstep(0.0, 0.38, exitAngle);
  // 明るさは視線が最も低く通る点での太陽の高さで決める。殻を抜ける点の法線で決めると、縁をかすめる視線では
  // 抜ける点が地球の向こう側になり、昼の面を正面に見たときに縁が暗く、夜の面を見たときに一周青く光った。
  // 高さに対して指数で減らす。実際の大気 (高さ 8km ごとに半分以下) より厚いが、殻の半径 (約 450km) まで
  // なだらかに残す形だと、地球の周りに大きな光の輪が出る
  float lit = smoothstep(-0.25, 0.55, sunHeight);
  float falloff = exp(-max(closest - 1.0, 0.0) / ${ATMOSPHERE_SCALE_HEIGHT.toFixed(3)});
  float a = inner * falloff * lit * 0.9;
  // 太陽の向きへの強い散乱 (前方散乱)。日の出や日の入りのように、縁の向こうに太陽があると縁が細く明るく光る。
  // 昼と夜の境目では、光が大気を長く通るので低い層は黄色から橙になり、その上に青い層が残る
  float toward = max(dot(ray, uSunDir), 0.0);
  float dusk = 1.0 - smoothstep(-0.05, 0.3, sunHeight);
  float reach = smoothstep(-0.18, 0.0, sunHeight); // 地球の影に深く入った層には光が届かない
  float layer = clamp((closest - 1.0) / 0.07, 0.0, 1.0); // 0 が地表、1 が大気の上端
  float facingSun = dusk * smoothstep(0.8, 0.97, toward); // 縁のほぼ真後ろに太陽があるとき
  // 縁の向こうに太陽があるとき、境目の縁は太陽から離れたところまで低い層が橙に光る
  // (光が大気を横に長く通り、赤い光だけが残る)。太陽を背にしたときや真横にあるときの縁は光らせない。
  // 散った光はほとんど太陽の向きへ進むので、ほかの向きからは暗く見える。
  // 光が当たるのは境目から夜側へ約 7° まで (高さ 50km の層が地球の影から出る範囲。太陽の高さ -0.12)。
  // 地球ビューの距離では、見えている縁は境目より約 14° 夜側にあるので、縁の向こうに太陽があっても
  // 橙は太陽の近くの縁だけになる (一周の輪に見えるのは、境目と縁が重なるほど遠くから見たとき)。
  // 前方散乱の線より厚くする。同じ厚さでは地球ビューで 1〜2 画素になって見えなかった。
  // 大気の層を薄くしている地域ビューでは、同じ割合で薄くする
  float beltReach = smoothstep(-0.12, -0.02, sunHeight);
  float lowLayer = exp(-layer * 5.0 * uThinness) * inner * inner;
  float belt = dusk * beltReach * lowLayer * smoothstep(0.6, 0.95, toward);
  // 昼側の青い光は、境目で太陽の方を見るときは弱める。橙の層では青を橙に置き換え、青は上の層にだけ残す。
  // 混ぜたままだとピンクに見えた。青紫に寄せると、地球ビューでは縁が一周紫に見えた
  vec3 color = vec3(0.27, 0.55, 1.0) * a * a * (1.0 - 0.45 * facingSun) * (1.0 - 0.85 * belt);
  vec3 warm = mix(vec3(1.0, 0.82, 0.45), vec3(1.0, 0.32, 0.04), smoothstep(0.75, 0.2, toward)); // 太陽から離れるほど赤い
  vec3 tint = mix(vec3(0.85, 0.92, 1.0), warm, dusk);
  float forward = pow(toward, 4.0) * 0.8 + pow(toward, 60.0) * 1.4 + pow(toward, 3000.0) * 3.0;
  float density = exp(-layer * 16.0) * inner * inner; // 低い層ほど濃く、縁を細く見せる
  color += tint * forward * density * reach;
  color += vec3(1.0, 0.38, 0.08) * belt * 0.6;
  gl_FragColor = vec4(color, 1.0);
  #include <colorspace_fragment>
}
`;

export class RealisticEarth {
  readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly cloudMesh: THREE.Mesh;
  private readonly cloudMaterial: THREE.ShaderMaterial;
  private readonly sunDir = new THREE.Vector3(1, 0, 0);
  private readonly cloudBlend = new CloudBlend();
  private bakedBlend = 1; // 立体の雲の影を焼いたときの、雲の入れ替えの進み具合
  private cloudsWanted = false;
  private cloudFade = 0;
  private readonly haze = { value: 1 };
  private readonly atmosphereThinness = { value: 1 };
  private readonly volume: VolumeClouds;
  private volumeEnabled = false;
  private volumeMix = 0; // 0 は平らな雲だけ、1 は立体の雲だけ
  private volumeHeight = 1; // 立体の雲の層の厚さの倍率
  // 月明かり。地表、平らな雲、立体の雲で共有する
  private readonly moon = {
    uMoonDir: { value: new THREE.Vector3(0, 0, 1) },
    uMoonLight: { value: 0 },
  };
  private moonlightEnabled = true;

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
        uCityGlow: { value: 1 },
        uGlowMap: { value: null },
        ...this.moon,
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
        ...this.moon,
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

    this.volume = new VolumeClouds(radius, this.sunDir, this.haze, this.moon);
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

  setTextures(day: THREE.Texture, night: THREE.Texture, water: THREE.Texture, renderer: THREE.WebGLRenderer): void {
    this.material.uniforms.uDay.value = day;
    this.material.uniforms.uNight.value = night;
    this.material.uniforms.uWater.value = water;
    this.material.uniforms.uGlowMap.value = this.buildGlowMap(renderer, night);
  }

  // 街明かりの暈に使う、街明かりだけの縮小画像。画像を読み込んだときに 1 回だけ作る
  private buildGlowMap(renderer: THREE.WebGLRenderer, night: THREE.Texture): THREE.Texture {
    const floatable =
      renderer.extensions.has('EXT_color_buffer_float') ||
      renderer.extensions.has('EXT_color_buffer_half_float');
    const [width, height] = GLOW_MAP_SIZE;
    // 暗いところのわずかな光を足すので、8 ビットでは段が見える
    const target = new THREE.WebGLRenderTarget(width, height, {
      type: floatable ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    target.texture.wrapS = THREE.RepeatWrapping;
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uNight: { value: night },
        uSourceTexel: { value: new THREE.Vector2(1 / (width * GLOW_MAP_TAPS), 1 / (height * GLOW_MAP_TAPS)) },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: GLOW_MAP_FS,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    const scene = new THREE.Scene().add(quad);
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(scene, new THREE.Camera());
    renderer.setRenderTarget(previousTarget);
    material.dispose();
    quad.geometry.dispose();
    return target.texture;
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.sunDir.copy(direction);
    this.updateMoonlight();
  }

  // 地球の中心から見た月の方向
  setMoonDirection(direction: THREE.Vector3): void {
    this.moon.uMoonDir.value.copy(direction);
    this.updateMoonlight();
  }

  setMoonlightEnabled(enabled: boolean): void {
    this.moonlightEnabled = enabled;
    this.updateMoonlight();
  }

  private updateMoonlight(): void {
    const sun = this.sunDir;
    const moon = this.moon.uMoonDir.value;
    this.moon.uMoonLight.value = this.moonlightEnabled
      ? moonlightStrength([sun.x, sun.y, sun.z], [moon.x, moon.y, moon.z])
      : 0;
  }

  // blend は 0 が地球ビュー、1 が地域ビュー。cameraAltitude は地表からのカメラの高さ。
  // detail は地球ビューで寄ったときの高解像度の画像の見え具合 (0〜1)。海の色と夜の陸の暗さも高解像度の画像に合わせる
  setRegionBlend(blend: number, cameraAltitude: number, detail = 0): void {
    this.volumeMix = this.volumeEnabled
      ? 1 - THREE.MathUtils.smoothstep(cameraAltitude, VOLUME_FULL_ALTITUDE, VOLUME_START_ALTITUDE)
      : 0;
    // 立体の雲は低いところにあるので、混ざる間は平らな雲も下げる。高いままだと雲が二重に見える
    // 立体の雲の層の高さを変えたときは、混ざる間の平らな雲もそれに合わせる
    const lowered = THREE.MathUtils.lerp(REGION_CLOUD_ALTITUDE, flatCloudAltitude(this.volumeHeight), this.volumeMix);
    const altitude = THREE.MathUtils.lerp(CLOUD_ALTITUDE, lowered, Math.max(blend, this.volumeMix));
    this.material.uniforms.uCloudAltitude.value = altitude;
    this.cloudMesh.scale.setScalar((this.radius + altitude) / (this.radius + CLOUD_ALTITUDE));
    const low =
      1 - THREE.MathUtils.smoothstep(cameraAltitude, REGION_ATMOSPHERE_FULL_ALTITUDE, REGION_ATMOSPHERE_START_ALTITUDE);
    this.haze.value = THREE.MathUtils.lerp(1, REGION_HAZE, low);
    this.atmosphereThinness.value = THREE.MathUtils.lerp(1, REGION_ATMOSPHERE_THINNESS, low);
    this.material.uniforms.uRegion.value = Math.max(blend, detail);
  }

  setVolumeCloudsEnabled(enabled: boolean): void {
    this.volumeEnabled = enabled;
  }

  setVolumeCloudStyle(style: CloudStyle): void {
    this.volumeHeight = style.height;
    this.volume.setStyle(style);
  }

  // 立体の雲の影を焼く範囲の中心にする地表の点と、そこからカメラまでの距離
  setVolumeShadowFocus(center: THREE.Vector3, distance: number): void {
    this.volume.setShadowFocus(center, distance);
  }

  // 画面を描く前に呼ぶ。雲を入れ替えている間は混ぜた雲を描き、立体の雲の影も少しずつ焼き直す
  renderCloudBlend(renderer: THREE.WebGLRenderer): void {
    if (!this.cloudBlend.render(renderer)) return;
    const progress = this.cloudBlend.progress;
    if (progress >= 1 || progress - this.bakedBlend >= SHADOW_REBAKE_STEP) {
      this.bakedBlend = progress;
      this.volume.setCloudTexture(this.cloudBlend.texture!);
    }
  }

  // 画面を描く前に呼ぶ
  renderVolumeClouds(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    if (this.volumeEnabled && this.cloudFade >= 1) this.volume.prepare(renderer, camera);
    this.volume.render(renderer, camera);
  }

  // 1 は NASA EPIC の地球の写真に合わせた強さ
  setGlintStrength(strength: number): void {
    this.material.uniforms.uGlintStrength.value = strength;
  }

  // 街明かりの暈の強さ。1 が既定の強さ
  setCityGlow(strength: number): void {
    this.material.uniforms.uCityGlow.value = strength;
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

  // data は 1 画素 1 バイトの雲の濃さ。1 行目が北端、左端が経度 -180 度。
  // 前の雲が見えていれば、そこから混ぜて入れ替える
  setCloudData(nx: number, ny: number, data: Uint8Array): void {
    this.cloudBlend.setData(nx, ny, data);
    const texture = this.cloudBlend.texture!;
    this.material.uniforms.uCloud.value = texture;
    this.cloudMaterial.uniforms.uCloud.value = texture;
    this.volume.setCloudTexture(texture);
    this.bakedBlend = this.cloudBlend.progress;
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
    this.cloudFade = stepFade(this.cloudFade, this.cloudsWanted && this.cloudBlend.texture !== null, dt);
    this.cloudBlend.update(dt);
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
