// ツアーの時刻の計算の検証。実行: node --test tests/tour.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localHourToDate } from '../src/renderer/tour-time.ts';

const NOW = new Date('2026-11-06T13:00:00Z');

test('経度 0 度では地方時と UTC が同じ', () => {
  assert.equal(localHourToDate(12, 0, NOW).toISOString(), '2026-11-06T12:00:00.000Z');
});

test('東経 90 度の正午は UTC の 6 時', () => {
  assert.equal(localHourToDate(12, 90, NOW).toISOString(), '2026-11-06T06:00:00.000Z');
});

test('西経では UTC が遅くなり、日付をまたぐこともある', () => {
  assert.equal(localHourToDate(20, -75, NOW).toISOString(), '2026-11-07T01:00:00.000Z');
  assert.equal(localHourToDate(6, 120, NOW).toISOString(), '2026-11-05T22:00:00.000Z');
});
