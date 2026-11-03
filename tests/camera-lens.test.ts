// カメラのレンズの計算の検証。実行: node --test tests/camera-lens.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apparentScale, BASE_FOCAL_LENGTH, focalLengthForFov, verticalFov } from '../src/renderer/camera-lens.ts';
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
