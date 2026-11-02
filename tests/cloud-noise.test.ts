// ボリューム雲のノイズの検証。実行: node --test tests/cloud-noise.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCloudNoise } from '../src/renderer/cloud-noise.ts';

const SIZE = 32;
const noise = createCloudNoise(SIZE);
const at = (x: number, y: number, z: number, channel: number): number =>
  noise[(x + SIZE * (y + SIZE * z)) * 2 + channel];

test('2 成分とも 0〜255 いっぱいに広がる', () => {
  for (const channel of [0, 1]) {
    const values = noise.filter((_, i) => i % 2 === channel);
    assert.equal(Math.min(...values), 0);
    assert.equal(Math.max(...values), 255);
  }
});

test('同じ大きさなら毎回同じノイズになる', () => {
  assert.deepEqual(createCloudNoise(SIZE), noise);
});

// 継ぎ目がなければ、端をまたぐ隣との差は内側の隣との差と同じ程度になる
function edgeGapRatio(channel: number): number {
  let edge = 0;
  let inside = 0;
  for (let z = 0; z < SIZE; z++) {
    for (let y = 0; y < SIZE; y++) {
      edge += Math.abs(at(SIZE - 1, y, z, channel) - at(0, y, z, channel));
      inside += Math.abs(at(SIZE / 2 - 1, y, z, channel) - at(SIZE / 2, y, z, channel));
    }
  }
  return edge / inside;
}

test('端と端がつながる', () => {
  assert.ok(edgeGapRatio(0) < 1.5, `大きなかたまり ${edgeGapRatio(0)}`);
  assert.ok(edgeGapRatio(1) < 1.5, `細かいかたまり ${edgeGapRatio(1)}`);
});
