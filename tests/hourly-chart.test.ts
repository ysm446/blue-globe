// 24 時間の気温の折れ線の検証。実行: node --test tests/hourly-chart.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linePath, linePoints, revealDelayMs, revealTotalMs } from '../src/renderer/hourly-chart.ts';

const WIDTH = 320;
const HEIGHT = 40;

test('列は左から順に現れ、最後の列が現れ終わると全体が終わる', () => {
  assert.equal(revealDelayMs(0), 0);
  assert.ok(revealDelayMs(1) > 0);
  assert.ok(revealDelayMs(7) > revealDelayMs(6));
  assert.ok(revealTotalMs(8) > revealDelayMs(7));
  assert.ok(revealTotalMs(8) < 1500, '待たされると感じない長さにする');
});

test('点は各列の中央に並ぶ', () => {
  const points = linePoints([10, 12, 14, 16], WIDTH, HEIGHT);
  assert.deepEqual(points.map((p) => p.x), [40, 120, 200, 280]);
});

test('気温が高いほど上に描く', () => {
  const [cold, warm] = linePoints([10, 20], WIDTH, HEIGHT);
  assert.ok(warm.y < cold.y);
});

test('変化が大きいときは縦の範囲を使い切り、はみ出さない', () => {
  const ys = linePoints([-12, 38, 5], WIDTH, HEIGHT).map((p) => p.y);
  assert.equal(Math.min(...ys), 6);
  assert.equal(Math.max(...ys), HEIGHT - 6);
});

test('1 度の差を大きな山に見せない', () => {
  const [a, b] = linePoints([12, 13], WIDTH, HEIGHT);
  assert.ok(Math.abs(a.y - b.y) < 4); // 使える高さ 28 の 8 分の 1 = 3.5
});

test('差の大きさは縦の幅が同じなら比例する', () => {
  const small = linePoints([10, 12], WIDTH, HEIGHT);
  const large = linePoints([10, 14], WIDTH, HEIGHT);
  const gap = (p: typeof small) => Math.abs(p[0].y - p[1].y);
  assert.ok(Math.abs(gap(large) - gap(small) * 2) < 1e-9);
});

test('すべて同じ気温なら縦の中央に水平に並ぶ', () => {
  const ys = linePoints([15, 15, 15], WIDTH, HEIGHT).map((p) => p.y);
  assert.deepEqual(ys, [20, 20, 20]);
});

test('点の数と線の区間の数が合う', () => {
  const path = linePath(linePoints([1, 2, 3, 4], WIDTH, HEIGHT));
  assert.equal(path.match(/M/g)?.length, 1);
  assert.equal(path.match(/C/g)?.length, 3);
});

test('点の前後で傾きが同じで、折れ目がない', () => {
  const points = linePoints([14, 13, 16, 22, 23, 15, 14, 14], WIDTH, HEIGHT);
  const numbers = linePath(points).match(/-?[\d.]+(?:e-?\d+)?/g)!.map(Number);
  // M の 1 点のあと、区間ごとに制御点 2 つと終点が続く
  for (let segment = 0; segment < points.length - 2; segment++) {
    const at = 2 + segment * 6;
    const [inX, inY, endX, endY, outX, outY] = numbers.slice(at + 2, at + 8);
    const incoming = (endY - inY) / (endX - inX);
    const outgoing = (outY - endY) / (outX - endX);
    assert.ok(Math.abs(incoming - outgoing) < 1e-9, `点 ${segment + 1}: ${incoming} != ${outgoing}`);
  }
});

test('山と谷の頂点では水平になる', () => {
  const points = linePoints([10, 20, 10], WIDTH, HEIGHT);
  const numbers = linePath(points).match(/-?[\d.]+/g)!.map(Number);
  assert.equal(numbers[5], points[1].y); // 頂点へ入る制御点の y
  assert.equal(numbers[9], points[1].y); // 頂点から出る制御点の y
});

test('同じ気温が続く区間は水平のまま', () => {
  const points = linePoints([14, 14, 14, 20], WIDTH, HEIGHT);
  const numbers = linePath(points).match(/-?[\d.]+/g)!.map(Number);
  assert.equal(numbers[3], points[0].y);
  assert.equal(numbers[5], points[1].y);
});

test('点が 1 つでも線を作れる', () => {
  const points = linePoints([14], WIDTH, HEIGHT);
  assert.equal(linePath(points), `M${points[0].x} ${points[0].y}`);
});

test('線は前後の点の値を超えない', () => {
  const points = linePoints([10, 30, 5], WIDTH, HEIGHT);
  const numbers = linePath(points).match(/-?[\d.]+/g)!.map(Number);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  const all = points.map((p) => p.y);
  assert.ok(Math.min(...ys) >= Math.min(...all));
  assert.ok(Math.max(...ys) <= Math.max(...all));
});
