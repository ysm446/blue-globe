// カメラのパネルに出す値の計算と書式。画面の計算から切り離して検証できるよう、DOM と Three.js に依存しない
import { clamp, DEG, dot, type Vec3 } from './math.ts';
import { lonLatOf } from './region-camera.ts';

export const EARTH_RADIUS_KM = 6371; // 地球の半径 1 にあたる長さ

const COMPASS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];

export interface ViewReadout {
  lat: number; // 画面の中心に写る地点
  lon: number;
  heading: number; // 画面の上が向いている方角。0 が北、90 が東 (0〜360)
  tilt: number; // 真下を見ているとき 0
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function normalize(a: Vec3): Vec3 {
  return scale(a, 1 / Math.hypot(...a));
}

// 2 点の真下の地点の、地表に沿った距離 (km)。近い 2 点でも精度が落ちないよう atan2 で角度を求める
export function groundDistanceKm(a: Vec3, b: Vec3): number {
  return Math.atan2(Math.hypot(...cross(a, b)), dot(a, b)) * EARTH_RADIUS_KM;
}

// forward は視線、up は画面の上方向 (どちらも単位ベクトル)。視線が地表に当たらなければ、カメラの真下で求める
export function viewReadout(position: Vec3, forward: Vec3, up: Vec3, radius: number): ViewReadout {
  const along = dot(position, forward);
  const gap = along * along - dot(position, position) + radius * radius;
  const t = gap >= 0 ? -along - Math.sqrt(gap) : -1;
  const normal = normalize(t > 0 ? add(position, scale(forward, t)) : position);
  const tilt = Math.acos(clamp(-dot(forward, normal), -1, 1)) / DEG;
  // 画面の上方向を、その地点の北と東の向きで測る。真下を見ていても、斜めに見ていても決まる
  const north = normalize(add([0, 1, 0], scale(normal, -normal[1])));
  const east = cross(north, normal);
  const heading = Math.atan2(dot(up, east), dot(up, north)) / DEG;
  const { lat, lon } = lonLatOf(normal);
  return { lat, lon, heading: (heading + 360) % 360, tilt };
}

const grouped = (value: number, digits: number): string =>
  value.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function formatAltitude(km: number): string {
  return `${grouped(km, km < 100 ? 1 : 0)} km`;
}

// 遅いときほど細かく出す
export function formatSpeed(kmPerSecond: number): string {
  return `${grouped(kmPerSecond, kmPerSecond < 10 ? 2 : kmPerSecond < 100 ? 1 : 0)} km/s`;
}

export function formatLatitude(lat: number): string {
  return `${lat < 0 ? '南緯' : '北緯'} ${Math.abs(lat).toFixed(2)}°`;
}

export function formatLongitude(lon: number): string {
  return `${lon < 0 ? '西経' : '東経'} ${Math.abs(lon).toFixed(2)}°`;
}

export function formatHeading(heading: number): string {
  const degrees = Math.round(heading) % 360;
  return `${degrees}°(${COMPASS[Math.round(degrees / 45) % 8]})`;
}

// exposure は画面の明るさの倍率。null は露出の処理を通さない表示 (風速モード)
export function formatExposure(exposure: number | null): string {
  if (exposure === null) return '—';
  const ev = Math.round(Math.log2(exposure) * 10) / 10;
  return `${ev > 0 ? '+' : ''}${ev === 0 ? '0.0' : ev.toFixed(1)} EV`;
}
