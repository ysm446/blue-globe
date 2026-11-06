// カメラの視点の保存の検証。実行: node --test tests/camera-bookmarks.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookmarkLift, bookmarkSlot } from '../src/renderer/camera-bookmarks.ts';

test('数字のキーとテンキーは同じ番号', () => {
  assert.equal(bookmarkSlot('Digit1'), 1);
  assert.equal(bookmarkSlot('Digit0'), 0);
  assert.equal(bookmarkSlot('Numpad9'), 9);
});

test('数字でないキーは null', () => {
  assert.equal(bookmarkSlot('KeyW'), null);
  assert.equal(bookmarkSlot('NumpadAdd'), null);
  assert.equal(bookmarkSlot('F1'), null);
});

test('近い視点へは上がらず、離れているほど高く上がる', () => {
  assert.equal(bookmarkLift(0), 0);
  assert.equal(bookmarkLift(3), 0);
  assert.ok(bookmarkLift(10) < 0.15);
  assert.ok(bookmarkLift(87) > 1 && bookmarkLift(87) < 1.4);
  assert.ok(bookmarkLift(180) > bookmarkLift(90));
});
