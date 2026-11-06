// ツアーの時刻、保存するときの名前と id、字幕の文字数の計算の検証。実行: node --test tests/tour.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localHourToDate } from '../src/renderer/tour-time.ts';
import { defaultTourTitle, newTourId } from '../src/renderer/tour-library.ts';
import { revealedCount } from '../src/renderer/caption-reveal.ts';

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

test('名前があればそれをツアーの名前にする', () => {
  assert.equal(defaultTourTitle('  世界の長い川 ', []), '世界の長い川');
});

test('名前がなければ最初の字幕の最初の文を名前にする', () => {
  const scenes = [
    { highlights: [] },
    { highlights: [], caption: '世界の長い川トップ10。字幕をクリックすると次へ進みます。' },
  ];
  assert.equal(defaultTourTitle(null, scenes), '世界の長い川トップ10');
});

test('長い字幕は切り詰める', () => {
  const title = defaultTourTitle(null, [{ highlights: [], caption: 'あ'.repeat(50) }]);
  assert.equal(title.length, 30);
  assert.ok(title.endsWith('…'));
});

test('字幕もなければ日時を名前にする', () => {
  assert.equal(defaultTourTitle(null, [{ highlights: [] }], new Date(2026, 10, 6, 9, 5)), 'ツアー 11/6 09:05');
});

test('id はサーバーが受け付ける形', () => {
  const id = newTourId(Date.UTC(2026, 10, 6), () => 0.5);
  assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(newTourId(1, () => 0.1), newTourId(1, () => 0.2));
});

test('字幕の文字数は、フレームの時刻が出し始めより前でも 0 から始まる', () => {
  assert.equal(revealedCount(-5, 40), 0);
  assert.equal(revealedCount(0, 40), 0);
  assert.equal(revealedCount(1000, 40), 28);
  assert.equal(revealedCount(10_000, 40), 40);
});
