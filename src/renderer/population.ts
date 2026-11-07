// 人口の分布 (ヒートマップか、色の付いた点)。画像 (assets/textures/population.png) は scripts/build-population.py で作る。
// R の値 0 はほぼ無人、1〜255 は log10(人口密度 人/km²) を LOG_MIN〜LOG_MAX に直線で割り当てたもの。G は人が住んでいるか。
// 変換スクリプトの LOG_MIN と LOG_MAX を変えたときは、ここも揃える
const LOG_MIN = -2;
const LOG_MAX = 5;

// 色の段階。log10(人/km²) ごとの色 (sRGB) と不透明度。最初の段より薄い所は塗らない。
// 炎の色 (暗い赤 → 赤 → 橙 → 黄 → 白) で、密な所ほど明るい。低い所を黒で塗ると昼の陸が焼けたように暗くなるので、暗い赤を薄く重ねる
const STOPS: [number, [number, number, number], number][] = [
  [-1, [110, 12, 6], 0], // 0.1 人/km²
  [0, [160, 22, 10], 0.3], // 1
  [1, [215, 55, 15], 0.5], // 10
  [2, [245, 125, 25], 0.7], // 100
  [3, [255, 205, 75], 0.88], // 1000
  [4, [255, 248, 225], 1], // 1 万
];
// 色の明るさ (線形)。一番密な所は光のにじみのしきい値 (2.6) を超えさせ、都市の中心を光らせる
const BRIGHTNESS = 0.5;
const GLOW_FROM_LOG = 3; // ここから明るくし始める (1000 人/km²)
const GLOW_FULL_LOG = 4.5; // ここで一番明るい (約 3 万人/km²)
const GLOW_BRIGHTNESS = 3.2;

// 凡例の目盛りに出す密度 (log10)
export const POPULATION_LEGEND_TICKS = [0, 2, 4];
export const POPULATION_LEGEND_MIN = STOPS[0][0];
export const POPULATION_LEGEND_MAX = STOPS[STOPS.length - 1][0];

export const POPULATION_LEGEND = `linear-gradient(to right, ${STOPS.map(([log, [r, g, b], alpha]) => {
  const at = ((log - POPULATION_LEGEND_MIN) / (POPULATION_LEGEND_MAX - POPULATION_LEGEND_MIN)) * 100;
  return `rgb(${r} ${g} ${b} / ${Math.max(alpha, 0.05)}) ${at}%`;
}).join(', ')})`;

const toLinear = (c: number) => Math.pow(c / 255, 2.2).toFixed(4);

// 点の表示。地表を経緯度のマス目に分け、マスの中心の密度の色の丸を描く。
// マスの大きさは、画面の上で点の間隔が DOT_SPACING_PX ほどになるよう、カメラの距離で 2 倍刻みに切り替え、間は混ぜる
const DOT_SPACING_PX = 10; // 画面の画素 (高解像度の画面では物理的な画素)
const TEXEL_DEGREES = 360 / 8192; // 画像の 1 画素の大きさ (度)
const DOT_MIN_DEGREES = TEXEL_DEGREES / 2; // これより細かいマスにはしない。データは約 5km 刻みなので、それ以上細かくしても情報は増えない
const KM_PER_DEGREE = 111.195;
const DOT_RADIUS_MIN = 0.14; // 点の半径 (マスの大きさに対する割合)。大きさを変えるときの、一番疎な所
const DOT_RADIUS_MAX = 0.42; // 一番密な所。0.5 で隣の点に触れる
const DOT_RADIUS_FLAT = 0.32; // 大きさを変えないとき
const DOT_SPARSE_RADIUS = 0.5; // マスのごく一部にしか人が住んでいないときの、点の半径の倍率
const DOT_SPARSE_ALPHA = 0.5; // 同じく不透明度の倍率

export const POPULATION_STYLE_CODES: Record<PopulationStyle, number> = { heatmap: 0, dots: 1, dots_flat: 2 };

const DENSITY_MIN_LOG = LOG_MIN.toFixed(1);
const DENSITY_MAX_LOG = STOPS[STOPS.length - 1][0].toFixed(1);

// 画素の値から log10(人/km²) と色を返す GLSL。色は線形。uPopulation と uPopulationStyle を使う
export const POPULATION_GLSL = /* glsl */ `
// 無人のマスは -99。R は密度、G は人が住んでいるか。縮小画像では両方が平均されるので、
// R / G で人の住んでいるセルだけの平均にする (海の 0 と平均すると、細い島や海岸が疎に見える)
float populationLog(vec2 sampled) {
  if (sampled.g < 0.5 / 255.0) return -99.0;
  float v = sampled.r / sampled.g * 255.0;
  if (v < 0.5) return -99.0;
  return ${LOG_MIN.toFixed(1)} + (v - 1.0) / 254.0 * ${(LOG_MAX - LOG_MIN).toFixed(1)};
}
// ヒートマップの色と不透明度 (a)。色は明るさを掛けたもので、密な所は画面の白より明るい
vec4 populationColor(float logDensity) {
  if (logDensity < -98.0) return vec4(0.0);
  vec4 c = vec4(vec3(${STOPS[0][1].map(toLinear).join(', ')}), ${STOPS[0][2].toFixed(2)});
${STOPS.slice(1)
  .map(([log, rgb, alpha], i) => {
    const prev = STOPS[i][0];
    return `  c = mix(c, vec4(vec3(${rgb.map(toLinear).join(', ')}), ${alpha.toFixed(2)}), smoothstep(${prev.toFixed(1)}, ${log.toFixed(1)}, logDensity));`;
  })
  .join('\n')}
  c.rgb *= mix(${BRIGHTNESS.toFixed(2)}, ${GLOW_BRIGHTNESS.toFixed(2)}, smoothstep(${GLOW_FROM_LOG.toFixed(1)}, ${GLOW_FULL_LOG.toFixed(1)}, logDensity));
  return c;
}
// cellDeg の大きさのマス目での点。lat, lon は度、blurKm は点の縁をぼかす幅 (1 画素の地表の長さ)
vec4 populationDotAt(float lat, float lon, float cellDeg, float blurKm) {
  float row = floor((lat + 90.0) / cellDeg);
  float centerLat = -90.0 + (row + 0.5) * cellDeg;
  // 高緯度ほど経線が詰まるので、マスが正方形に近くなるよう、その行のマスの数を減らす
  float columns = max(1.0, floor(360.0 * cos(radians(centerLat)) / cellDeg + 0.5));
  float columnDeg = 360.0 / columns;
  float column = floor((lon + 180.0) / columnDeg);
  float centerLon = -180.0 + (column + 0.5) * columnDeg;
  vec2 centerUv = vec2((centerLon + 180.0) / 360.0, (centerLat + 90.0) / 180.0);
  float lod = max(0.0, log2(cellDeg / ${TEXEL_DEGREES.toFixed(6)}));
  vec2 sampled = textureLod(uPopulation, centerUv, lod).rg;
  float logDensity = populationLog(sampled);
  if (logDensity < -98.0) return vec4(0.0);
  vec2 offsetKm = vec2(
    (lon - centerLon) * cos(radians(lat)),
    lat - centerLat
  ) * ${KM_PER_DEGREE.toFixed(3)};
  float cellKm = cellDeg * ${KM_PER_DEGREE.toFixed(3)};
  float amount = smoothstep(${DENSITY_MIN_LOG}, ${DENSITY_MAX_LOG}, logDensity); // 0 が一番疎、1 が一番密
  float radius = cellKm * (uPopulationStyle > 1.5
    ? ${DOT_RADIUS_FLAT.toFixed(2)}
    : mix(${DOT_RADIUS_MIN.toFixed(2)}, ${DOT_RADIUS_MAX.toFixed(2)}, sqrt(amount)));
  // マスのうち人が住んでいる割合が小さいほど、点を小さく薄くする。広いマスに村が 1 つあるだけの所が、一面に点で埋まらないようにする
  float lived = sampled.g;
  radius *= mix(${DOT_SPARSE_RADIUS.toFixed(2)}, 1.0, sqrt(lived));
  float inside = 1.0 - smoothstep(radius - blurKm * 0.5, radius + blurKm * 0.5, length(offsetKm));
  vec4 c = populationColor(max(logDensity, ${STOPS[1][0].toFixed(1)}));
  // 点は地表の一部しか覆わないので、ヒートマップより濃くする。人が住んでいるマスでは、一番疎でも見えるようにする
  float alpha = mix(0.45, 1.0, amount) * mix(${DOT_SPARSE_ALPHA.toFixed(2)}, 1.0, lived);
  return vec4(c.rgb, alpha * inside);
}
// uv は地表の画像の座標、pixelKm は 1 画素の地表の大きさ、blurKm は点の縁をぼかす幅
vec4 populationDots(vec2 uv, float pixelKm, float blurKm) {
  float lat = uv.y * 180.0 - 90.0;
  float lon = uv.x * 360.0 - 180.0;
  float spacingDeg = pixelKm * ${DOT_SPACING_PX.toFixed(1)} / ${KM_PER_DEGREE.toFixed(3)};
  float level = max(log2(spacingDeg / ${DOT_MIN_DEGREES.toFixed(6)}), 0.0);
  float fine = floor(level);
  float blend = smoothstep(0.6, 1.0, level - fine); // 切り替わる直前だけ混ぜ、ふだんは 1 つのマス目だけ見せる
  vec4 a = populationDotAt(lat, lon, ${DOT_MIN_DEGREES.toFixed(6)} * exp2(fine), blurKm);
  if (blend <= 0.0) return a;
  vec4 b = populationDotAt(lat, lon, ${DOT_MIN_DEGREES.toFixed(6)} * exp2(fine + 1.0), blurKm);
  // 色は不透明度で重みを付けて混ぜる。そのまま混ぜると、点のない側の黒が混ざって暗くなる
  float alpha = mix(a.a, b.a, blend);
  vec3 rgb = (a.rgb * a.a * (1.0 - blend) + b.rgb * b.a * blend) / max(alpha, 1e-4);
  return vec4(rgb, alpha);
}
`;

// 凡例の目盛りの文字。1 万以上は「万」で書く
export function formatDensity(log: number): string {
  const value = Math.pow(10, log);
  return value >= 10_000 ? `${value / 10_000}万` : String(value);
}

// 画面の下の凡例。色の帯と目盛りは 1 回だけ作る
export function initPopulationLegend(box: HTMLElement, bar: HTMLElement, scale: HTMLElement) {
  bar.style.background = POPULATION_LEGEND;
  const span = POPULATION_LEGEND_MAX - POPULATION_LEGEND_MIN;
  for (const log of POPULATION_LEGEND_TICKS) {
    const tick = document.createElement('span');
    tick.textContent = formatDensity(log);
    tick.style.left = `${((log - POPULATION_LEGEND_MIN) / span) * 100}%`;
    scale.append(tick);
  }
  return {
    setVisible(visible: boolean): void {
      if (box.hidden === visible) box.hidden = !visible;
    },
  };
}
