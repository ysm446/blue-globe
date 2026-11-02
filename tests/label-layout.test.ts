// 地図のラベルの配置の検証。実行: node --test tests/label-layout.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeLabels, type LabelBox } from '../src/renderer/label-layout.ts';

const box = (x: number, y: number): LabelBox => ({ x, y, width: 50, height: 20 });

test('離れたラベルはすべて出す', () => {
  assert.deepEqual(placeLabels([box(0, 0), box(200, 0), box(0, 100)]), [true, true, true]);
});

test('重なるときは先のラベルを残す', () => {
  assert.deepEqual(placeLabels([box(0, 0), box(30, 10), box(200, 0)]), [true, false, true]);
});

test('出さなかったラベルは、後のラベルを隠さない', () => {
  // 2 つ目は 1 つ目に隠れる。3 つ目は 2 つ目とだけ重なるので出る
  assert.deepEqual(placeLabels([box(0, 0), box(45, 0), box(90, 0)]), [true, false, true]);
});

test('文字がくっつくほど近いラベルも重なりとして扱う', () => {
  assert.deepEqual(placeLabels([box(0, 0), box(51, 0)]), [true, false]);
  assert.deepEqual(placeLabels([box(0, 0), box(53, 0)]), [true, true]);
});

test('地球の裏側のラベルは出さず、他を隠さない', () => {
  assert.deepEqual(placeLabels([null, box(0, 0)]), [false, true]);
});

test('地点のマーカーと重なるラベルは出さない', () => {
  assert.deepEqual(placeLabels([box(0, 0), box(200, 0)], [box(10, 5)]), [false, true]);
});
