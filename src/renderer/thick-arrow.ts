// 太さのある矢印 (ツアーのハイライトの arrow) の形。帯は地表の距離 (km) で一定の太さを持ち、
// 先端に帯より幅の広い矢じりを付ける (根元から先へ太らせる形は、道筋が読みにくいのでやめた)。渡された点を直線で結び、角だけを丸めてから帯にする
// (角で帯が折れ重なるのを防ぐ)。描画 (highlights.ts) から切り離して検証できるよう、Three.js に依存しない。
// 計算は矢印のまわりの平面 (経度を緯度で縮めた km の座標) で行う。数千 km までの矢印ならずれは小さい

const KM_PER_DEGREE = 111.2;
const HEAD_WIDTH_RATIO = 1.9; // 矢じりの幅 (帯の太さに対する割合)
const HEAD_LENGTH_RATIO = 1.3; // 矢じりの長さ (矢じりの幅に対する割合)
const HEAD_MAX_SHARE = 0.4; // 短い矢印でも、矢じりは全体の長さのこの割合まで
const SAMPLE_PER_WIDTH = 3; // 道筋を、帯の太さの 1/3 ごとに区切る
const CORNER_RADIUS_RATIO = 2; // 角を丸める大きさ (帯の太さに対する割合)

// 頂点。lon, lat は度、progress は根元からの進み具合 (0〜1)、side は帯の左右 (-1〜1。矢じりの先端は 0)
export interface ArrowVertex {
  lon: number;
  lat: number;
  progress: number;
  side: number;
}

export interface ThickArrow {
  triangles: [ArrowVertex, ArrowVertex, ArrowVertex][];
  outline: { left: ArrowVertex[]; right: ArrowVertex[] }; // 根元から先端までの左右の縁 (どちらも先端で終わる)
  center: ArrowVertex[]; // 中心の線 (ラベルを置く候補)
  lengthKm: number;
}

type Vec = [number, number];

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const scale = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k];
const length = (a: Vec): number => Math.hypot(a[0], a[1]);
const normalize = (a: Vec): Vec => {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0];
};

// 点 (平面の km) を直線で結び、角だけを丸めた道筋を、step ごとに区切った点の並びにする。
// 角は、曲がり始めと曲がり終わりの点を角から radius ほど手前と先に取り、角を制御点にした 2 次ベジェ曲線でつなぐ。
// 前後の線分が短いときは、その半分までに縮める (隣の角の丸めと重ならないように)。
// はじめは点を必ず通るなめらかな曲線 (セントリペタル Catmull-Rom) にしていたが、行って戻る道で折り返しの外へ輪のようにはみ出し、
// 点の間隔がばらばらな所でうねったので、渡された道筋の外へ出ないこの形にした
function roundedPath(points: Vec[], step: number, radius: number): Vec[] {
  const out: Vec[] = [points[0]];
  const pushLine = (from: Vec, to: Vec): void => {
    const count = Math.max(1, Math.ceil(length(sub(to, from)) / step));
    for (let k = 1; k <= count; k++) out.push(add(from, scale(sub(to, from), k / count)));
  };
  let cursor = points[0];
  for (let i = 1; i + 1 < points.length; i++) {
    const corner = points[i];
    const before = length(sub(corner, points[i - 1]));
    const after = length(sub(points[i + 1], corner));
    const cut = Math.min(radius, before / 2, after / 2);
    const start = add(corner, scale(normalize(sub(points[i - 1], corner)), cut));
    const end = add(corner, scale(normalize(sub(points[i + 1], corner)), cut));
    pushLine(cursor, start);
    const count = Math.max(2, Math.ceil((cut * 2) / step));
    for (let k = 1; k <= count; k++) {
      const t = k / count;
      const u = 1 - t;
      out.push(add(add(scale(start, u * u), scale(corner, 2 * u * t)), scale(end, t * t)));
    }
    cursor = end;
  }
  pushLine(cursor, points[points.length - 1]);
  return out;
}

// points は [lon, lat] の並び (経度は日付変更線をまたいでも続くように直したもの)、widthKm は帯の一番太い所の太さ
export function buildThickArrow(points: [number, number][], widthKm: number): ThickArrow | null {
  if (points.length < 2 || !(widthKm > 0)) return null;
  const lon0 = points.reduce((sum, [lon]) => sum + lon, 0) / points.length;
  const lat0 = points.reduce((sum, [, lat]) => sum + lat, 0) / points.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const toPlane = ([lon, lat]: [number, number]): Vec => [(lon - lon0) * k * KM_PER_DEGREE, (lat - lat0) * KM_PER_DEGREE];
  const toLonLat = ([x, y]: Vec): [number, number] => [x / (k * KM_PER_DEGREE) + lon0, y / KM_PER_DEGREE + lat0];

  // 同じ所に重なった点は除く (曲線の計算が乱れる)
  const plane: Vec[] = [];
  for (const point of points.map(toPlane)) {
    if (plane.length === 0 || length(sub(point, plane[plane.length - 1])) > 1e-6) plane.push(point);
  }
  if (plane.length < 2) return null;
  const path = roundedPath(plane, widthKm / SAMPLE_PER_WIDTH, widthKm * CORNER_RADIUS_RATIO);
  const along = [0];
  for (let i = 1; i < path.length; i++) along.push(along[i - 1] + length(sub(path[i], path[i - 1])));
  const total = along[along.length - 1];
  if (total <= 0) return null;

  const headHalf = (widthKm * HEAD_WIDTH_RATIO) / 2;
  const headLength = Math.min(headHalf * 2 * HEAD_LENGTH_RATIO, total * HEAD_MAX_SHARE);
  const tip = path[path.length - 1];
  // 矢じりの根元は、先端からまっすぐ測って headLength だけ離れた曲線上の点にする。矢じりの軸は根元から先端への向き。
  // 根元での曲線の向きを軸にすると、矢じりの区間で曲線が曲がっているときに、矢じりが片側へ偏った
  let shaftEnd = total - headLength;
  {
    let i = path.length - 1;
    while (i > 0 && length(sub(path[i - 1], tip)) < headLength) i--;
    if (i > 0) {
      // path[i - 1] は先端から headLength より遠く、path[i] は近い。その間で距離がちょうど headLength になる所を探す
      let lo = along[i - 1];
      let hi = along[i];
      for (let n = 0; n < 30; n++) {
        const middle = (lo + hi) / 2;
        const p = add(path[i - 1], scale(sub(path[i], path[i - 1]), (middle - along[i - 1]) / Math.max(along[i] - along[i - 1], 1e-9)));
        if (length(sub(p, tip)) > headLength) lo = middle;
        else hi = middle;
      }
      shaftEnd = (lo + hi) / 2;
    } else shaftEnd = 0;
  }
  const tangentAt = (i: number): Vec => normalize(sub(path[Math.min(i + 1, path.length - 1)], path[Math.max(i - 1, 0)]));
  // 曲線上で、根元からの距離が d の点と、その向き
  const pointAt = (d: number): { point: Vec; tangent: Vec } => {
    let i = 1;
    while (i < along.length - 1 && along[i] < d) i++;
    const t = (d - along[i - 1]) / Math.max(along[i] - along[i - 1], 1e-9);
    return { point: add(path[i - 1], scale(sub(path[i], path[i - 1]), t)), tangent: normalize(sub(path[i], path[i - 1])) };
  };
  const vertex = (point: Vec, distance: number, side: number): ArrowVertex => {
    const [lon, lat] = toLonLat(point);
    return { lon, lat, progress: distance / total, side };
  };

  // 帯の左右の縁。根元から矢じりの根元まで同じ太さ
  const left: ArrowVertex[] = [];
  const right: ArrowVertex[] = [];
  const center: ArrowVertex[] = [];
  const shaft: { point: Vec; normal: Vec; distance: number; half: number }[] = [];
  for (let i = 0; i < path.length && along[i] < shaftEnd; i++) {
    const tangent = tangentAt(i);
    shaft.push({ point: path[i], normal: [-tangent[1], tangent[0]], distance: along[i], half: 0 });
  }
  const base = pointAt(shaftEnd);
  const axis = normalize(sub(tip, base.point));
  const baseNormal: Vec = [-axis[1], axis[0]];
  shaft.push({ point: base.point, normal: baseNormal, distance: shaftEnd, half: 0 });
  for (const s of shaft) {
    s.half = widthKm / 2;
    left.push(vertex(add(s.point, scale(s.normal, s.half)), s.distance, 1));
    right.push(vertex(add(s.point, scale(s.normal, -s.half)), s.distance, -1));
    center.push(vertex(s.point, s.distance, 0));
  }
  const triangles: ThickArrow['triangles'] = [];
  for (let i = 0; i + 1 < shaft.length; i++) {
    triangles.push([left[i], right[i], right[i + 1]], [left[i], right[i + 1], left[i + 1]]);
  }

  // 矢じり。根元の左右の角と先端。中心の点も置き、帯の中央と同じように左右の値が 0 になるようにする
  const headLeft = vertex(add(base.point, scale(baseNormal, headHalf)), shaftEnd, 1);
  const headRight = vertex(add(base.point, scale(baseNormal, -headHalf)), shaftEnd, -1);
  const headCenter = vertex(base.point, shaftEnd, 0);
  const tipVertex = vertex(tip, total, 0);
  triangles.push([headLeft, headCenter, tipVertex], [headCenter, headRight, tipVertex]);
  center.push(tipVertex);
  return {
    triangles,
    // 縁取りは、帯の縁から矢じりの角へ張り出し、先端まで
    outline: { left: [...left, headLeft, tipVertex], right: [...right, headRight, tipVertex] },
    center,
    lengthKm: total,
  };
}

// 根元をグラデーションで消すとき、消える区間の長さ (根元からの進み具合 0〜1)。帯の太さの 4 倍で、全体の 30% まで。
// 根元が消える矢印は「前から続いている道」や「出発点のはっきりしない流れ」を示す
export function arrowFadeShare(widthKm: number, lengthKm: number): number {
  if (!(lengthKm > 0)) return 0;
  return Math.min(0.3, (widthKm * 4) / lengthKm);
}

// 太さを指定されなかったときの太さ (km)。矢印の長さの 3.5% にし、細すぎも太すぎもしないよう抑える。
// はじめは 6% (最大 300km) にしたが、帯が太く、急な曲がり角で帯が重なった
export function defaultArrowWidthKm(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const [lon0, lat0] = points[i - 1];
    const [lon1, lat1] = points[i];
    const k = Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
    total += Math.hypot((lon1 - lon0) * k, lat1 - lat0) * KM_PER_DEGREE;
  }
  return Math.min(150, Math.max(10, total * 0.035));
}

// これより大きく曲がる所 (内側の角度が 45° より鋭い所) で矢印を分ける。来た道を戻る所 (アレキサンダーで 138〜180°) は分け、
// ただの曲がり角 (同じく 112〜113°) は分けない。はじめは 110° にしていて、ただの曲がり角でも切れ、場面 1 が 8 本に分かれた
const SPLIT_TURN_DEG = 135;
const SPLIT_GAP_RATIO = 0.8; // 分けた次の矢印の根元を、前の矢じりから離す距離 (帯の太さに対する割合)

// 点 i で曲がる角度 (度。0 はまっすぐ、180 は来た道を戻る)
function turnAt(points: [number, number][], i: number): number {
  const vector = (a: [number, number], b: [number, number]): Vec => {
    const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
    return [(b[0] - a[0]) * k, b[1] - a[1]];
  };
  const before = normalize(vector(points[i - 1], points[i]));
  const after = normalize(vector(points[i], points[i + 1]));
  const dot = Math.max(-1, Math.min(1, before[0] * after[0] + before[1] * after[1]));
  return (Math.acos(dot) * 180) / Math.PI;
}

// 急に曲がる所で、点の並びを分ける。分けた点はどちらの並びにも入る
export function splitAtSharpTurns(points: [number, number][], maxTurnDeg = SPLIT_TURN_DEG): [number, number][][] {
  const pieces: [number, number][][] = [];
  let current: [number, number][] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    current.push(points[i]);
    if (i + 1 < points.length && turnAt(points, i) > maxTurnDeg) {
      pieces.push(current);
      current = [points[i]];
    }
  }
  pieces.push(current);
  return pieces.filter((piece) => piece.length >= 2);
}

// 急に曲がる所で分けた矢印。進み具合 (progress) は全体を通した値にし、1 本目が伸びきってから 2 本目が伸びるようにする。
// 2 本目からは、前の矢じりと重ならないよう根元を少し先から始める
export function buildSplitArrow(points: [number, number][], widthKm: number): { pieces: ThickArrow[]; lengthKm: number } | null {
  const gapKm = widthKm * SPLIT_GAP_RATIO;
  const built: ThickArrow[] = [];
  splitAtSharpTurns(points).forEach((piece, index) => {
    let start = piece;
    if (index > 0) {
      const [a, b] = piece;
      const k = Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
      const segmentKm = Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * KM_PER_DEGREE;
      const t = Math.min(gapKm, segmentKm * 0.3) / Math.max(segmentKm, 1e-9);
      start = [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ...piece.slice(1)];
    }
    const arrow = buildThickArrow(start, widthKm);
    if (arrow) built.push(arrow);
  });
  if (built.length === 0) return null;
  const total = built.reduce((sum, arrow) => sum + arrow.lengthKm, 0);
  let offset = 0;
  const pieces = built.map((arrow) => {
    const share = arrow.lengthKm / total;
    const base = offset;
    offset += share;
    // 頂点は三角形と縁で共有しているので、同じ頂点は 1 回だけ置き換える
    const mapped = new Map<ArrowVertex, ArrowVertex>();
    const remap = (v: ArrowVertex): ArrowVertex => {
      let out = mapped.get(v);
      if (!out) {
        out = { ...v, progress: base + v.progress * share };
        mapped.set(v, out);
      }
      return out;
    };
    return {
      triangles: arrow.triangles.map(([a, b, c]) => [remap(a), remap(b), remap(c)] as [ArrowVertex, ArrowVertex, ArrowVertex]),
      outline: { left: arrow.outline.left.map(remap), right: arrow.outline.right.map(remap) },
      center: arrow.center.map(remap),
      lengthKm: arrow.lengthKm,
    };
  });
  return { pieces, lengthKm: total };
}
