// カメラのレンズの計算。焦点距離はフルサイズ (36×24mm) 換算で扱う。画面の計算から切り離して検証できるよう、DOM に依存しない
import { DEG } from './math.ts';

const SENSOR_WIDTH = 36;
const SENSOR_HEIGHT = 24;

export const BASE_FOCAL_LENGTH = 24; // 既定の焦点距離 (server/config.py と合わせる)

// 窓に写るセンサーの高さ (mm)。3:2 より横長の窓はセンサーの上下を、縦長の窓は左右を切り取ったものとして扱う
function sensorHeight(aspect: number): number {
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
