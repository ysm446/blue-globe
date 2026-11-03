// 地域ビューのカメラの計算。地表の 1 点を画面の中心に置き、そこを軸に斜めから見下ろす。
// 画面の計算から切り離して検証できるよう、Three.js に依存しない。座標は globe.ts の lonLatToVector3 と同じ
import { clamp, DEG, wrapDegrees, type LonLat, type Vec3 } from './math.ts';

export interface RegionView extends LonLat {
  heading: number; // 見ている方角。0 が北、90 が東
  tilt: number; // 0 が真下、大きいほど水平に近い
  distance: number; // 中心の地点からカメラまでの距離 (地球の半径が 1)
}

export interface RegionVelocity {
  lat: number;
  lon: number;
  heading: number;
  tilt: number;
}

export const REGION_TILT = 50;
export const REGION_DISTANCE = 0.24;
const MIN_DISTANCE = 0.1;
const MAX_DISTANCE = 1;
const MAX_TILT = 72;
const MAX_LAT = 80; // 極の近くでは経度の移動が大きくなりすぎる
const MAX_PAN_STEP = 10; // 地平線の近くをつかむと、1 回の移動で遠くまで飛ぶのを防ぐ
const INERTIA_SECONDS = 0.25;
const ZOOM_SECONDS = 0.1;

export const REGION_STILL: RegionVelocity = { lat: 0, lon: 0, heading: 0, tilt: 0 };

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

// つかんだ地点が指の下へ来るように中心を動かす。current は今の指の下の地点
export function panRegionView(view: RegionView, grabbed: LonLat, current: LonLat): RegionView {
  return clampRegionView({
    ...view,
    lat: view.lat + clamp(grabbed.lat - current.lat, -MAX_PAN_STEP, MAX_PAN_STEP),
    lon: view.lon + clamp(wrapDegrees(grabbed.lon - current.lon), -MAX_PAN_STEP, MAX_PAN_STEP),
  });
}

// 指を離したあとの慣性。FPS によらず同じ距離で止まるよう、減衰を時間で積分する
export function coastRegionView(
  view: RegionView,
  velocity: RegionVelocity,
  dt: number,
): { view: RegionView; velocity: RegionVelocity } {
  const remaining = Math.exp(-dt / INERTIA_SECONDS);
  const moved = (speed: number): number => speed * INERTIA_SECONDS * (1 - remaining);
  return {
    view: clampRegionView({
      ...view,
      lat: view.lat + moved(velocity.lat),
      lon: view.lon + moved(velocity.lon),
      heading: view.heading + moved(velocity.heading),
      tilt: view.tilt + moved(velocity.tilt),
    }),
    velocity: {
      lat: velocity.lat * remaining,
      lon: velocity.lon * remaining,
      heading: velocity.heading * remaining,
      tilt: velocity.tilt * remaining,
    },
  };
}

// 距離は比で近づけ、寄っても離れても同じ速さに見せる
export function approachDistance(distance: number, goal: number, dt: number): number {
  return distance * Math.pow(goal / distance, 1 - Math.exp(-dt / ZOOM_SECONDS));
}

// 大円に沿って angle (弧度) 進んだ地点と、そこでの進む向き (度)。まっすぐ進むと、方角は少しずつ変わる
function travel(lat: number, lon: number, bearing: number, angle: number): { lat: number; lon: number; bearing: number } {
  if (angle === 0) return { lat, lon, bearing };
  const [p1, l1, b] = [lat * DEG, lon * DEG, bearing * DEG];
  const p2 = Math.asin(clamp(Math.sin(p1) * Math.cos(angle) + Math.cos(p1) * Math.sin(angle) * Math.cos(b), -1, 1));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(angle) * Math.cos(p1), Math.cos(angle) - Math.sin(p1) * Math.sin(p2));
  // 着いた地点から元の地点への向きの反対
  const back = Math.atan2(
    Math.sin(l1 - l2) * Math.cos(p1),
    Math.cos(p2) * Math.sin(p1) - Math.sin(p2) * Math.cos(p1) * Math.cos(l1 - l2),
  );
  return { lat: p2 / DEG, lon: wrapDegrees(l2 / DEG), bearing: wrapDegrees(back / DEG + 180) };
}

// 巡航。turn 度だけカメラの真下の地点を軸に向きを変え、forward (弧度) だけ今の向きへまっすぐ進む。
// 中心の地点ではなくカメラの位置で向きを変えるので、航空機のようにその場で機首を振る。高さと傾きは変えない
export function cruiseRegionView(view: RegionView, forward: number, turn: number): RegionView {
  let { lat, lon, heading } = view;
  if (turn !== 0) {
    const tilt = view.tilt * DEG;
    // 真下の地点から中心の地点までの、地球の中心から見た角度
    const reach = Math.atan2(view.distance * Math.sin(tilt), 1 + view.distance * Math.cos(tilt));
    const below = travel(lat, lon, heading + 180, reach);
    const ahead = travel(below.lat, below.lon, below.bearing + 180 + turn, reach);
    ({ lat, lon } = ahead);
    heading = ahead.bearing;
  }
  const moved = travel(lat, lon, heading, forward);
  return clampRegionView({ ...view, lat: moved.lat, lon: moved.lon, heading: moved.bearing });
}
