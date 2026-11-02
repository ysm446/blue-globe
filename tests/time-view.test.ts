// 過去の時刻を見るスライダーの計算の検証。実行: node --test tests/time-view.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offsetLabel, TIME_RANGE_MINUTES, TIME_STEP_MINUTES, viewTimeAt } from '../src/renderer/time-view.ts';

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
