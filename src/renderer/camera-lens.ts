// カメラのレンズの計算。焦点距離はフルサイズ (36×24mm) 換算で扱う。画面の計算から切り離して検証できるよう、DOM に依存しない
import { DEG, dot, type Vec3 } from './math.ts';

const SENSOR_WIDTH = 36;
const SENSOR_HEIGHT = 24;

export const BASE_FOCAL_LENGTH = 24; // 既定の焦点距離 (server/config.py と合わせる)

// 窓に写るセンサーの高さ (mm)。3:2 より横長の窓はセンサーの上下を、縦長の窓は左右を切り取ったものとして扱う
export function sensorHeight(aspect: number): number {
  return Math.min(SENSOR_HEIGHT, SENSOR_WIDTH / aspect);
}

// 縦の画角 (度)
export function verticalFov(focalLength: number, aspect: number): number {
  return (2 * Math.atan(sensorHeight(aspect) / (2 * focalLength))) / DEG;
}

// 縦の画角から焦点距離を求める。verticalFov の逆
export function focalLengthForFov(fov: number, aspect: number): number {
  return sensorHeight(aspect) / (2 * Math.tan((fov / 2) * DEG));
}

const BASE_FOV = verticalFov(BASE_FOCAL_LENGTH, 16 / 9);

// 既定のレンズと比べて、地表がどれだけ小さく写るか。望遠ほど小さな値になる
export function apparentScale(fov: number): number {
  return Math.tan((fov / 2) * DEG) / Math.tan((BASE_FOV / 2) * DEG);
}

// 被写界深度の計算。地球を地球儀の大きさの模型に見立て、その模型をこのレンズで撮ったときのぼけを求める。
// 実寸の地球はどこもほぼ無限遠になり、まったくぼけないため。GLSL 側 (depth-of-field.ts) と同じ式

// 視線が半径 radius の球 (中心は原点) に当たるまでの距離。direction は長さ 1。
// 当たらないときは球の縁 (接点) までの距離を返す。宇宙の背景は、縁と同じ奥行きにあるものとしてぼかす
export function sphereRayDistance(origin: Vec3, direction: Vec3, radius: number): number {
  const b = dot(origin, direction);
  const c = dot(origin, origin) - radius * radius;
  const discriminant = b * b - c;
  if (b < 0 && discriminant >= 0) return -b - Math.sqrt(discriminant);
  return Math.sqrt(Math.max(c, 0));
}

// 錯乱円の直径 (mm、センサーの上)。正は奥、負は手前のぼけ。焦点距離は mm、focus と distance は m
export function circleOfConfusion(focalLength: number, fNumber: number, focus: number, distance: number): number {
  const f = focalLength / 1000;
  // ピント面や物体がレンズより手前に来ると式が発散するので、少し奥に置く
  const near = f + 0.001;
  const [plane, subject] = [Math.max(focus, near), Math.max(distance, near)];
  return (((f / fNumber) * f * (subject - plane)) / (subject * (plane - f))) * 1000;
}
