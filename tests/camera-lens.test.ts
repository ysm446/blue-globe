// カメラのレンズの計算の検証。実行: node --test tests/camera-lens.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apertureExposure,
  apparentScale,
  BASE_FOCAL_LENGTH,
  circleOfConfusion,
  focalLengthForFov,
  sensorHeight,
  sphereRayDistance,
  verticalFov,
} from '../src/renderer/camera-lens.ts';
import { DEG } from '../src/renderer/math.ts';

const near = (actual: number, expected: number, tolerance = 0.05): void => {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} と ${expected}`);
};

test('3:2 の窓ではフルサイズのレンズと同じ画角になる', () => {
  near(verticalFov(50, 3 / 2), 27);
  near(verticalFov(35, 3 / 2), 37.8);
  near(verticalFov(24, 3 / 2), 53.1);
});

test('横長の窓は横の画角をフルサイズに揃える', () => {
  for (const aspect of [16 / 9, 16 / 10, 21 / 9]) {
    const horizontal = 2 * Math.atan(Math.tan((verticalFov(35, aspect) / 2) * DEG) * aspect);
    near(horizontal / DEG, 54.4);
  }
});

test('3:2 より縦長の窓は縦の画角を揃える', () => {
  assert.equal(verticalFov(35, 4 / 3), verticalFov(35, 3 / 2));
  assert.equal(verticalFov(35, 1), verticalFov(35, 3 / 2));
});

test('画角から焦点距離へ戻せる', () => {
  for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
    for (const focal of [14, 24, 35.5, 70]) near(focalLengthForFov(verticalFov(focal, aspect), aspect), focal, 1e-9);
  }
});

test('既定のレンズは 16:9 の窓で今までの画角とほぼ同じになる', () => {
  near(verticalFov(BASE_FOCAL_LENGTH, 16 / 9), 45, 1);
});

test('写る大きさの倍率は既定のレンズで 1、望遠で小さく、広角で大きい', () => {
  near(apparentScale(verticalFov(BASE_FOCAL_LENGTH, 16 / 9)), 1, 1e-9);
  assert.ok(apparentScale(verticalFov(70, 16 / 9)) < 1);
  assert.ok(apparentScale(verticalFov(14, 16 / 9)) > 1);
  // 焦点距離が 2 倍なら、写る範囲は半分
  near(apparentScale(verticalFov(BASE_FOCAL_LENGTH * 2, 16 / 9)), 0.5, 1e-9);
});

test('視線が球に当たる距離と、当たらないときは縁までの距離', () => {
  near(sphereRayDistance([0, 0, 3], [0, 0, -1], 1), 2, 1e-9);
  // 縁をかすめる視線と、外れる視線は、どちらも接点までの距離 (√(3² - 1))
  const tangent = Math.sqrt(8);
  near(sphereRayDistance([0, 0, 3], [1 / 3, 0, -tangent / 3], 1), tangent, 1e-6);
  near(sphereRayDistance([0, 0, 3], [0, 1, 0], 1), tangent, 1e-9);
  // 球を背にしたとき
  near(sphereRayDistance([0, 0, 3], [0, 0, 1], 1), tangent, 1e-9);
});

test('錯乱円はピント面で 0、奥は正、手前は負', () => {
  assert.equal(circleOfConfusion(24, 4, 0.5, 0.5), 0);
  assert.ok(circleOfConfusion(24, 4, 0.5, 1) > 0);
  assert.ok(circleOfConfusion(24, 4, 0.5, 0.3) < 0);
  // 無限遠では f² / (N (D - f))
  near(circleOfConfusion(50, 2, 2, 1e9), (0.05 * 0.05) / (2 * (2 - 0.05)) * 1000, 1e-6);
  // F 値を 2 倍にすると半分
  near(circleOfConfusion(24, 8, 0.5, 1), circleOfConfusion(24, 4, 0.5, 1) / 2, 1e-12);
});

test('ピント面がレンズより手前でも発散しない', () => {
  assert.ok(Number.isFinite(circleOfConfusion(24, 4, 0.01, 1)));
  assert.ok(Number.isFinite(circleOfConfusion(24, 4, 0.5, 0)));
});

// 地球を直径 1m の地球儀に見立て、24mm F4 で撮る (既定の設定)。1080 画素の高さでの半径
const blurPixels = (focus: number, distance: number): number => {
  const scale = 0.5; // 地球の半径が 1 → 0.5m
  const coc = circleOfConfusion(24, 4, focus * scale, distance * scale);
  return (Math.abs(coc) / sensorHeight(16 / 9) / 2) * 1080;
};

test('地球ビューの縁はほとんどぼけない', () => {
  // 地球の中心から 3.3 のカメラで、真下の地表 (2.3) にピント、縁 (√(3.3² - 1)) まで
  assert.ok(blurPixels(2.3, Math.sqrt(3.3 ** 2 - 1)) < 2);
});

test('地域ビューの地平線の近くははっきりぼける', () => {
  // 中心の地点まで 0.24 にピント、その 2.5 倍の奥
  assert.ok(blurPixels(0.24, 0.6) > 15);
});

test('絞りの明るさは F4 で 1、1 段ごとに半分', () => {
  assert.equal(apertureExposure(4), 1);
  assert.ok(Math.abs(apertureExposure(5.6) - 0.5) < 0.02); // 5.6 は √2 × 4 を丸めた刻印
  assert.equal(apertureExposure(8), 0.25);
  assert.equal(apertureExposure(2), 4);
});
