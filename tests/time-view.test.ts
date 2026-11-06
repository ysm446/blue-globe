// 過去の時刻を見るスライダーの計算の検証。実行: node --test tests/time-view.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dayStart,
  MAX_DAYS_BACK,
  offsetLabel,
  sliderValueForDay,
  smoothTowards,
  TIME_RANGE_MINUTES,
  TIME_STEP_MINUTES,
  viewTimeAt,
  windowMax,
  windowStart,
} from '../src/renderer/time-view.ts';

test('0 分前は今を表す', () => {
  assert.equal(viewTimeAt(0), null);
});

test('何分前かから時刻を求める', () => {
  const now = Date.UTC(2026, 10, 2, 7, 0);
  assert.equal(viewTimeAt(90, now)?.toISOString(), '2026-11-02T05:30:00.000Z');
  assert.equal(viewTimeAt(TIME_RANGE_MINUTES, now)?.toISOString(), '2026-11-01T07:00:00.000Z');
});

test('表示は時間と分で出す', () => {
  assert.equal(offsetLabel(0), 'いま');
  assert.equal(offsetLabel(15), '15分前');
  assert.equal(offsetLabel(60), '1時間前');
  assert.equal(offsetLabel(195), '3時間15分前');
  assert.equal(offsetLabel(TIME_RANGE_MINUTES), '24時間前');
});

test('範囲は刻みの整数倍で、端までちょうど届く', () => {
  assert.equal(TIME_RANGE_MINUTES % TIME_STEP_MINUTES, 0);
});

// 60 fps で steps フレーム進めた値を順に返す
function follow(goalAt: (frame: number) => number, steps: number, start = 0): number[] {
  let state = { value: start, velocity: 0 };
  const values: number[] = [];
  for (let i = 0; i < steps; i++) {
    state = smoothTowards(state.value, goalAt(i), state.velocity, 0.35, 1 / 60);
    values.push(state.value);
  }
  return values;
}

test('選んだ時刻へは、ゆっくり動き出して行き過ぎずに着く', () => {
  const values = follow(() => TIME_RANGE_MINUTES, 180);
  assert.ok(values[5] < TIME_RANGE_MINUTES * 0.15); // 0.1 秒ではまだ動き始め
  assert.ok(values[59] > TIME_RANGE_MINUTES * 0.95); // 1 秒でほぼ着く
  assert.ok(values.every((value, i) => value <= TIME_RANGE_MINUTES && (i === 0 || value >= values[i - 1])));
  assert.ok(TIME_RANGE_MINUTES - values[129] < 0.25); // 2.2 秒で止めてよい近さ
});

test('ドラッグで目標が動き続けても、急に止まったり戻ったりしない', () => {
  // 1 秒かけて 0 から 600 分前まで動かし、そこで止める
  const values = follow((i) => Math.min(i, 60) * 10, 180);
  const steps = values.map((value, i) => value - (i === 0 ? 0 : values[i - 1]));
  assert.ok(steps.every((step) => step >= 0));
  assert.ok(values[179] <= 600 && 600 - values[179] < 0.25);
});

test('動いている途中で逆へ戻しても、目標を越えない', () => {
  const values = follow((i) => (i < 20 ? TIME_RANGE_MINUTES : 0), 240);
  assert.ok(values.every((value) => value >= 0));
  assert.ok(values[239] < 0.25);
});

test('日の 0 時は時計の時差で決める', () => {
  const now = Date.UTC(2026, 10, 7, 2, 0); // 東京では 11 時
  assert.equal(new Date(dayStart(0, now, 9 * 3600)).toISOString(), '2026-11-06T15:00:00.000Z');
  assert.equal(new Date(dayStart(3, now, 9 * 3600)).toISOString(), '2026-11-03T15:00:00.000Z');
  assert.equal(new Date(dayStart(1, now, -5 * 3600)).toISOString(), '2026-11-05T05:00:00.000Z'); // ニューヨークでは 6 日 21 時
});

test('今日は今から 24 時間前まで、過去の日はその日の 0 時から', () => {
  const now = Date.UTC(2026, 10, 7, 2, 0);
  assert.equal(windowStart(0, now, 9 * 3600), now - TIME_RANGE_MINUTES * 60_000);
  assert.equal(windowStart(2, now, 9 * 3600), dayStart(2, now, 9 * 3600));
  assert.equal(windowMax(0), TIME_RANGE_MINUTES);
  assert.equal(windowMax(1) % TIME_STEP_MINUTES, 0);
  assert.ok(windowMax(1) < TIME_RANGE_MINUTES); // 翌日の 0 時は含めない
});

test('日を選ぶと時と分を保つ', () => {
  const offset = 9 * 3600;
  const now = Date.UTC(2026, 10, 7, 2, 0); // 東京 7 日 11:00
  const view = Date.UTC(2026, 10, 6, 9, 10); // 東京 6 日 18:10
  assert.equal(sliderValueForDay(3, view, now, offset), 18 * 60 + 15); // 15 分刻みに丸める
  // 今日の 18 時はまだ来ていないので、今になる
  assert.equal(sliderValueForDay(0, view, now, offset), TIME_RANGE_MINUTES);
  // 今日の 8 時は 3 時間前
  assert.equal(sliderValueForDay(0, Date.UTC(2026, 10, 5, 23, 0), now, offset), TIME_RANGE_MINUTES - 180);
  // 過去の日の 23:55 は、翌日の 0 時にしない
  assert.equal(sliderValueForDay(1, Date.UTC(2026, 10, 4, 14, 55), now, offset), windowMax(1));
});

test('一番古い時刻も受け付ける範囲 (97 時間) に収まる', () => {
  const now = Date.UTC(2026, 10, 7, 14, 59); // 東京 23:59
  const oldest = windowStart(MAX_DAYS_BACK, now, 9 * 3600);
  assert.ok((now - oldest) / 3600_000 <= 97);
});
