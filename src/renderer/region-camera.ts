// 地域ビューのカメラの計算。地表の 1 点を画面の中心に置き、そこを軸に斜めから見下ろす。
// 画面の計算から切り離して検証できるよう、Three.js に依存しない。座標は globe.ts の lonLatToVector3 と同じ
import { clamp, DEG, wrapDegrees, type LonLat, type Vec3 } from './math.ts';

export interface RegionView extends LonLat {
  heading: number; // 見ている方角。0 が北、90 が東
  tilt: number; // 0 が真下、大きいほど水平に近い
  distance: number; // 中心の地点からカメラまでの距離 (地球の半径が 1)
}

// ドラッグで動かしたうち、まだカメラに反映していない分 (度)
export interface RegionDelta {
  lat: number;
  lon: number;
  heading: number;
  tilt: number;
}

export const REGION_TILT = 50;
export const REGION_DISTANCE = 0.24;
const MIN_DISTANCE = 0.1;
const MAX_DISTANCE = 1;
export const REGION_MAX_TILT = 72;
const MAX_TILT = REGION_MAX_TILT;
const MAX_LAT = 80; // 極の近くでは経度の移動が大きくなりすぎる
const MAX_PAN_STEP = 10; // 地平線の近くをつかむと、1 回の移動で遠くまで飛ぶのを防ぐ
// ドラッグにカメラが追いつく時定数。急に動かしてもカメラはなめらかに遅れて付いてくる。
// 指を離したあとも残りを反映するので、これが慣性になる。地球ビューの OrbitControls の減衰も同じ値にする
export const DRAG_FOLLOW_SECONDS = 0.35;
const ZOOM_SECONDS = 0.25; // ホイールで変えた距離へ近づくときの時定数。地球ビューでも使う

export const REGION_STILL: RegionDelta = { lat: 0, lon: 0, heading: 0, tilt: 0 };

export function lonLatOf(position: Vec3): LonLat {
  const [x, y, z] = position;
  const lat = Math.asin(clamp(y / Math.hypot(x, y, z), -1, 1)) / DEG;
  return { lat, lon: wrapDegrees(Math.atan2(z, -x) / DEG - 180) };
}

// カメラの位置、中心の地点、画面の上方向を返す
export function regionPose(view: RegionView): { position: Vec3; target: Vec3; up: Vec3 } {
  const phi = (view.lon + 180) * DEG;
  const theta = (90 - view.lat) * DEG;
  const [sinPhi, cosPhi, sinTheta, cosTheta] = [Math.sin(phi), Math.cos(phi), Math.sin(theta), Math.cos(theta)];
  const normal: Vec3 = [-cosPhi * sinTheta, cosTheta, sinPhi * sinTheta];
  const north: Vec3 = [cosPhi * cosTheta, sinTheta, -sinPhi * cosTheta];
  const east: Vec3 = [sinPhi, 0, cosPhi];
  const [sinHeading, cosHeading] = [Math.sin(view.heading * DEG), Math.cos(view.heading * DEG)];
  const [sinTilt, cosTilt] = [Math.sin(view.tilt * DEG), Math.cos(view.tilt * DEG)];
  const ahead = [0, 1, 2].map((i) => north[i] * cosHeading + east[i] * sinHeading);
  const axes = [0, 1, 2];
  return {
    target: normal,
    position: axes.map((i) => normal[i] + view.distance * (normal[i] * cosTilt - ahead[i] * sinTilt)) as unknown as Vec3,
    up: axes.map((i) => normal[i] * sinTilt + ahead[i] * cosTilt) as unknown as Vec3,
  };
}

export function clampRegionView(view: RegionView): RegionView {
  return {
    lat: clamp(view.lat, -MAX_LAT, MAX_LAT),
    lon: wrapDegrees(view.lon),
    heading: wrapDegrees(view.heading),
    tilt: clamp(view.tilt, 0, MAX_TILT),
    distance: clamp(view.distance, MIN_DISTANCE, MAX_DISTANCE),
  };
}

export function clampRegionDistance(distance: number): number {
  return clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
}

// 経度と方角は近い向きへ回る
export function interpolateRegionView(from: RegionView, to: RegionView, t: number): RegionView {
  const mix = (a: number, b: number): number => a + (b - a) * t;
  return {
    lat: mix(from.lat, to.lat),
    lon: wrapDegrees(from.lon + wrapDegrees(to.lon - from.lon) * t),
    heading: wrapDegrees(from.heading + wrapDegrees(to.heading - from.heading) * t),
    tilt: mix(from.tilt, to.tilt),
    distance: mix(from.distance, to.distance),
  };
}

// 見せたいものが画面に収まるカメラ (ツアーのハイライトに合わせて寄せる・引く)。
// points は見せたい地点 (経度、緯度)。中心は点の重心 (球面上の平均) にし、方角と傾きは渡したものを使う。
// 全部の点が地球の手前にあり、画面の余白 (画面の半分に対する割合) の内側に入る一番近い距離を二分探索で求める。
// 下には字幕と操作のボタンがあるので、余白は上下左右で別に決める。
// 収まらないときは一番遠い距離にする
export interface FrameOptions {
  heading: number;
  tilt: number;
  fovY: number; // 縦の画角 (度)
  aspect: number; // 横 / 縦
  margin?: { top: number; bottom: number; side: number };
}

// パネルや字幕に隠れない余白。下は字幕 (画面の下から約 190 画素) と操作のボタンの分を広く取る
const FRAME_MARGIN = { top: 0.16, bottom: 0.38, side: 0.16 };

export function frameRegionView(points: LonLat[], options: FrameOptions): RegionView {
  const vectors = points.map(({ lat, lon }) => {
    const phi = (lon + 180) * DEG;
    const theta = (90 - lat) * DEG;
    return [-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)] as Vec3;
  });
  const sum = [0, 0, 0];
  for (const v of vectors) for (let i = 0; i < 3; i++) sum[i] += v[i];
  const center = lonLatOf(Math.hypot(...sum) > 1e-9 ? ([sum[0], sum[1], sum[2]] as Vec3) : vectors[0]);
  const margin = options.margin ?? FRAME_MARGIN;
  const half = Math.tan((options.fovY * DEG) / 2);
  const top = half * (1 - margin.top);
  const bottom = -half * (1 - margin.bottom);
  const halfX = half * options.aspect * (1 - margin.side);
  const viewAt = (distance: number): RegionView =>
    clampRegionView({ lat: center.lat, lon: center.lon, heading: options.heading, tilt: options.tilt, distance });
  const fits = (view: RegionView): boolean => {
    const { position, target, up } = regionPose(view);
    const forward = [0, 1, 2].map((i) => target[i] - position[i]);
    const length = Math.hypot(...forward);
    const f = forward.map((c) => c / length);
    // right = forward × up
    const right = [f[1] * up[2] - f[2] * up[1], f[2] * up[0] - f[0] * up[2], f[0] * up[1] - f[1] * up[0]];
    return vectors.every((p) => {
      const toCamera = [0, 1, 2].map((i) => position[i] - p[i]);
      if (p[0] * toCamera[0] + p[1] * toCamera[1] + p[2] * toCamera[2] <= 0) return false; // 地平線の向こう
      const v = [0, 1, 2].map((i) => p[i] - position[i]);
      const z = v[0] * f[0] + v[1] * f[1] + v[2] * f[2];
      if (z <= 0) return false;
      const x = (v[0] * right[0] + v[1] * right[1] + v[2] * right[2]) / z;
      const y = (v[0] * up[0] + v[1] * up[1] + v[2] * up[2]) / z;
      return Math.abs(x) <= halfX && y <= top && y >= bottom;
    });
  };
  if (!fits(viewAt(MAX_DISTANCE))) return viewAt(MAX_DISTANCE);
  if (fits(viewAt(MIN_DISTANCE))) return viewAt(MIN_DISTANCE);
  let near = MIN_DISTANCE;
  let far = MAX_DISTANCE;
  for (let i = 0; i < 24; i++) {
    const middle = (near + far) / 2;
    if (fits(viewAt(middle))) far = middle;
    else near = middle;
  }
  return viewAt(far);
}

// 移動のドラッグで中心を動かす量。previous は前の指の下の地点、current は今の指の下の地点 (どちらも同じカメラで求める)。
// 指の下の地面が指に付いてくる向きに動かす
export function panRegionDelta(previous: LonLat, current: LonLat): RegionDelta {
  return {
    lat: clamp(previous.lat - current.lat, -MAX_PAN_STEP, MAX_PAN_STEP),
    lon: clamp(wrapDegrees(previous.lon - current.lon), -MAX_PAN_STEP, MAX_PAN_STEP),
    heading: 0,
    tilt: 0,
  };
}

// ドラッグで動かした分を未反映の分に足す。緯度と傾きは上限を越える分を捨てる。
// 越えた分が溜まると、逆へ戻すときにしばらく動かない間ができる
// pivot が 'camera' (巡航中) のときは、heading と tilt をカメラの位置を軸にした機首の方角と見下ろす角度の量として扱い、
// 見下ろす角度の上限は、中心の地点が範囲に収まるところまでにする
export type RegionPivot = 'center' | 'camera';

export function addRegionDrag(
  view: RegionView,
  pending: RegionDelta,
  delta: RegionDelta,
  pivot: RegionPivot = 'center',
): RegionDelta {
  const lat = clamp(view.lat + pending.lat + delta.lat, -MAX_LAT, MAX_LAT) - view.lat;
  let tilt: number;
  if (pivot === 'camera') {
    const pitch = flightOf(view).pitch;
    const top = flightOf(lookRegionView(view, 0, 90)).pitch;
    tilt = clamp(pitch + pending.tilt + delta.tilt, 0, Math.max(pitch, top)) - pitch;
  } else {
    tilt = clamp(view.tilt + pending.tilt + delta.tilt, 0, MAX_TILT) - view.tilt;
  }
  return { lat, lon: pending.lon + delta.lon, heading: pending.heading + delta.heading, tilt };
}

// 未反映の分を、時定数 DRAG_FOLLOW_SECONDS でなめらかに反映する。FPS によらず同じ動きになるよう時間で減らす
export function followRegionDrag(
  view: RegionView,
  pending: RegionDelta,
  dt: number,
  pivot: RegionPivot = 'center',
): { view: RegionView; pending: RegionDelta } {
  const remaining = Math.exp(-dt / DRAG_FOLLOW_SECONDS);
  const moved = (amount: number): number => amount * (1 - remaining);
  const panned = { ...view, lat: view.lat + moved(pending.lat), lon: view.lon + moved(pending.lon) };
  return {
    view: pivot === 'camera'
      ? lookRegionView(clampRegionView(panned), moved(pending.heading), moved(pending.tilt))
      : clampRegionView({
        ...panned,
        heading: view.heading + moved(pending.heading),
        tilt: view.tilt + moved(pending.tilt),
      }),
    pending: {
      lat: pending.lat * remaining,
      lon: pending.lon * remaining,
      heading: pending.heading * remaining,
      tilt: pending.tilt * remaining,
    },
  };
}

// 距離は比で近づけ、寄っても離れても同じ速さに見せる
export function approachDistance(distance: number, goal: number, dt: number): number {
  return distance * Math.pow(goal / distance, 1 - Math.exp(-dt / ZOOM_SECONDS));
}

// 大円に沿って angle (弧度) 進んだ地点と、そこでの進む向き (度)。まっすぐ進むと、方角は少しずつ変わる。
// angle が負なら後ろへ下がり、向きは前を向いたまま
// 着いた地点から元の地点への向きで進む向きを求めるので、ごく小さな角度では桁落ちで向きが定まらず、
// でたらめな方角になる (巡航の減速の最後に速さが 1e-17 ほど残ったときなど)。その程度 (1e-10 で地表の約 0.6mm) は動かない扱いにする
const MIN_TRAVEL = 1e-10;

function travel(lat: number, lon: number, bearing: number, angle: number): { lat: number; lon: number; bearing: number } {
  if (Math.abs(angle) < MIN_TRAVEL) return { lat, lon, bearing };
  const [p1, l1, b] = [lat * DEG, lon * DEG, bearing * DEG];
  const p2 = Math.asin(clamp(Math.sin(p1) * Math.cos(angle) + Math.cos(p1) * Math.sin(angle) * Math.cos(b), -1, 1));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(angle) * Math.cos(p1), Math.cos(angle) - Math.sin(p1) * Math.sin(p2));
  // 着いた地点から元の地点への向き。前へ進んだときは、その反対が進む向き
  const back = Math.atan2(
    Math.sin(l1 - l2) * Math.cos(p1),
    Math.cos(p2) * Math.sin(p1) - Math.sin(p2) * Math.cos(p1) * Math.cos(l1 - l2),
  );
  return { lat: p2 / DEG, lon: wrapDegrees(l2 / DEG), bearing: wrapDegrees(back / DEG + (angle > 0 ? 180 : 0)) };
}

// 巡航中のカメラは、中心の地点に繋がったアームの先ではなく、単体で飛ぶ。そのときの姿勢を
// カメラの真下の地点、地表からの高さ、機首の方角、見下ろす角度 (0 が真下、大きいほど水平に近い) で表す。
// 見下ろした先の地表が中心の地点なので、RegionView とは互いに変換でき、同じ姿勢を表す
export interface FlightView extends LonLat {
  heading: number;
  pitch: number;
  height: number;
}

// 真下の地点から中心の地点までの、地球の中心から見た角度 (弧度)
function reachOf(view: RegionView): number {
  const tilt = view.tilt * DEG;
  return Math.atan2(view.distance * Math.sin(tilt), 1 + view.distance * Math.cos(tilt));
}

export function flightOf(view: RegionView): FlightView {
  const tilt = view.tilt * DEG;
  const reach = reachOf(view);
  const below = travel(view.lat, view.lon, view.heading + 180, reach);
  return {
    lat: below.lat,
    lon: below.lon,
    heading: wrapDegrees(below.bearing + 180),
    // 地球の中心、カメラ、中心の地点の三角形の内角の和から、傾き = 見下ろす角度 + reach
    pitch: view.tilt - reach / DEG,
    height: Math.hypot(view.distance * Math.sin(tilt), 1 + view.distance * Math.cos(tilt)) - 1,
  };
}

// 見下ろした先が地表に当たらないとき (水平より上を見ているときなど) は null
export function regionOfFlight(flight: FlightView): RegionView | null {
  const radius = 1 + flight.height;
  const pitch = flight.pitch * DEG;
  const side = radius * Math.sin(pitch);
  if (flight.height <= 0 || pitch < 0 || side >= 1) return null;
  const distance = radius * Math.cos(pitch) - Math.sqrt(1 - side * side);
  const reach = Math.atan2(distance * Math.sin(pitch), radius - distance * Math.cos(pitch));
  const center = travel(flight.lat, flight.lon, flight.heading, reach);
  return { lat: center.lat, lon: center.lon, heading: center.bearing, tilt: flight.pitch + reach / DEG, distance };
}

function fitsRegion(view: RegionView | null): view is RegionView {
  return (
    !!view &&
    view.tilt >= 0 &&
    view.tilt <= MAX_TILT &&
    view.distance >= MIN_DISTANCE &&
    view.distance <= MAX_DISTANCE &&
    Math.abs(view.lat) <= MAX_LAT
  );
}

// カメラの姿勢を change(1) まで変える。中心の地点が範囲 (傾き、距離、緯度) を外れるときは、
// change(t) の t を縮めて届くところまでに留める。どこへも動けなければ元のまま
function reachFlight(view: RegionView, change: (t: number) => FlightView): RegionView {
  const full = regionOfFlight(change(1));
  if (fitsRegion(full)) return full;
  let [low, high, best] = [0, 1, view];
  for (let i = 0; i < 24; i++) {
    const mid = (low + high) / 2;
    const next = regionOfFlight(change(mid));
    if (fitsRegion(next)) [low, best] = [mid, next];
    else high = mid;
  }
  return best;
}

// カメラの位置を軸に、機首の方角を heading 度、見下ろす角度を pitch 度変える (巡航中のドラッグ)。
// カメラの位置と高さは変えず、中心の地点のほうが動く
export function lookRegionView(view: RegionView, heading: number, pitch: number): RegionView {
  const turned = heading === 0 ? view : reachFlight(view, (t) => {
    const flight = flightOf(view);
    return { ...flight, heading: flight.heading + heading * t };
  });
  if (pitch === 0) return turned;
  const flight = flightOf(turned);
  return reachFlight(turned, (t) => ({ ...flight, pitch: flight.pitch + pitch * t }));
}

// カメラの真下の地点、方角、見下ろす角度を変えずに、地表からの高さを変える (巡航中のホイール)
export function liftRegionView(view: RegionView, height: number): RegionView {
  const flight = flightOf(view);
  return reachFlight(view, (t) => ({ ...flight, height: flight.height + (height - flight.height) * t }));
}

// 巡航。turn 度だけカメラの真下の地点を軸に向きを変え、forward (弧度) だけ今の向きへまっすぐ進む。
// 中心の地点ではなくカメラの位置で向きを変えるので、航空機のようにその場で機首を振る。高さと傾きは変えない
export function cruiseRegionView(view: RegionView, forward: number, turn: number): RegionView {
  let { lat, lon, heading } = view;
  if (turn !== 0) {
    const reach = reachOf(view);
    const below = travel(lat, lon, heading + 180, reach);
    const ahead = travel(below.lat, below.lon, below.bearing + 180 + turn, reach);
    ({ lat, lon } = ahead);
    heading = ahead.bearing;
  }
  const moved = travel(lat, lon, heading, forward);
  return clampRegionView({ ...view, lat: moved.lat, lon: moved.lon, heading: moved.bearing });
}
