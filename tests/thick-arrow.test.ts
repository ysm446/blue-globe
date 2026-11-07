// 太さのある矢印の形の検証。実行: node --test tests/thick-arrow.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildThickArrow, defaultArrowWidthKm } from '../src/renderer/thick-arrow.ts';

const KM = 111.2;

test('点が足りないときや太さが 0 のときは作らない', () => {
  assert.equal(buildThickArrow([[0, 0]], 50), null);
  assert.equal(buildThickArrow([[0, 0], [5, 0]], 0), null);
  assert.equal(buildThickArrow([[0, 0], [0, 0]], 50), null);
});

test('まっすぐな矢印は、先端が終点に来て、長さが点の間の距離になる', () => {
  const arrow = buildThickArrow([[0, 0], [10, 0]], 50)!;
  assert.ok(Math.abs(arrow.lengthKm - 10 * KM) < 1);
  const tip = arrow.center[arrow.center.length - 1];
  assert.ok(Math.abs(tip.lon - 10) < 1e-6 && Math.abs(tip.lat) < 1e-6);
  assert.equal(tip.progress, 1);
  assert.equal(arrow.center[0].progress, 0);
});

test('帯は根元から先まで同じ太さで、矢じりは帯より幅が広い', () => {
  const arrow = buildThickArrow([[0, 0], [10, 0]], 50)!;
  const halfAt = (index: number): number => Math.abs(arrow.outline.left[index].lat - arrow.outline.right[index].lat) * KM / 2;
  const n = arrow.outline.left.length;
  const tail = halfAt(0);
  const shaftEnd = halfAt(n - 3); // 最後の 2 つは矢じりの角と先端
  const head = halfAt(n - 2);
  assert.ok(Math.abs(tail - shaftEnd) < 0.5, `根元 ${tail} と先 ${shaftEnd} の太さが違う`);
  assert.ok(Math.abs(shaftEnd - 25) < 0.5, `先の太さの半分: ${shaftEnd}`);
  assert.ok(head > shaftEnd * 1.8, `矢じり ${head} が帯 ${shaftEnd} より十分広くない`);
});

test('曲がった道筋でも、渡した途中の点を通る', () => {
  const arrow = buildThickArrow([[0, 0], [5, 5], [10, 0]], 40)!;
  const nearest = Math.min(...arrow.center.map((v) => Math.hypot(v.lon - 5, v.lat - 5)));
  assert.ok(nearest < 0.05, `途中の点から ${nearest} 度離れた`);
});

test('進み具合は根元から先へ増えていく', () => {
  const arrow = buildThickArrow([[0, 0], [3, 4], [8, 2], [12, 6]], 60)!;
  for (let i = 1; i < arrow.center.length; i++) assert.ok(arrow.center[i].progress >= arrow.center[i - 1].progress);
  for (const triangle of arrow.triangles) for (const v of triangle) assert.ok(v.progress >= 0 && v.progress <= 1);
});

test('短い矢印でも、矢じりは全体の半分より短い', () => {
  const arrow = buildThickArrow([[0, 0], [0.5, 0]], 100)!;
  const n = arrow.outline.left.length;
  assert.ok(arrow.outline.left[n - 2].progress >= 0.59);
});

test('指定のない太さは長さの 3.5% で、10〜150km に収める', () => {
  assert.ok(Math.abs(defaultArrowWidthKm([[0, 0], [10, 0]]) - 10 * KM * 0.035) < 1);
  assert.equal(defaultArrowWidthKm([[0, 0], [0.01, 0]]), 10);
  assert.equal(defaultArrowWidthKm([[0, 0], [100, 0]]), 150);
});

test('道筋が先端の近くで曲がっていても、矢じりは左右対称', () => {
  // 最後の区間で向きが大きく変わる道筋 (ハンニバルのカンナエへの行軍の終わりに近い形)
  const arrow = buildThickArrow([[9.6, 45.05], [12.07, 43.19], [14.2, 42.4], [15.2, 41.7], [16.13, 41.31]], 60)!;
  const n = arrow.outline.left.length;
  const tip = arrow.outline.left[n - 1];
  const left = arrow.outline.left[n - 2];
  const right = arrow.outline.right[n - 2];
  const k = Math.cos((tip.lat * Math.PI) / 180);
  const dist = (a: { lon: number; lat: number }, b: { lon: number; lat: number }): number => Math.hypot((a.lon - b.lon) * k, a.lat - b.lat);
  const ratio = dist(tip, left) / dist(tip, right);
  assert.ok(Math.abs(ratio - 1) < 0.02, `左右の辺の長さの比: ${ratio}`);
});
