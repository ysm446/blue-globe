// 地球ビューと太陽系の間を行き来するカメラの動き。画面の計算から切り離して検証できるよう、DOM と Three.js に依存しない。
// 座標は太陽系の場面の座標 (AU。星のデータと同じ J2000 の赤道座標を、three.js の向きに並べ替えたもの)
import { EARTH_RADIUS_KM } from './camera-readout.ts';
import { clamp, DEG, dot, smoothstep, type Vec3 } from './math.ts';

export const AU_KM = 149_597_870.7;
export const AU_IN_EARTH_RADII = AU_KM / EARTH_RADIUS_KM;

const OBLIQUITY = 23.43928 * DEG;
// 黄道の北。太陽系を見るときはこれを画面の上にし、軌道の面を水平に見せる
export const ECLIPTIC_NORTH: Vec3 = [0, Math.cos(OBLIQUITY), Math.sin(OBLIQUITY)];

// 中心を太陽へ移し終える距離 (AU)。近いうちに移すと地球が画面の外へ飛ぶので、引くのに合わせて少しずつ移す
const SUN_TARGET_DISTANCE = 4;

// J2000 の赤道座標を、three.js の向き (Y が天の北極) に並べ替える。globe.ts の lonLatToVector3 と同じ向き
export function equatorialToScene([x, y, z]: Vec3): Vec3 {
  return [x, z, -y];
}

export interface SolarPose {
  sunWeight: number; // 見る中心。0 が地球、1 が太陽
  distance: number; // 中心からカメラまで (AU)
  direction: Vec3; // 中心からカメラへの向き (単位ベクトル)
  up: Vec3; // 画面の上の向き
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(scale(a, 1 - t), scale(b, t));
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));

// 単位ベクトルの球面に沿った補間
function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const cos = clamp(dot(a, b), -1, 1);
  const angle = Math.acos(cos);
  if (angle < 1e-6) return a;
  if (Math.PI - angle < 1e-3) {
    // 真逆のときは、どちらにも直交する向きを経由する
    const side: Vec3 = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const middle = unit(add(side, scale(a, -dot(side, a))));
    return t < 0.5 ? slerp(a, middle, t * 2) : slerp(middle, b, t * 2 - 1);
  }
  const s = Math.sin(angle);
  return add(scale(a, Math.sin((1 - t) * angle) / s), scale(b, Math.sin(t * angle) / s));
}

const targetWeight = (distance: number): number => smoothstep(0, SUN_TARGET_DISTANCE, distance);

// t は 0〜1 (なめらかにしたあとの値)。距離は比で補間し、何桁も違う距離を同じ速さで引く
export function solarFlightPose(
  from: SolarPose,
  to: SolarPose,
  t: number,
  earth: Vec3,
  sun: Vec3,
): { position: Vec3; target: Vec3; up: Vec3 } {
  const distance = Math.exp(Math.log(from.distance) + (Math.log(to.distance) - Math.log(from.distance)) * t);
  // 中心は距離に合わせて地球から太陽へ移す。始めと終わりの中心がこれと違う分は、少しずつなくす
  const weight = clamp(
    targetWeight(distance) +
      (from.sunWeight - targetWeight(from.distance)) * (1 - t) +
      (to.sunWeight - targetWeight(to.distance)) * t,
    0,
    1,
  );
  const target = lerp(earth, sun, weight);
  const direction = slerp(from.direction, to.direction, t);
  return { position: add(target, scale(direction, distance)), target, up: slerp(from.up, to.up, t) };
}

// 太陽系を見下ろす姿勢。地球の外側の、黄道から elevation 度上から太陽を見る
export function overviewPose(earth: Vec3, distance: number, elevation: number): SolarPose {
  const north = ECLIPTIC_NORTH;
  const outward = unit(add(earth, scale(north, -dot(earth, north))));
  const e = elevation * DEG;
  return {
    sunWeight: 1,
    distance,
    direction: unit(add(scale(outward, Math.cos(e)), scale(north, Math.sin(e)))),
    up: north,
  };
}
