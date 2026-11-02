// 太陽から見た雲の濃さの画像 (影の焼き込み) の範囲と、焼き直す条件。
// 雲は 1 時間ごと、太陽もゆっくりしか変わらないので、毎フレームは焼かない
import { dot, type Vec3 } from './math.ts';

export interface ShadowBake {
  center: Vec3; // 画像の中心にする地表の点
  halfSize: number; // 中心から画像の端までの長さ (地球の半径が 1)
  sun: Vec3;
  cloudVersion: number;
}

const HALF_SIZE_PER_DISTANCE = 2; // 斜めに見ると奥が遠くまで見えるので、カメラの距離より広く取る
const MIN_HALF_SIZE = 0.15;
const MAX_HALF_SIZE = 1;
const MAX_MOVE = 0.15; // 中心がこの割合だけ動いたら焼き直す
const MAX_SIZE_RATIO = 1.25; // 寄ったら細かく、引いたら広く焼き直す
const MIN_SUN_DOT = 1 - 1e-5; // 太陽が約 0.25 度 (約 1 分) 動いたら焼き直す

const cross =(a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export function shadowHalfSize(distance: number): number {
  return Math.min(MAX_HALF_SIZE, Math.max(MIN_HALF_SIZE, distance * HALF_SIZE_PER_DISTANCE));
}

export function needsShadowBake(baked: ShadowBake | null, wanted: ShadowBake): boolean {
  if (!baked || baked.cloudVersion !== wanted.cloudVersion) return true;
  if (dot(baked.sun, wanted.sun) < MIN_SUN_DOT) return true;
  const ratio = wanted.halfSize / baked.halfSize;
  if (ratio > MAX_SIZE_RATIO || ratio < 1 / MAX_SIZE_RATIO) return true;
  const moved: Vec3 = [
    wanted.center[0] - baked.center[0],
    wanted.center[1] - baked.center[1],
    wanted.center[2] - baked.center[2],
  ];
  return Math.sqrt(dot(moved, moved)) > baked.halfSize * MAX_MOVE;
}

// 太陽の方向に垂直な面の、向きが直交する 2 つの単位ベクトル。sun は単位ベクトル
export function shadowBasis(sun: Vec3): { u: Vec3; v: Vec3 } {
  const up: Vec3 = Math.abs(sun[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const side = cross(up, sun);
  const length = Math.sqrt(dot(side, side));
  const u: Vec3 = [side[0] / length, side[1] / length, side[2] / length];
  return { u, v: cross(sun, u) };
}
