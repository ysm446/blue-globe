// 星座の線の伸ばし方の検証。実行: node --test tests/constellation-reveal.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { revealSchedule } from '../src/renderer/constellation-reveal.ts';
import { DEG, type Vec3 } from '../src/renderer/math.ts';

// 赤道の上の経度 lon 度の点
const onEquator = (lon: number): Vec3 => [Math.cos(lon * DEG), 0, Math.sin(lon * DEG)];

const near = (actual: number, expected: number, tolerance = 1e-9): void => {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} と ${expected}`);
};

test('1 つの星座の中では、線分が前の線分の伸びきったときに伸び始める', () => {
  const schedule = revealSchedule([[[onEquator(0), onEquator(10), onEquator(30)], [onEquator(40), onEquator(45)]]], onEquator(0));
  assert.equal(schedule.length, 3);
  near(schedule[0].start, 0);
  for (let i = 1; i < schedule.length; i++) near(schedule[i].start, schedule[i - 1].start + schedule[i - 1].duration);
});

test('伸びきるまでの時間は線分の角度に比例する', () => {
  const [short, long] = revealSchedule([[[onEquator(0), onEquator(10), onEquator(30)]]], onEquator(0));
  near(long.duration, short.duration * 2);
  near(short.duration, 10 / 40); // 毎秒 40°
});

test('見ている方向に近い星座から順に描き始める', () => {
  const far: Vec3[][] = [[onEquator(90), onEquator(95)]];
  const middle: Vec3[][] = [[onEquator(40), onEquator(45)]];
  const nearest: Vec3[][] = [[onEquator(0), onEquator(5)]];
  const [a, b, c] = revealSchedule([far, middle, nearest], onEquator(0));
  near(c.start, 0);
  assert.ok(b.start > c.start);
  assert.ok(a.start > b.start);
});
