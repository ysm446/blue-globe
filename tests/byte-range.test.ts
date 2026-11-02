// 音源の Range ヘッダーの検証。実行: node --test tests/byte-range.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseByteRange } from '../src/main/byte-range.ts';

test('始まりから終わりまでの区間', () => {
  assert.deepEqual(parseByteRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseByteRange('bytes=100-199', 1000), { start: 100, end: 199 });
});

test('末尾からの区間', () => {
  assert.deepEqual(parseByteRange('bytes=-200', 1000), { start: 800, end: 999 });
  assert.deepEqual(parseByteRange('bytes=-2000', 1000), { start: 0, end: 999 });
});

test('ファイルの終わりを超える指定は終わりに揃える', () => {
  assert.deepEqual(parseByteRange('bytes=900-5000', 1000), { start: 900, end: 999 });
});

test('解釈できないものはファイル全体を返す', () => {
  for (const header of [null, '', 'bytes=-', 'bytes=-0', 'bytes=0-1,5-6', 'items=0-1', 'bytes=1000-', 'bytes=5-2']) {
    assert.equal(parseByteRange(header, 1000), null, String(header));
  }
  assert.equal(parseByteRange('bytes=0-', 0), null);
});
