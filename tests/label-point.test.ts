// 範囲の名前を置く点の検証。実行: node --test tests/label-point.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { labelPoint } from '../src/renderer/label-point.ts';

const square = (lon: number, lat: number, size: number): number[] => [
  lon, lat, lon + size, lat, lon + size, lat + size, lon, lat + size,
];

test('四角の範囲では中心に置く', () => {
  const point = labelPoint([[square(10, 0, 4)]]);
  assert.ok(Math.abs(point.lon - 12) < 0.1);
  assert.ok(Math.abs(point.lat - 2) < 0.1);
});

test('L 字に曲がった範囲では、重心ではなく範囲の内側に置く', () => {
  // 縦棒 (0〜1, 0〜10) と横棒 (0〜10, 0〜1)。重心 (約 2.6, 2.6) は範囲の外
  const shape = [0, 0, 10, 0, 10, 1, 1, 1, 1, 10, 0, 10];
  const point = labelPoint([[shape]]);
  const inVertical = point.lon >= 0 && point.lon <= 1 && point.lat >= 0 && point.lat <= 10;
  const inHorizontal = point.lon >= 0 && point.lon <= 10 && point.lat >= 0 && point.lat <= 1;
  assert.ok(inVertical || inHorizontal, `外に出た: ${point.lon}, ${point.lat}`);
});

test('いくつかの多角形があるときは、一番大きいものに置く', () => {
  const point = labelPoint([[square(0, 0, 1)], [square(50, 10, 6)]]);
  assert.ok(Math.abs(point.lon - 53) < 0.2);
  assert.ok(Math.abs(point.lat - 13) < 0.2);
});

test('日付変更線をまたぐ範囲でも、経度を -180〜180 に収めてその内側に置く', () => {
  const point = labelPoint([[[178, 60, -178, 60, -178, 64, 178, 64]]]);
  assert.ok(Math.abs(Math.abs(point.lon) - 180) < 0.2, `経度: ${point.lon}`);
  assert.ok(Math.abs(point.lat - 62) < 0.2);
});

test('穴の中には置かない', () => {
  const outer = square(0, 0, 10);
  const hole = square(3, 3, 4);
  const point = labelPoint([[outer, hole]]);
  const inHole = point.lon > 3 && point.lon < 7 && point.lat > 3 && point.lat < 7;
  assert.ok(!inHole, `穴の中: ${point.lon}, ${point.lat}`);
});
