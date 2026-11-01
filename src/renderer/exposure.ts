// カメラの露出の自動調整。太陽が画面に入ると絞り、夜側を見ているときは少し開ける。
// 計算は画面の明るさの実測ではなく、太陽と地球の位置関係から求める
export type Vec3 = readonly [number, number, number];

const SUN_EXPOSURE = 0.3; // 太陽を正面に見たときの倍率
const NIGHT_EXPOSURE = 1.25;
const DAY_EXPOSURE = 0.85;
const CLOSE_SECONDS = 0.35; // 明るいものを見たら素早く絞る
const OPEN_SECONDS = 1.4; // 暗さに慣れるのはゆっくり

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// 地球に隠れていない割合 (0〜1)。direction はカメラから太陽への単位ベクトル。
// 地球の縁から顔を出す間は滑らかに変わる
export function earthClearance(camera: Vec3, direction: Vec3, radius: number): number {
  const along = dot(camera, direction);
  if (along >= 0) return 1; // 地球を背にして太陽を見ている
  const closest = Math.sqrt(Math.max(0, dot(camera, camera) - along * along));
  return smoothstep(radius * 0.99, radius * 1.05, closest);
}

// 画面に入っている割合 (0〜1)。少し外にあっても光は届くので、画面の外まで滑らかに減らす
export function screenPresence(ndcX: number, ndcY: number, inFront: boolean): number {
  if (!inFront) return 0;
  return 1 - smoothstep(1, 1.4, Math.max(Math.abs(ndcX), Math.abs(ndcY)));
}

// facing はカメラ方向と太陽方向の内積 (1 で昼側の正面、-1 で夜側の正面)
export function targetExposure(facing: number, sunVisibility: number): number {
  const base = NIGHT_EXPOSURE + (DAY_EXPOSURE - NIGHT_EXPOSURE) * smoothstep(-0.4, 0.8, facing);
  return base * (1 + (SUN_EXPOSURE - 1) * sunVisibility);
}

export function adaptExposure(current: number, target: number, dt: number): number {
  const seconds = target < current ? CLOSE_SECONDS : OPEN_SECONDS;
  return current + (target - current) * (1 - Math.exp(-dt / seconds));
}
