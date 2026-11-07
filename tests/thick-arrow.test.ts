// 太さのある矢印の形の検証。実行: node --test tests/thick-arrow.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrowDashCount, arrowFadeShare, buildSplitArrow, buildThickArrow, defaultArrowWidthKm, splitAtSharpTurns } from '../src/renderer/thick-arrow.ts';

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

test('点の間は直線で結び、角だけを丸める', () => {
  // 長い 2 本の線分。角から離れた所は、点を結ぶ直線の上にある
  const arrow = buildThickArrow([[0, 0], [10, 0], [10, 10]], 20)!;
  const onFirst = arrow.center.filter((v) => v.lon > 1 && v.lon < 8);
  assert.ok(onFirst.length > 0);
  for (const v of onFirst) assert.ok(Math.abs(v.lat) < 1e-9, `直線から外れた: ${v.lat}`);
  // 角は丸めるので、角の点そのものは通らないが、近くを通る
  const nearest = Math.min(...arrow.center.map((v) => Math.hypot(v.lon - 10, v.lat)));
  assert.ok(nearest > 0.01 && nearest < 0.5, `角からの距離: ${nearest}`);
});

test('行って戻る道でも、折り返しの外へはみ出さない', () => {
  // 東へ 10 度進み、ほぼ同じ道を戻る。折り返しの点 (経度 10) より東へ出ない
  const arrow = buildThickArrow([[0, 0], [10, 0], [0, 0.5]], 30)!;
  const east = Math.max(...arrow.center.map((v) => v.lon));
  assert.ok(east <= 10 + 1e-9, `折り返しの外へ出た: ${east}`);
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

test('根元を消す区間は帯の太さの 4 倍で、全体の 30% まで', () => {
  assert.ok(Math.abs(arrowFadeShare(30, 1000) - 0.12) < 1e-9);
  assert.equal(arrowFadeShare(30, 200), 0.3);
  assert.equal(arrowFadeShare(30, 0), 0);
});

test('来た道を戻る所では矢印を分け、ゆるい角では分けない', () => {
  assert.equal(splitAtSharpTurns([[0, 0], [10, 0], [0, 1]]).length, 2);
  assert.equal(splitAtSharpTurns([[0, 0], [10, 0], [10, 10]]).length, 1); // 90°
  assert.equal(splitAtSharpTurns([[0, 0], [10, 0], [5, 5]]).length, 1); // 135°
  assert.equal(splitAtSharpTurns([[0, 0], [10, 0], [20, 0]]).length, 1);
  const pieces = splitAtSharpTurns([[0, 0], [10, 0], [0, 1], [10, 2]]);
  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces[1][0], [10, 0]); // 分けた点は次の並びの始まりにもなる
});

test('分けた矢印は、1 本目が伸びきってから 2 本目が伸びる', () => {
  const split = buildSplitArrow([[0, 0], [10, 0], [0, 1]], 40)!;
  assert.equal(split.pieces.length, 2);
  const [first, second] = split.pieces;
  const firstEnd = Math.max(...first.center.map((v) => v.progress));
  const secondStart = Math.min(...second.center.map((v) => v.progress));
  assert.ok(Math.abs(firstEnd - secondStart) < 1e-9, `${firstEnd} と ${secondStart}`);
  assert.ok(Math.abs(Math.max(...second.center.map((v) => v.progress)) - 1) < 1e-9);
  // 2 本目の根元は、折り返しの点から少し離れている
  const tail = second.center[0];
  assert.ok(tail.lon < 10 - 0.05, `根元の経度: ${tail.lon}`);
});

test('横へずらすときは、根元と先端だけずらし、途中は渡した道筋を通る', () => {
  // 東へ進む矢印。右は南
  const arrow = buildThickArrow([[0, 0], [10, 0]], 20, { offsetKm: 30 })!;
  const tail = arrow.center[0];
  assert.ok(Math.abs(tail.lat * KM + 30) < 1, `根元の緯度: ${tail.lat * KM} km`);
  const middle = arrow.center.find((v) => v.lon > 4.9 && v.lon < 5.1)!;
  assert.ok(Math.abs(middle.lat) < 1e-6, `途中の緯度: ${middle.lat}`);
  const tip = arrow.center[arrow.center.length - 1];
  assert.ok(Math.abs(tip.lat * KM + 30) < 1, `先端の緯度: ${tip.lat * KM} km`);
  // 負の値は左 (北)
  const left = buildThickArrow([[0, 0], [10, 0]], 20, { offsetKm: -30 })!;
  assert.ok(left.center[0].lat > 0);
});

test('矢じりの頂点には印が付き、破線の区切りは帯の太さに比例する', () => {
  const arrow = buildThickArrow([[0, 0], [10, 0]], 20)!;
  const headCount = arrow.triangles.flat().filter((v) => v.head === 1).length;
  assert.equal(headCount, 6);
  assert.ok(Math.abs(arrowDashCount(20, 600) - 10) < 1e-9);
  assert.equal(arrowDashCount(20, 10), 1);
});

test('どの頂点も、自分の矢印の矢じりの根元の進み具合を持つ', () => {
  const split = buildSplitArrow([[0, 0], [10, 0], [0, 1]], 40)!;
  for (const piece of split.pieces) {
    const n = piece.outline.left.length;
    const headBase = piece.outline.left[n - 2].progress; // 矢じりの角
    for (const v of piece.triangles.flat()) assert.ok(Math.abs(v.headAt - headBase) < 1e-9);
  }
  assert.ok(split.pieces[0].outline.left[0].headAt < split.pieces[1].outline.left[0].headAt);
});
