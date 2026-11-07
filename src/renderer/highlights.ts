// ツアーのハイライト。川を源流から河口へなぞる光る線と、山脈・砂漠などの範囲 (半透明の塗りと縁取り) を地球に重ねる。
// データ (highlight-data.ts) は初めて使うときに読み込む。線は WebGL の普通の線だと 1 画素の太さにしかならないので、
// 線分ごとに画面上で幅を持たせた帯として描き、源流からの距離 (0〜1) が uReveal を超えた部分は描かない
import * as THREE from 'three';
import { lonLatToVector3 } from './globe';
import { overlaps, type LabelBox } from './label-layout';
import {
  boundsOf,
  findByName,
  pointNames,
  regionNames,
  riverNames,
  unwrapLongitudes,
  type Bounds,
  type CountryRecord,
  type PointRecord,
  type RegionRecord,
  type RiverRecord,
} from './highlight-data';
import { buildThickArrow, defaultArrowWidthKm, type ArrowVertex } from './thick-arrow';

// 地表からの高さ。海岸線 (地域ビューで 1.0007) と同じくらいにし、塗りは線より下に置く
const LINE_RADIUS = 1.0009;
const FILL_RADIUS = 1.0006;
const ARROW_RADIUS = 1.00075; // 太さのある矢印の塗り。範囲の塗りより上、線より下
const MAX_SEGMENT_DEG = 0.5; // 長い線分は地表に沿うように分ける
const MAX_TRIANGLE_DEG = 0.25; // 塗りの三角形も地表に沿うように分ける。内側へのグラデーションがなめらかになる細かさ
const RIVER_WIDTH_PX = 5; // 描画の画素 (高 DPI ではそのぶん細く見える)
const OUTLINE_WIDTH_PX = 3.5;
// ハイライトの色。彩度を少し落とし、明るさをそろえた色。名前で選べる (CSS の色も渡せる)。
// 鮮やかな色を強く光らせると、色の成分が頭打ちになって色相がずれ (橙が黄色に、赤が橙に)、どぎつく見えるので避ける
export const HIGHLIGHT_PALETTE = {
  sky: '#8ec5ff', // 空色。川の既定
  teal: '#6fd3c4', // 青緑
  gold: '#e6b862', // 砂金
  coral: '#f0917e', // 珊瑚
  violet: '#b7a5ff', // すみれ。範囲の既定
  leaf: '#a4d48c', // 若葉
  snow: '#e9eef6', // 白に近い色。点の既定
} as const;
export type HighlightColorName = keyof typeof HIGHLIGHT_PALETTE;

// 範囲の種類 (Natural Earth の FEATURECLA) ごとの既定の色。地形に合った色にする
function areaColorOf(kind: string | undefined): string {
  switch (kind) {
    case 'Range/mtn':
    case 'Foothills':
    case 'Plateau':
    case 'Valley':
    case 'Gorge':
      return HIGHLIGHT_PALETTE.leaf;
    case 'Desert':
    case 'Depression':
      return HIGHLIGHT_PALETTE.gold;
    case 'Wetlands':
    case 'Delta':
    case 'Lake':
    case 'Basin':
    case 'Lowland':
    case 'Plain':
    case 'Coast':
      return HIGHLIGHT_PALETTE.teal;
    default:
      return HIGHLIGHT_PALETTE.violet;
  }
}

function resolveColor(color: string | undefined, fallback: string): string {
  if (!color) return fallback;
  return (HIGHLIGHT_PALETTE as Record<string, string>)[color] ?? color;
}

const LINE_GLOW = 1.15; // 線と縁取りを光らせる倍率 (HDR)。上げすぎると色相がずれる
const RIVER_GLOW = 1.8; // 川は水面が光るように強めに光らせる (空色は色相がずれにくい)
const RIVER_HEAD = 2.1; // 川をなぞる先端の明るさ (シェーダーの 1.2 倍と掛けて約 2.5 倍)
const AREA_FILL_OPACITY = 0.22; // 範囲の塗りの、輪郭のすぐ内側の濃さ。内側ほど薄くなる
const AREA_FILL_FLOOR = 0.04; // 範囲の中央の濃さ (輪郭のすぐ内側に対する割合)
const AREA_GRADIENT_SHARE = 0.22; // グラデーションの幅。範囲の中央から輪郭までの距離に対する割合
const AREA_GRADIENT_MIN_KM = 12;
const AREA_GRADIENT_MAX_KM = 90; // 大きな範囲 (砂漠など) でも縁が光って見えるよう、幅に上限を設ける
const AREA_SPREAD_SECONDS = 1.4; // 縁取りを描き終えてから、内側のグラデーションが縁から内へ広がる時間
const AREA_SPREAD_START = 0.08; // 広がり始めのグラデーションの幅 (本来の幅に対する割合)
// ラベルの文字は線と同じ色を少し淡くする (白と混ぜる)
const labelColor = (css: string): string => `color-mix(in srgb, ${css} 72%, white)`;
const DASH_COUNT = 36; // 破線の、線全体での切れ目の数
// なぞり終えた川と線に、源流から河口へ流れる明るい波を通す (明るさだけを変え、色相は変えない)
const FLOW_WAVES = 8; // 線全体に並ぶ波の数
const FLOW_PERIOD_SECONDS = 2.5; // 1 つの場所を波が 1 つ通り過ぎる時間
const FLOW_BASE = 0.8; // 波のない所の明るさ (川は明るく、上げても見た目が変わりにくいので、谷を下げて波を見せる)
const FLOW_PEAK = 0.45; // 波の山で足す明るさ (山は約 1.25 倍)
// 範囲の縁取りのきらめき。縁に沿って場所ごとにばらばらな明るさの揺れを、ゆっくり動かす
const TWINKLE_CELLS = 24; // 縁の 1 周に並ぶ揺れの区画の数 (細かすぎると細い縁では見分けにくい)
const TWINKLE_SPEED = 0.8; // 揺れが移り変わる速さ (1 秒あたり)
const TWINKLE_BASE = 0.65; // 縁は細く、雪などの明るい地面に埋もれやすいので、暗い所をはっきり下げる
const TWINKLE_PEAK = 0.8; // 一番明るい所は約 1.45 倍
const ARROW_SIZE_PX = 9; // 矢印の大きさ (描画の画素。先端から根元まで)
// 太さのある矢印。半透明の塗りに、縁を少し濃くしたもの。縁取りは線と同じ光る帯で描く
const THICK_ARROW_FILL = 0.3; // 中央の濃さ
const THICK_ARROW_EDGE = 0.22; // 縁で足す濃さ
const THICK_ARROW_DASHED = 0.5; // 破線のときの塗りの濃さの倍率 (推定のルートなどは控えめにする)
const THICK_ARROW_REVEAL_SECONDS = 3;
const ARROW_COUNT = 6; // 線の途中に置く矢印の数 (終点の矢印は別)
const RIVER_REVEAL_SECONDS = 4;
const OUTLINE_REVEAL_SECONDS = 1.6;
const FADE_IN_SECONDS = 0.5;
const FADE_OUT_SECONDS = 0.7;
const LABEL_CANDIDATES = 200; // 川のラベルを置く候補の点の数
const LABEL_KEEP_RATIO = 0.6; // 今の点より画面の中心にこれだけ近い点が見つかったときだけ、ラベルを動かす (ちらつかないように)
const POINT_TEXT_GAP = 10; // 点のハイライトの印の中心から名前までの間 (CSS ピクセル)
const DOT_BOX = 18; // 点のハイライトの印が占める範囲。ほかのラベルを重ねない
const DOT_SIZE = 10; // 印の大きさ (style.css の .highlight-dot と合わせる)

// どの種類にも付けられる見た目の指定。
// label は画面に出す名前 (省くと、範囲と点は日本語名、川は英語名)、color は CSS の色 (#ff9a3c など)、
// dashed は破線 (推定のルートや別の説など)、arrows は進む向きの矢印 (座標で渡す線は既定で付ける。川には付けない)、
// countries は通る国・重なる国の名前を出すか (既定は出す。歴史の話などでは false)
export interface HighlightStyle {
  label?: string;
  color?: string;
  dashed?: boolean;
  arrows?: boolean;
  countries?: boolean;
}

export type HighlightSpec = HighlightStyle &
  (
    | { type: 'river'; name: string }
    | { type: 'area'; name: string }
    | { type: 'line'; points: [number, number][]; name?: string } // [lat, lon] の並び
    | { type: 'arrow'; points: [number, number][]; name?: string; width?: number } // 太さのある矢印。width は太さ (km)
    | { type: 'polygon'; points: [number, number][]; name?: string }
    | { type: 'point'; name?: string; lat?: number; lon?: number; elevation?: number } // 名前で探すか、座標で置く。elevation は標高 (m)
  );

export interface HighlightInfo {
  name: string;
  nameJa?: string;
  kind: string; // river, line, arrow, polygon、または範囲の種類 (Range/mtn, Desert など)
  lengthKm?: number;
  elevationM?: number; // 山頂などの標高
  bounds: Bounds;
  countries?: { code: string; name: string; nameJa: string }[]; // 川は源流に近い順、範囲は重なりの大きい順
}

const RIBBON_VS = /* glsl */ `
attribute vec2 corner; // x: 線分の始点 0 / 終点 1、y: 帯の左右 -1 / 1
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec2 aProgress; // 線分の始点と終点の、源流からの距離 (0〜1)
uniform vec2 uResolution;
uniform float uWidth;
varying float vProgress;
varying float vSide;
void main() {
  vec4 a = projectionMatrix * modelViewMatrix * vec4(aStart, 1.0);
  vec4 b = projectionMatrix * modelViewMatrix * vec4(aEnd, 1.0);
  vec2 dir = (b.xy / b.w - a.xy / a.w) * uResolution;
  dir = length(dir) > 1e-6 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec4 p = mix(a, b, corner.x);
  // 帯の幅と、つなぎ目が欠けないよう線分の両端を半分の幅だけ伸ばす分 (画素から NDC へ)
  vec2 offset = normal * corner.y * uWidth * 0.5 + dir * (corner.x * 2.0 - 1.0) * uWidth * 0.5;
  p.xy += offset / uResolution * 2.0 * p.w;
  gl_Position = p;
  vProgress = mix(aProgress.x, aProgress.y, corner.x);
  vSide = corner.y;
}
`;

// 流れる波の明るさの倍率。なぞり終えてから (uReveal が 1 に達してから) ふわっと入れる
// uFlow が 1 なら流れる波 (川と線)、2 ならきらめき (範囲の縁取り)、0 なら揺らさない
const FLOW_GLSL = /* glsl */ `
uniform float uTime;
uniform float uFlow;
float flowHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
// 区画の値をなめらかにつないだ揺れ (0〜1)。x は縁に沿った位置、y は時刻
float flowNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(flowHash(i), flowHash(i + vec2(1.0, 0.0)), f.x), mix(flowHash(i + vec2(0.0, 1.0)), flowHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float flowGain(float progress, float reveal) {
  if (uFlow < 0.5) return 1.0;
  float on = smoothstep(0.999, 1.0, reveal);
  float gain;
  if (uFlow < 1.5) {
    float wave = 0.5 + 0.5 * sin(6.2831853 * (progress * ${FLOW_WAVES.toFixed(1)} - uTime / ${FLOW_PERIOD_SECONDS.toFixed(2)}));
    float pulse = wave * wave * wave * wave; // 山を細くして、光の粒が流れるように見せる
    gain = ${FLOW_BASE.toFixed(2)} + ${FLOW_PEAK.toFixed(2)} * pulse;
  } else {
    float n = flowNoise(vec2(progress * ${TWINKLE_CELLS.toFixed(1)}, uTime * ${TWINKLE_SPEED.toFixed(2)}));
    gain = ${TWINKLE_BASE.toFixed(2)} + ${TWINKLE_PEAK.toFixed(2)} * n * n; // 明るく光る所を少しまばらにする
  }
  return mix(1.0, gain, on);
}
`;

const RIBBON_FS = /* glsl */ `
${FLOW_GLSL}
uniform vec3 uColor;
uniform float uOpacity;
uniform float uReveal;
uniform float uHead; // なぞっている先端を明るくする強さ
uniform float uDashes; // 破線の切れ目の数。0 で実線
varying float vProgress;
varying float vSide;
void main() {
  if (vProgress > uReveal) discard;
  if (uDashes > 0.0 && fract(vProgress * uDashes) > 0.6) discard;
  float side = abs(vSide);
  float edge = 1.0 - smoothstep(0.15, 1.0, side);
  // 中心は白に寄せて明るさを保ち、縁は色のまま薄くする。光る管のような質感にする
  float peak = max(max(uColor.r, uColor.g), uColor.b);
  vec3 color = mix(uColor, vec3(peak), 0.25 * (1.0 - smoothstep(0.0, 0.55, side)));
  float head = uHead * exp(-(uReveal - vProgress) * 40.0) * (1.0 - step(0.999, uReveal));
  gl_FragColor = vec4(color * (1.0 + head * 1.2) * flowGain(vProgress, uReveal), edge * uOpacity);
}
`;

// 矢印。点ごとに、線の進む向きへ先端を向けた三角形を画面上で描く
const ARROW_VS = /* glsl */ `
attribute vec2 corner; // x: 進む向き (先端 1、根元 -1)、y: 左右
attribute vec3 aPosition;
attribute vec3 aAhead; // 少し先の点。画面上の向きを求める
attribute float aProgress;
uniform vec2 uResolution;
uniform float uWidth; // 矢印の大きさ (画素)
varying float vProgress;
void main() {
  vec4 p = projectionMatrix * modelViewMatrix * vec4(aPosition, 1.0);
  vec4 q = projectionMatrix * modelViewMatrix * vec4(aAhead, 1.0);
  vec2 dir = (q.xy / q.w - p.xy / p.w) * uResolution;
  dir = length(dir) > 1e-6 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec2 offset = (dir * corner.x + normal * corner.y) * uWidth * 0.5;
  p.xy += offset / uResolution * 2.0 * p.w;
  gl_Position = p;
  vProgress = aProgress;
}
`;

const ARROW_FS = /* glsl */ `
${FLOW_GLSL}
uniform vec3 uColor;
uniform float uOpacity;
uniform float uReveal;
varying float vProgress;
void main() {
  if (vProgress > uReveal) discard;
  gl_FragColor = vec4(uColor * flowGain(vProgress, uReveal), uOpacity);
}
`;

// 太さのある矢印の塗り。根元から uReveal まで描き、帯の縁 (aSide が ±1) を少し濃くする
const THICK_ARROW_VS = /* glsl */ `
attribute float aProgress;
attribute float aSide;
varying float vProgress;
varying float vSide;
void main() {
  vProgress = aProgress;
  vSide = aSide;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const THICK_ARROW_FS = /* glsl */ `
${FLOW_GLSL}
uniform vec3 uColor;
uniform float uOpacity;
uniform float uReveal;
uniform float uStrength; // 塗りの濃さの倍率 (破線のときは下げる)
varying float vProgress;
varying float vSide;
void main() {
  if (vProgress > uReveal) discard;
  float edge = smoothstep(0.45, 1.0, abs(vSide));
  float alpha = uOpacity * uStrength * (${THICK_ARROW_FILL.toFixed(2)} + ${THICK_ARROW_EDGE.toFixed(2)} * edge);
  gl_FragColor = vec4(uColor * flowGain(vProgress, uReveal), alpha);
}
`;

// 太さのある矢印の三角形を、地表に沿うように細かくして球に貼る (幅の広い矢じりが地面に沈まないように)
function buildThickArrowFill(triangles: [ArrowVertex, ArrowVertex, ArrowVertex][]): THREE.BufferGeometry {
  const positions: number[] = [];
  const progress: number[] = [];
  const sides: number[] = [];
  const v = new THREE.Vector3();
  const mid = (a: ArrowVertex, b: ArrowVertex): ArrowVertex => ({
    lon: (a.lon + b.lon) / 2,
    lat: (a.lat + b.lat) / 2,
    progress: (a.progress + b.progress) / 2,
    side: (a.side + b.side) / 2,
  });
  const span = (a: ArrowVertex, b: ArrowVertex): number => Math.hypot(a.lon - b.lon, a.lat - b.lat);
  const push = (p: ArrowVertex): void => {
    lonLatToVector3(p.lon, p.lat, ARROW_RADIUS, v);
    positions.push(v.x, v.y, v.z);
    progress.push(p.progress);
    sides.push(p.side);
  };
  const subdivide = (a: ArrowVertex, b: ArrowVertex, c: ArrowVertex, depth: number): void => {
    if (Math.max(span(a, b), span(b, c), span(c, a)) <= MAX_TRIANGLE_DEG || depth > 6) {
      push(a);
      push(b);
      push(c);
      return;
    }
    const ab = mid(a, b);
    const bc = mid(b, c);
    const ca = mid(c, a);
    subdivide(a, ab, ca, depth + 1);
    subdivide(ab, b, bc, depth + 1);
    subdivide(ca, bc, c, depth + 1);
    subdivide(ab, bc, ca, depth + 1);
  };
  for (const [a, b, c] of triangles) subdivide(a, b, c, 0);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aProgress', new THREE.Float32BufferAttribute(progress, 1));
  geometry.setAttribute('aSide', new THREE.Float32BufferAttribute(sides, 1));
  return geometry;
}

// 範囲の塗り。輪郭が一番濃く、内側へ行くほど薄くなる (輪郭から内側へ広がる光)。aEdge は輪郭までの距離 (km)
const FILL_VS = /* glsl */ `
attribute float aEdge;
varying float vEdge;
void main() {
  vEdge = aEdge;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FILL_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uWidth; // グラデーションの幅 (km)
uniform float uSpread; // 縁から内へ広がる進み具合 (0〜1)。縁取りを描き終えてから進める
varying float vEdge;
void main() {
  // 補間でわずかに負の距離になる画素があり、そこで exp が大きくなりすぎて明るい四角が出た (幅を狭くすると画面全体が無限大で黒くなった)。
  // 距離を 0 以上、明るさを 1 以下に抑える
  float width = uWidth * mix(${AREA_SPREAD_START.toFixed(2)}, 1.0, uSpread);
  float glow = clamp(exp(-max(vEdge, 0.0) / max(width, 1.0)), 0.0, 1.0);
  // 中央の淡い塗りは広がりに合わせて出し、広がり始めは縁のすぐ内側も少しずつ濃くする
  float alpha = uOpacity * smoothstep(0.0, 0.35, uSpread) * (${AREA_FILL_FLOOR.toFixed(2)} * uSpread + ${(1 - AREA_FILL_FLOOR).toFixed(2)} * glow);
  gl_FragColor = vec4(uColor * (1.0 + glow * 0.25), alpha);
}
`;

// 線の集まり (平らな [lon, lat, ...] と、各点の進み具合 0〜1) から帯の形を作る
function buildRibbon(lines: { coords: number[]; progress: number[] }[]): THREE.InstancedBufferGeometry {
  const starts: number[] = [];
  const ends: number[] = [];
  const progress: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (const { coords, progress: p } of lines) {
    for (let i = 0; i + 3 < coords.length; i += 2) {
      const [lon0, lat0, lon1, lat1] = [coords[i], coords[i + 1], coords[i + 2], coords[i + 3]];
      const p0 = p[i / 2];
      const p1 = p[i / 2 + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(lon1 - lon0, lat1 - lat0) / MAX_SEGMENT_DEG));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        lonLatToVector3(lon0 + (lon1 - lon0) * t0, lat0 + (lat1 - lat0) * t0, LINE_RADIUS, a);
        lonLatToVector3(lon0 + (lon1 - lon0) * t1, lat0 + (lat1 - lat0) * t1, LINE_RADIUS, b);
        starts.push(a.x, a.y, a.z);
        ends.push(b.x, b.y, b.z);
        progress.push(p0 + (p1 - p0) * t0, p0 + (p1 - p0) * t1);
      }
    }
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('corner', new THREE.Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(new Float32Array(starts), 3));
  geometry.setAttribute('aEnd', new THREE.InstancedBufferAttribute(new Float32Array(ends), 3));
  geometry.setAttribute('aProgress', new THREE.InstancedBufferAttribute(new Float32Array(progress), 2));
  geometry.instanceCount = starts.length / 3;
  // 頂点の位置は描画のときに求めるので、視錐台で切り捨てられないよう囲む球を地球全体にする
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.01);
  return geometry;
}

function ribbonMaterial(color: THREE.Color, width: number, head: number, dashed = false, flow = 0): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFlow: { value: flow },
      uColor: { value: color },
      uOpacity: { value: 0 },
      uReveal: { value: 0 },
      uHead: { value: head },
      uDashes: { value: dashed ? DASH_COUNT : 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uWidth: { value: width },
    },
    vertexShader: RIBBON_VS,
    fragmentShader: RIBBON_FS,
    transparent: true,
    depthWrite: false,
  });
}

// 矢印の形。線の途中に ARROW_COUNT 個 (端から少し離す) と、終点に 1 個置く。
// 位置は進み具合 (0〜1) で決め、その位置の線分を補間して求める
function buildArrows(lines: { coords: number[]; progress: number[] }[]): THREE.InstancedBufferGeometry {
  const targets = Array.from({ length: ARROW_COUNT }, (_, i) => (i + 0.5) / ARROW_COUNT);
  const positions: number[] = [];
  const aheads: number[] = [];
  const progress: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const place = (lon0: number, lat0: number, lon1: number, lat1: number, t: number, value: number): void => {
    const lon = lon0 + (lon1 - lon0) * t;
    const lat = lat0 + (lat1 - lat0) * t;
    lonLatToVector3(lon, lat, LINE_RADIUS, a);
    lonLatToVector3(lon + (lon1 - lon0) * 0.05, lat + (lat1 - lat0) * 0.05, LINE_RADIUS, b);
    positions.push(a.x, a.y, a.z);
    aheads.push(b.x, b.y, b.z);
    progress.push(value);
  };
  // 一番先まで伸びる線の終点に、終点の矢印を置く
  let last: { coords: number[]; progress: number[] } | null = null;
  for (const line of lines) {
    const p = line.progress;
    if (!last || p[p.length - 1] > last.progress[last.progress.length - 1]) last = line;
    for (const target of targets) {
      for (let i = 0; i + 1 < p.length; i++) {
        if (p[i] <= target && target < p[i + 1] && p[i + 1] > p[i]) {
          const c = line.coords;
          place(c[i * 2], c[i * 2 + 1], c[i * 2 + 2], c[i * 2 + 3], (target - p[i]) / (p[i + 1] - p[i]), target);
        }
      }
    }
  }
  if (last && last.coords.length >= 4) {
    const c = last.coords;
    const n = c.length;
    place(c[n - 4], c[n - 3], c[n - 2], c[n - 1], 1, last.progress[last.progress.length - 1]);
  }
  const geometry = new THREE.InstancedBufferGeometry();
  // 先端 (1, 0) と根元の左右。根元の中央を少しへこませて、矢じりの形にする
  geometry.setAttribute('corner', new THREE.Float32BufferAttribute([1, 0, -1, 0.85, -0.55, 0, -1, -0.85], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('aPosition', new THREE.InstancedBufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('aAhead', new THREE.InstancedBufferAttribute(new Float32Array(aheads), 3));
  geometry.setAttribute('aProgress', new THREE.InstancedBufferAttribute(new Float32Array(progress), 1));
  geometry.instanceCount = progress.length;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.01);
  return geometry;
}

// 線に沿った距離を 0〜1 にする (outline の輪や、座標で渡された線用)
function progressAlong(coords: number[]): number[] {
  const out = [0];
  let total = 0;
  for (let i = 2; i + 1 < coords.length; i += 2) {
    const midLat = ((coords[i + 1] + coords[i - 1]) / 2) * (Math.PI / 180);
    total += Math.hypot((coords[i] - coords[i - 2]) * Math.cos(midLat), coords[i + 1] - coords[i - 1]);
    out.push(total);
  }
  return out.map((d) => (total > 0 ? d / total : 0));
}

// 多角形 (輪の並び。1 つ目が外周) を三角形に分け、地表に沿うように細かくして球に貼る
// 頂点ごとに輪郭までの距離 (km) も求め、グラデーションの幅を範囲の大きさから決めて返す
function buildFill(polygons: number[][][]): { geometry: THREE.BufferGeometry; width: number } {
  const positions: number[] = [];
  const edges: number[] = [];
  const v = new THREE.Vector3();
  let segments: [THREE.Vector2, THREE.Vector2][] = [];
  let farthest = 0;
  // 点から輪郭 (外周と穴の辺) までの一番近い距離。経度は緯度に合わせて縮める
  const edgeDistance = (lon: number, lat: number): number => {
    const k = Math.cos((lat * Math.PI) / 180);
    let best = Infinity;
    for (const [a, b] of segments) {
      const ax = (a.x - lon) * k;
      const ay = a.y - lat;
      const bx = (b.x - lon) * k;
      const by = b.y - lat;
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1e-12)));
      const d = Math.hypot(ax + dx * t, ay + dy * t);
      if (d < best) best = d;
    }
    return best * 111.2;
  };
  const cache = new Map<string, number>();
  const push = (lon: number, lat: number): void => {
    lonLatToVector3(lon, lat, FILL_RADIUS, v);
    positions.push(v.x, v.y, v.z);
    const key = `${lon.toFixed(5)},${lat.toFixed(5)}`;
    let d = cache.get(key);
    if (d === undefined) {
      d = edgeDistance(lon, lat);
      cache.set(key, d);
    }
    edges.push(d);
    if (d > farthest) farthest = d;
  };
  const subdivide = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, depth: number): void => {
    const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    if (longest <= MAX_TRIANGLE_DEG || depth > 8) {
      push(a.x, a.y);
      push(b.x, b.y);
      push(c.x, c.y);
      return;
    }
    const ab = a.clone().add(b).multiplyScalar(0.5);
    const bc = b.clone().add(c).multiplyScalar(0.5);
    const ca = c.clone().add(a).multiplyScalar(0.5);
    subdivide(a, ab, ca, depth + 1);
    subdivide(ab, b, bc, depth + 1);
    subdivide(ca, bc, c, depth + 1);
    subdivide(ab, bc, ca, depth + 1);
  };
  for (const rings of polygons) {
    // 外周の最初の点を基準に経度を続け、穴も同じ基準にそろえる
    const reference = rings[0][0];
    const toPoints = (ring: number[]): THREE.Vector2[] => {
      const unwrapped = unwrapLongitudes([reference, ring[1], ...ring], 0).slice(2);
      const points: THREE.Vector2[] = [];
      for (let i = 0; i + 1 < unwrapped.length; i += 2) points.push(new THREE.Vector2(unwrapped[i], unwrapped[i + 1]));
      if (points.length > 1 && points[0].equals(points[points.length - 1])) points.pop(); // 閉じる点は除く
      return points;
    };
    const contour = toPoints(rings[0]);
    const holes = rings.slice(1).map(toPoints);
    const all = [contour, ...holes].flat();
    segments = [contour, ...holes].flatMap((ring) => ring.map((point, i): [THREE.Vector2, THREE.Vector2] => [point, ring[(i + 1) % ring.length]]));
    cache.clear();
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holes)) subdivide(all[i], all[j], all[k], 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('aEdge', new THREE.Float32BufferAttribute(edges, 1));
  return { geometry, width: Math.min(AREA_GRADIENT_MAX_KM, Math.max(AREA_GRADIENT_MIN_KM, farthest * AREA_GRADIENT_SHARE)) };
}

// ラベル。画面に入っていて地球の手前にあり、ほかのラベルと重ならない候補の点のうち、画面の中心に一番近い点に置く。
// 範囲は 1 つ目の点 (重心) が使えればそこを使う。川は、なぞり終えた所の点だけを使う。
// 国名、点のハイライトの名前、範囲の名前は、重なるときはずらして置く (右、左、斜め、上下の順に空いている所を探す)。
// 点のハイライトの印は名前と別の要素で、いつも点の位置に置く
interface Label {
  element: HTMLElement;
  points: THREE.Vector3[];
  progress: number[]; // 川の候補の点の、源流からの距離 (0〜1)。範囲は 0
  preferFirst: boolean;
  fixed: boolean; // 国名と点。位置が決まっているので先に置き、重なるときは出さない
  align: 'above' | 'center' | 'dot'; // 点の上 (川)、点に中央そろえ (範囲、国名)、点に印を置いて右に文字 (点のハイライト)
  current: number; // 今置いている候補 (-1 は置いていない)
  offset: number; // 今使っているずらし方 (placements の何番目か)
  transform: string;
  width: number; // 文字の大きさは変わらないので、最初に測って使い回す
  height: number;
  dot: HTMLElement | null; // 点のハイライトの印
  dotTransform: string;
  dotBox: LabelBox | null; // 印が占める範囲。自分の名前は重なりの判定から外す
  country?: string; // 国名のラベルの国 (ADM0_A3)。複数のハイライトが同じ国を出すときは 1 つだけ出す
  frame: boolean; // カメラを寄せるときに収める点か (国名は国の中央にあり対象から遠いことがあるので外す)
}

// ラベルを置く場所の候補。点 (x, y) に対する左上の位置を、試す順に返す。
// dot は印の右、左、斜め、上下。center は中央、上下、左右。above (川の名前) は線の上だけ
function placements(align: Label['align'], x: number, y: number, w: number, h: number): [number, number][] {
  const g = POINT_TEXT_GAP;
  if (align === 'dot') {
    return [
      [x + g, y - h / 2],
      [x - g - w, y - h / 2],
      [x + g * 0.5, y - h - g * 0.5],
      [x + g * 0.5, y + g * 0.5],
      [x - g * 0.5 - w, y - h - g * 0.5],
      [x - g * 0.5 - w, y + g * 0.5],
      [x - w / 2, y - h - g],
      [x - w / 2, y + g],
    ];
  }
  if (align === 'center') {
    return [
      [x - w / 2, y - h / 2],
      [x - w / 2, y - h * 1.4],
      [x - w / 2, y + h * 0.4],
      [x + w * 0.1, y - h / 2],
      [x - w * 1.1, y - h / 2],
      [x + w * 0.1, y - h * 1.4],
      [x + w * 0.1, y + h * 0.4],
      [x - w * 1.1, y - h * 1.4],
      [x - w * 1.1, y + h * 0.4],
    ];
  }
  return [[x - w / 2, y - h * 1.9]];
}

interface Item {
  group: THREE.Group;
  ribbons: { material: THREE.ShaderMaterial; seconds: number }[];
  fill: THREE.ShaderMaterial | null;
  labels: Label[];
  countryCodes: string[]; // 国名を出している国 (ADM0_A3)
  revealSeconds: number;
  labelOpacity: number; // update で求め、layoutLabels で使う
  labelReveal: number;
  clock: number;
  fade: number;
  leaving: boolean;
}

const easeInOut = (t: number): number => t * t * (3 - 2 * t);

export class Highlights {
  readonly group = new THREE.Group();
  private items: Item[] = [];
  private rivers: Promise<RiverRecord[]> | null = null;
  private regions: Promise<RegionRecord[]> | null = null;
  private points: Promise<PointRecord[]> | null = null;
  private countries: Promise<Map<string, CountryRecord>> | null = null;
  private readonly resolution = new THREE.Vector2(1, 1);
  private readonly projected = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();

  constructor(private readonly labelContainer: HTMLElement) {}

  private loadRivers(): Promise<RiverRecord[]> {
    this.rivers ??= import('./data/rivers-10m.json').then((mod) => mod.default as unknown as RiverRecord[]);
    return this.rivers;
  }

  private loadCountries(): Promise<Map<string, CountryRecord>> {
    this.countries ??= import('./data/countries-10m.json').then(
      (mod) => new Map((mod.default as unknown as CountryRecord[]).map((country) => [country.a3, country])),
    );
    return this.countries;
  }

  private loadPoints(): Promise<PointRecord[]> {
    this.points ??= import('./data/points-10m.json').then((mod) => mod.default as unknown as PointRecord[]);
    return this.points;
  }

  private loadRegions(): Promise<RegionRecord[]> {
    this.regions ??= import('./data/regions-10m.json').then((mod) => mod.default as unknown as RegionRecord[]);
    return this.regions;
  }

  // 1 つの対象を示す。append でなければ、今示しているものは消える。見つからなければ null
  async show(spec: HighlightSpec, append = false): Promise<HighlightInfo | null> {
    const built = await this.build(spec);
    if (!built) return null;
    if (!append) this.clear();
    this.items.push(built.item);
    this.group.add(built.item.group);
    return built.info;
  }

  // 示しているもの (消えかけのものは除く) の、カメラに収めたい地点。川と線は沿った点、範囲は重心と縁、点はその位置
  framePoints(): { lat: number; lon: number }[] {
    const out: { lat: number; lon: number }[] = [];
    for (const item of this.items) {
      if (item.leaving) continue;
      for (const label of item.labels) {
        if (!label.frame) continue;
        for (const point of label.points) {
          const length = point.length();
          // globe.ts の lonLatToVector3 の逆 (region-camera.ts の lonLatOf と同じ式)
          out.push({
            lat: (Math.asin(point.y / length) * 180) / Math.PI,
            lon: ((((Math.atan2(point.z, -point.x) * 180) / Math.PI - 180 + 540) % 360) - 180),
          });
        }
      }
    }
    return out;
  }

  // 国名を出している国。設定の「国名を表示」の国名と二重にしないために使う
  activeCountries(): Set<string> {
    return new Set(this.items.filter((item) => !item.leaving).flatMap((item) => item.countryCodes));
  }

  // 示しているものをすべて、ふわっと消す
  clear(): void {
    for (const item of this.items) item.leaving = true;
  }

  private async build(spec: HighlightSpec): Promise<{ item: Item; info: HighlightInfo } | null> {
    const item: Item = { group: new THREE.Group(), ribbons: [], fill: null, labels: [], countryCodes: [], revealSeconds: 1, labelOpacity: 0, labelReveal: 0, clock: 0, fade: 0, leaving: false };
    const addLabel = (text: string, kind: 'river' | 'area', points: THREE.Vector3[], progress: number[], preferFirst: boolean): void => {
      if (!text || points.length === 0) return;
      const element = document.createElement('span');
      element.className = `highlight-label ${kind}`;
      element.textContent = text;
      element.style.color = labelColor(css);
      element.style.opacity = '0';
      this.labelContainer.append(element);
      const align = kind === 'river' ? 'above' : 'center';
      item.labels.push({ element, points, progress, preferFirst, fixed: false, align, current: -1, offset: 0, transform: '', width: 0, height: 0, dot: null, dotTransform: '', dotBox: null, frame: true });
    };
    // 点のハイライト。光る印 (点の位置に置く) と、名前 (標高があれば添える。重なるときはずらす)
    const addPointLabel = (text: string, elevation: number | null, lon: number, lat: number): void => {
      const dot = document.createElement('span');
      dot.className = 'highlight-dot';
      dot.style.setProperty('--dot-color', css);
      dot.style.opacity = '0';
      this.labelContainer.append(dot);
      const element = document.createElement('span');
      element.className = 'highlight-label point';
      const name = document.createElement('span');
      name.textContent = text;
      element.append(name);
      if (elevation !== null) {
        const height = document.createElement('span');
        height.className = 'elevation';
        height.textContent = `${elevation.toLocaleString('ja-JP')}m`;
        element.append(height);
      }
      element.style.opacity = '0';
      this.labelContainer.append(element);
      const point = lonLatToVector3(lon, lat, LINE_RADIUS);
      item.labels.push({ element, points: [point], progress: [0], preferFirst: true, fixed: true, align: 'dot', current: -1, offset: 0, transform: '', width: 0, height: 0, dot, dotTransform: '', dotBox: null, frame: true });
    };
    // 通る国、重なる国の名前と国旗。国の中央付近の点に置き、川は光る線がその国に差しかかってから出す
    const countryList = await this.loadCountries();
    const addCountries = (entries: [string, number][]): HighlightInfo['countries'] => {
      const listed: NonNullable<HighlightInfo['countries']> = [];
      for (const [code, first] of entries) {
        const country = countryList.get(code);
        if (!country) continue;
        listed.push({ code, name: country.n, nameJa: country.ja });
        if (spec.countries === false) continue; // 一覧は返すが、画面には出さない
        item.countryCodes.push(code);
        const element = document.createElement('span');
        element.className = 'highlight-label country';
        if (country.f) {
          const flag = document.createElement('img');
          flag.src = `./flags/${country.f}.svg`;
          flag.alt = '';
          element.append(flag);
        }
        element.append(country.ja || country.n);
        element.style.opacity = '0';
        this.labelContainer.append(element);
        const point = lonLatToVector3(country.x, country.y, LINE_RADIUS);
        item.labels.push({ element, points: [point], progress: [first], preferFirst: true, fixed: true, align: 'center', current: -1, offset: 0, transform: '', width: 0, height: 0, dot: null, dotTransform: '', dotBox: null, frame: false, country: code });
      }
      return listed;
    };
    const lineCandidates = (lines: { coords: number[]; progress: number[] }[]): { points: THREE.Vector3[]; progress: number[] } => {
      const total = lines.reduce((sum, line) => sum + line.progress.length, 0);
      const stride = Math.max(1, Math.floor(total / LABEL_CANDIDATES));
      const points: THREE.Vector3[] = [];
      const progress: number[] = [];
      for (const line of lines) {
        for (let i = 0; i < line.progress.length; i += stride) {
          points.push(lonLatToVector3(line.coords[i * 2], line.coords[i * 2 + 1], LINE_RADIUS));
          progress.push(line.progress[i]);
        }
      }
      return { points, progress };
    };
    // 範囲のラベルの候補。1 つ目は一番大きな多角形の外周の点の平均 (おおよその重心)、残りは縁の点
    const areaCandidates = (polygons: number[][][]): THREE.Vector3[] => {
      const outer = polygons.map((rings) => unwrapLongitudes(rings[0])).reduce((a, b) => (b.length > a.length ? b : a));
      let lon = 0;
      let lat = 0;
      for (let i = 0; i + 1 < outer.length; i += 2) {
        lon += outer[i];
        lat += outer[i + 1];
      }
      const count = outer.length / 2;
      const points = [lonLatToVector3(lon / count, lat / count, LINE_RADIUS)];
      const stride = Math.max(1, Math.floor(count / 60));
      for (let i = 0; i < count; i += stride) points.push(lonLatToVector3(outer[i * 2], outer[i * 2 + 1], LINE_RADIUS));
      return points;
    };
    // 範囲は色を決める前に探す (種類で既定の色が変わる)
    const region = spec.type === 'area' ? findByName(await this.loadRegions(), spec.name, regionNames) : null;
    // 色の指定 (パレットの名前か CSS の色)。省くと、線と川は空色、範囲は種類に合った色 (山は若葉、砂漠は砂金など)、点は白
    const fallback =
      spec.type === 'area'
        ? areaColorOf(region?.c)
        : spec.type === 'polygon'
          ? HIGHLIGHT_PALETTE.violet
        : spec.type === 'point'
          ? HIGHLIGHT_PALETTE.snow
          : HIGHLIGHT_PALETTE.sky;
    const css = resolveColor(spec.color, fallback);
    const base = new THREE.Color(css);
    const lineColor = base.clone().multiplyScalar(spec.type === 'river' ? RIVER_GLOW : LINE_GLOW);
    const areaColor = base;
    const areaLineColor = lineColor;
    // flow は揺らぎの種類。wave は流れる波 (川と線)、twinkle はきらめき (範囲の縁取り)
    const addRibbon = (lines: { coords: number[]; progress: number[] }[], color: THREE.Color, width: number, seconds: number, head: number, arrows = false, flow: 'none' | 'wave' | 'twinkle' = 'none'): void => {
      const flowMode = flow === 'wave' ? 1 : flow === 'twinkle' ? 2 : 0;
      const material = ribbonMaterial(color, width, head, spec.dashed, flowMode);
      item.group.add(new THREE.Mesh(buildRibbon(lines), material));
      item.ribbons.push({ material, seconds });
      if (!arrows) return;
      const arrow = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uFlow: { value: flowMode },
          uColor: { value: color },
          uOpacity: { value: 0 },
          uReveal: { value: 0 },
          uResolution: { value: new THREE.Vector2(1, 1) },
          uWidth: { value: ARROW_SIZE_PX * 2 },
        },
        vertexShader: ARROW_VS,
        fragmentShader: ARROW_FS,
        transparent: true,
        depthWrite: false,
      });
      item.group.add(new THREE.Mesh(buildArrows(lines), arrow));
      item.ribbons.push({ material: arrow, seconds });
    };
    const addArea = (polygons: number[][][]): void => {
      const fill = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: areaColor }, uOpacity: { value: 0 }, uWidth: { value: 1 }, uSpread: { value: 0 } },
        vertexShader: FILL_VS,
        fragmentShader: FILL_FS,
        transparent: true,
        // 点を間引いた輪郭がわずかに交差すると三角形が重なり、半透明が何重にも足されて明るい四角が出た。
        // 塗りはどこも同じ高さなので、奥行きを書き込み、同じ深さの 2 枚目以降は描かない (Less で同じ深さは通らない)
        depthWrite: true,
        depthFunc: THREE.LessDepth,
        side: THREE.DoubleSide,
      });
      const built = buildFill(polygons);
      fill.uniforms.uWidth.value = built.width;
      item.group.add(new THREE.Mesh(built.geometry, fill));
      item.fill = fill;
      const rings = polygons.flat().map((ring) => {
        const coords = unwrapLongitudes(ring);
        return { coords, progress: progressAlong(coords) };
      });
      addRibbon(rings, areaLineColor, OUTLINE_WIDTH_PX, OUTLINE_REVEAL_SECONDS, 0.6, false, 'twinkle');
    };
    const flatOf = (points: [number, number][]): number[] => points.flatMap(([lat, lon]) => [lon, lat]);

    if (spec.type === 'river') {
      const river = findByName(await this.loadRivers(), spec.name, riverNames);
      if (!river) return null;
      const lines = river.l.map((line) => {
        const coords = unwrapLongitudes(line.slice(1));
        // 各点の源流からの距離を、線の始点の距離に線に沿った長さを足して求める
        const along = progressAlong(coords);
        let length = 0;
        for (let i = 2; i + 1 < coords.length; i += 2) {
          const midLat = ((coords[i + 1] + coords[i - 1]) / 2) * (Math.PI / 180);
          length += Math.hypot((coords[i] - coords[i - 2]) * Math.cos(midLat), coords[i + 1] - coords[i - 1]) * 111.2;
        }
        const progress = along.map((t) => Math.min(1, (line[0] + t * length) / Math.max(river.L, 1)));
        return { coords, progress };
      });
      // 川は流れる光で向きが分かるので、arrows を指定されても矢印は描かない
      addRibbon(lines, lineColor, RIVER_WIDTH_PX, RIVER_REVEAL_SECONDS, RIVER_HEAD, false, 'wave');
      const candidates = lineCandidates(lines);
      addLabel(spec.label ?? river.n, 'river', candidates.points, candidates.progress, false);
      item.revealSeconds = RIVER_REVEAL_SECONDS;
      const countries = addCountries(river.c);
      return { item, info: { name: river.n, kind: 'river', lengthKm: river.L, bounds: boundsOf(river.l, 1), countries } };
    }
    if (spec.type === 'area') {
      if (!region) return null;
      addArea(region.p);
      const points = areaCandidates(region.p);
      addLabel(spec.label ?? (region.ja || region.n), 'area', points, points.map(() => 0), true);
      const countries = addCountries(region.k.map((code) => [code, 0]));
      return { item, info: { name: region.n, nameJa: region.ja, kind: region.c, bounds: boundsOf(region.p.flat()), countries } };
    }
    if (spec.type === 'point') {
      let found: PointRecord | null = null;
      if (spec.name) found = findByName(await this.loadPoints(), spec.name, pointNames);
      const lat = spec.lat ?? found?.y;
      const lon = spec.lon ?? found?.x;
      if (lat === undefined || lon === undefined) return null;
      const text = spec.label ?? (found ? found.ja || found.n : spec.name ?? '');
      const elevation = spec.elevation ?? found?.e ?? null;
      addPointLabel(text, elevation, lon, lat);
      const countries = addCountries((found?.k ?? []).map((code) => [code, 0]));
      const info: HighlightInfo = {
        name: found?.n ?? spec.name ?? '',
        nameJa: found?.ja,
        kind: found?.c ?? 'point',
        bounds: { south: lat, north: lat, west: lon, east: lon },
        countries,
      };
      if (elevation) info.elevationM = elevation;
      return { item, info };
    }
    if (spec.points.length < 2) return null;
    const coords = unwrapLongitudes(flatOf(spec.points));
    const text = spec.label ?? spec.name ?? '';
    if (spec.type === 'arrow') {
      const lonLats: [number, number][] = [];
      for (let i = 0; i + 1 < coords.length; i += 2) lonLats.push([coords[i], coords[i + 1]]);
      const arrow = buildThickArrow(lonLats, spec.width ?? defaultArrowWidthKm(lonLats));
      if (!arrow) return null;
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uFlow: { value: 1 },
          uColor: { value: base.clone().multiplyScalar(LINE_GLOW) },
          uOpacity: { value: 0 },
          uReveal: { value: 0 },
          uResolution: { value: new THREE.Vector2(1, 1) }, // 使わないが、線と同じ更新で値を入れる
          uStrength: { value: spec.dashed ? THICK_ARROW_DASHED : 1 },
        },
        vertexShader: THICK_ARROW_VS,
        fragmentShader: THICK_ARROW_FS,
        transparent: true,
        // 急に曲がる所で帯が重なっても、半透明が二重に足されないようにする (範囲の塗りと同じ)
        depthWrite: true,
        depthFunc: THREE.LessDepth,
        side: THREE.DoubleSide,
      });
      item.group.add(new THREE.Mesh(buildThickArrowFill(arrow.triangles), material));
      item.ribbons.push({ material, seconds: THICK_ARROW_REVEAL_SECONDS });
      // 縁取り。左右の縁と、根元の端
      const edgeLine = (vertices: ArrowVertex[]) => ({
        coords: vertices.flatMap((p) => [p.lon, p.lat]),
        progress: vertices.map((p) => p.progress),
      });
      const tail = [arrow.outline.left[0], arrow.outline.right[0]];
      addRibbon([edgeLine(arrow.outline.left), edgeLine(arrow.outline.right), edgeLine(tail)], lineColor, OUTLINE_WIDTH_PX, THICK_ARROW_REVEAL_SECONDS, 1, false, 'wave');
      const centerLine = edgeLine(arrow.center);
      const candidates = lineCandidates([centerLine]);
      addLabel(text, 'river', candidates.points, candidates.progress, false);
      item.revealSeconds = THICK_ARROW_REVEAL_SECONDS;
      return { item, info: { name: spec.name ?? '', kind: 'arrow', lengthKm: Math.round(arrow.lengthKm), bounds: boundsOf([coords]) } };
    }
    if (spec.type === 'line') {
      const line = { coords, progress: progressAlong(coords) };
      addRibbon([line], lineColor, RIVER_WIDTH_PX, RIVER_REVEAL_SECONDS, 1, spec.arrows ?? true, 'wave');
      const candidates = lineCandidates([line]);
      addLabel(text, 'river', candidates.points, candidates.progress, false);
      item.revealSeconds = RIVER_REVEAL_SECONDS;
    } else {
      const closed = [...coords, coords[0], coords[1]];
      addArea([[closed]]);
      const points = areaCandidates([[closed]]);
      addLabel(text, 'area', points, points.map(() => 0), true);
    }
    return { item, info: { name: spec.name ?? '', kind: spec.type, bounds: boundsOf([coords]) } };
  }

  // 毎フレーム呼ぶ。width と height は描画の画素数
  update(dt: number, width: number, height: number, visible: boolean): void {
    this.resolution.set(width, height);
    this.group.visible = visible;
    for (const item of this.items) {
      item.clock += dt;
      item.fade = item.leaving ? Math.max(0, item.fade - dt / FADE_OUT_SECONDS) : Math.min(1, item.fade + dt / FADE_IN_SECONDS);
      const opacity = easeInOut(item.fade);
      for (const { material, seconds } of item.ribbons) {
        const u = material.uniforms;
        u.uReveal.value = easeInOut(Math.min(1, item.clock / seconds)) * 1.0001;
        u.uTime.value = item.clock;
        u.uOpacity.value = opacity;
        u.uResolution.value.copy(this.resolution);
      }
      if (item.fill) {
        item.fill.uniforms.uOpacity.value = opacity * AREA_FILL_OPACITY;
        // 縁取りを描き終えてから、内側のグラデーションを縁から内へ広げる
        item.fill.uniforms.uSpread.value = easeInOut(THREE.MathUtils.clamp((item.clock - OUTLINE_REVEAL_SECONDS) / AREA_SPREAD_SECONDS, 0, 1));
      }
      item.labelOpacity = visible ? opacity : 0;
      item.labelReveal = easeInOut(Math.min(1, item.clock / item.revealSeconds));
    }
    // 消えきったものを片付ける
    for (const item of this.items.filter((i) => i.leaving && i.fade <= 0)) {
      this.group.remove(item.group);
      for (const label of item.labels) {
        label.element.remove();
        label.dot?.remove();
      }
      item.group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
    }
    this.items = this.items.filter((i) => !(i.leaving && i.fade <= 0));
  }

  // 毎フレーム、update のあとに呼ぶ。blocked は重ねない範囲 (地点のマーカー)。置いたラベルの範囲を返すので、
  // 都市のラベルと国名はそれを避けて置く (ツアーで示しているものを優先する)。
  // 国名は位置が決まっているので先に置き、候補の多い川や範囲の名前は空いている所を選ぶ
  layoutLabels(camera: THREE.Camera, blocked: LabelBox[]): LabelBox[] {
    const placed = [...blocked];
    const result: LabelBox[] = [];
    // 点のハイライトの印を先に置く。印はずらさず、ほかのラベルは印に重ねない
    for (const item of this.items) {
      for (const label of item.labels) {
        if (!label.dot) continue;
        const point = item.labelOpacity > 0.01 ? this.screenPoint(label.points[0], camera) : null;
        if (point) {
          const box = { x: point.x - DOT_BOX / 2, y: point.y - DOT_BOX / 2, width: DOT_BOX, height: DOT_BOX };
          label.dotBox = box;
          placed.push(box);
          result.push(box);
          const transform = `translate(${(point.x - DOT_SIZE / 2).toFixed(1)}px, ${(point.y - DOT_SIZE / 2).toFixed(1)}px)`;
          if (transform !== label.dotTransform) {
            label.dotTransform = transform;
            label.dot.style.transform = transform;
          }
        }
        label.dot.style.opacity = point ? item.labelOpacity.toFixed(3) : '0';
      }
    }
    const countries = new Set<string>();
    for (const fixedPass of [true, false]) {
      for (const item of this.items) {
        for (const label of item.labels) {
          if (label.fixed !== fixedPass) continue;
          const duplicate = label.country !== undefined && countries.has(label.country);
          const box = item.labelOpacity > 0.01 && !duplicate ? this.chooseBox(label, camera, item.labelReveal, placed) : null;
          if (box && label.country) countries.add(label.country);
          if (box) {
            placed.push(box);
            result.push(box);
            const transform = `translate(${box.x.toFixed(1)}px, ${box.y.toFixed(1)}px)`;
            if (transform !== label.transform) {
              label.transform = transform;
              label.element.style.transform = transform;
            }
          } else label.current = -1;
          label.element.style.opacity = box ? item.labelOpacity.toFixed(3) : '0';
        }
      }
    }
    return result;
  }

  private chooseBox(label: Label, camera: THREE.Camera, reveal: number, placed: LabelBox[]): LabelBox | null {
    if (label.width === 0) {
      label.width = label.element.offsetWidth;
      label.height = label.element.offsetHeight;
    }
    // 候補の点に置いたときの範囲と、画面の中心からの距離 (NDC)。使えない点と、どうずらしても重なる点は null。
    // ずらすのは 1 点しかないラベルと、範囲の名前の重心だけ (川の名前は候補の点が多いので、ほかの点を選ぶ)
    const candidate = (index: number): { box: LabelBox; distance: number; offset: number } | null => {
      if (label.progress[index] > reveal + 1e-4) return null;
      const point = this.screenPoint(label.points[index], camera);
      if (!point) return null;
      const all = placements(label.align, point.x, point.y, label.width, label.height);
      const options = label.fixed || (label.preferFirst && index === 0) ? all : all.slice(0, 1);
      // ちらつかないよう、今のずらし方を先に試す
      const order = options.map((_, k) => k);
      if (index === label.current && label.offset < options.length) order.unshift(label.offset);
      for (const k of order) {
        const [x, y] = options[k];
        const box = { x, y, width: label.width, height: label.height };
        if (!placed.some((other) => other !== label.dotBox && overlaps(box, other))) return { box, distance: point.distance, offset: k };
      }
      return null;
    };
    if (label.preferFirst) {
      const first = candidate(0);
      if (first) {
        label.current = 0;
        label.offset = first.offset;
        return first.box;
      }
    }
    let best: { box: LabelBox; distance: number; offset: number } | null = null;
    let chosen = -1;
    for (let i = label.preferFirst ? 1 : 0; i < label.points.length; i++) {
      const c = candidate(i);
      if (c && (!best || c.distance < best.distance)) {
        best = c;
        chosen = i;
      }
    }
    // ちらつかないよう、今の点がまだ使えて、はっきり中心に近い点がなければ動かさない
    const current = label.current >= 0 && label.current !== chosen ? candidate(label.current) : null;
    if (current && (!best || best.distance > current.distance * LABEL_KEEP_RATIO)) {
      label.offset = current.offset;
      return current.box;
    }
    label.current = chosen;
    if (best) label.offset = best.offset;
    return best?.box ?? null;
  }

  // 点の画面上の位置 (CSS ピクセル) と、画面の中心からの距離 (NDC)。地球の裏側や画面の端の外は null
  private screenPoint(point: THREE.Vector3, camera: THREE.Camera): { x: number; y: number; distance: number } | null {
    if (point.dot(this.toCamera.copy(camera.position).sub(point)) <= 0) return null;
    this.projected.copy(point).project(camera);
    if (this.projected.z >= 1 || Math.abs(this.projected.x) > 0.9 || Math.abs(this.projected.y) > 0.85) return null;
    return {
      x: ((this.projected.x + 1) / 2) * window.innerWidth,
      y: ((1 - this.projected.y) / 2) * window.innerHeight,
      distance: Math.hypot(this.projected.x, this.projected.y),
    };
  }
}
