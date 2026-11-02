// 雲の現れ方の検証。実行: node --test tests/fade.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepFade } from '../src/renderer/fade.ts';
import { easeInOut } from '../src/renderer/math.ts';

function secondsUntilDone(fps: number, visible: boolean, start: number): number {
  const dt = 1 / fps;
  const goal = visible ? 1 : 0;
  let progress = start;
  let elapsed = 0;
  while (progress !== goal) {
    progress = stepFade(progress, visible, dt);
    elapsed += dt;
    assert.ok(elapsed < 10, 'fade did not finish');
  }
  return elapsed;
}

test('FPS によらず同じ時間で現れる', () => {
  const at120 = secondsUntilDone(120, true, 0);
  const at30 = secondsUntilDone(30, true, 0);
  assert.ok(Math.abs(at120 - at30) < 0.05, `${at120} ${at30}`);
  assert.ok(at120 > 1 && at120 < 2.5, `${at120}`);
});

test('消えるほうが現れるより速い', () => {
  assert.ok(secondsUntilDone(60, false, 1) < secondsUntilDone(60, true, 0));
});

test('範囲の外へ出ない', () => {
  assert.equal(stepFade(1, true, 1), 1);
  assert.equal(stepFade(0, false, 1), 0);
  assert.equal(stepFade(0.5, true, 100), 1);
});

test('途中で向きが変わっても値が飛ばない', () => {
  const up = stepFade(0.4, true, 1 / 60);
  const down = stepFade(up, false, 1 / 60);
  assert.ok(Math.abs(up - 0.4) < 0.05);
  assert.ok(Math.abs(down - up) < 0.05);
});

test('動き始めと終わりがなめらかで、単調に増える', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.ok(easeInOut(0.05) < 0.05);
  assert.ok(easeInOut(0.95) > 0.95);
  let previous = 0;
  for (let i = 1; i <= 100; i++) {
    const value = easeInOut(i / 100);
    assert.ok(value > previous);
    previous = value;
  }
});
