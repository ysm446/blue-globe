// GFS のランと予報時間の選び方の検証。実行: node --test tests/gfs-time.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateRuns, nearestForecastHour, nearestStepStamp, parsePastTime } from '../src/main/gfs-time.ts';

const NOW = new Date('2026-11-02T07:00:00Z');

test('今の時刻では、公開済みのランから新しい順に探す', () => {
  const runs = candidateRuns(NOW, NOW).map((run) => run.toISOString());
  assert.equal(runs[0], '2026-11-02T00:00:00.000Z'); // 7 時 - 公開の遅れ 5 時間 = 2 時
  assert.equal(runs[1], '2026-11-01T18:00:00.000Z');
  assert.equal(runs.length, 4);
});

test('過去の時刻では、その時点を含むランから探す', () => {
  const runs = candidateRuns(new Date('2026-11-01T14:20:00Z'), NOW);
  assert.equal(runs[0].toISOString(), '2026-11-01T12:00:00.000Z');
});

test('少し前の時刻で、そのランがまだ公開されていなければ前のランを使う', () => {
  const runs = candidateRuns(new Date('2026-11-02T06:30:00Z'), NOW);
  assert.equal(runs[0].toISOString(), '2026-11-02T00:00:00.000Z');
});

test('予報時間は一番近い 3 時間の区切りを選ぶ', () => {
  const run = new Date('2026-11-01T12:00:00Z');
  assert.equal(nearestForecastHour(run, new Date('2026-11-01T13:29:00Z')), 0);
  assert.equal(nearestForecastHour(run, new Date('2026-11-01T13:31:00Z')), 3);
  assert.equal(nearestForecastHour(run, new Date('2026-11-01T17:00:00Z')), 6);
  assert.equal(nearestForecastHour(run, new Date('2026-11-01T11:00:00Z')), 0);
});

test('保存の名前は一番近い区切りになり、日付をまたいでも正しい', () => {
  assert.equal(nearestStepStamp(new Date('2026-11-01T13:31:00Z')), '2026110115');
  assert.equal(nearestStepStamp(new Date('2026-11-01T13:29:00Z')), '2026110112');
  assert.equal(nearestStepStamp(new Date('2026-11-01T23:50:00Z')), '2026110200');
});

test('過去 97 時間より前や、未来や、不正な値は受け付けない', () => {
  assert.equal(parsePastTime('2026-11-01T08:00:00Z', NOW).toISOString(), '2026-11-01T08:00:00.000Z');
  assert.equal(parsePastTime('2026-10-29T07:00:00Z', NOW).toISOString(), '2026-10-29T07:00:00.000Z'); // 96 時間前
  assert.throws(() => parsePastTime('2026-10-29T05:00:00Z', NOW));
  assert.throws(() => parsePastTime('2026-11-02T08:00:00Z', NOW));
  assert.throws(() => parsePastTime('tomorrow', NOW));
  assert.throws(() => parsePastTime(123, NOW));
});
