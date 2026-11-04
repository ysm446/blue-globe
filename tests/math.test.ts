// 計算の共通部品の検証。実行: node --test tests/math.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearingDegrees, clamp, dot, easeInOut, separationDegrees, smoothstep, wrapDegrees } from '../src/renderer/math.ts';

test('角度は -180 以上 180 未満へ折り返す', () => {
  assert.equal(wrapDegrees(0), 0);
  assert.equal(wrapDegrees(180), -180);
  assert.equal(wrapDegrees(-180), -180);
  assert.equal(wrapDegrees(190), -170);
  assert.equal(wrapDegrees(-190), 170);
  assert.equal(wrapDegrees(725), 5);
});

test('clamp は範囲に収める', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

test('smoothstep は端で止まり、中央で半分になる', () => {
  assert.equal(smoothstep(1, 3, 0), 0);
  assert.equal(smoothstep(1, 3, 4), 1);
  assert.equal(smoothstep(1, 3, 2), 0.5);
  assert.equal(easeInOut(0.5), 0.5);
});

test('内積', () => {
  assert.equal(dot([1, 2, 3], [4, 5, 6]), 32);
});

test('球面上の角度は経度の折り返しをまたいでも正しい', () => {
  assert.ok(Math.abs(separationDegrees({ lat: 0, lon: 179 }, { lat: 0, lon: -179 }) - 2) < 1e-9);
  assert.ok(Math.abs(separationDegrees({ lat: 90, lon: 0 }, { lat: -90, lon: 77 }) - 180) < 1e-6);
  assert.ok(separationDegrees({ lat: 35, lon: 139 }, { lat: 35, lon: 139 }) < 1e-5); // acos は 1 の近くで丸め誤差が出る
});

test('方角は北が 0、東が 90 で、0 以上 360 未満', () => {
  const origin = { lat: 0, lon: 0 };
  assert.ok(Math.abs(bearingDegrees(origin, { lat: 10, lon: 0 })) < 1e-9);
  assert.ok(Math.abs(bearingDegrees(origin, { lat: 0, lon: 10 }) - 90) < 1e-9);
  assert.ok(Math.abs(bearingDegrees(origin, { lat: -10, lon: 0 }) - 180) < 1e-9);
  assert.ok(Math.abs(bearingDegrees(origin, { lat: 0, lon: -10 }) - 270) < 1e-9);
});

test('大円の最初の向きは、行きと帰りで対称にならない', () => {
  // ニューヨークとロンドンのよく知られた値 (行き約 51.2°、帰り約 288.3°)
  const newYork = { lat: 40.7128, lon: -74.006 };
  const london = { lat: 51.5074, lon: -0.1278 };
  assert.ok(Math.abs(bearingDegrees(newYork, london) - 51.2) < 0.1);
  assert.ok(Math.abs(bearingDegrees(london, newYork) - 288.3) < 0.1);
});
