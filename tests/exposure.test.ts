// 露出の自動調整の検証。実行: node --test tests/exposure.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adaptExposure,
  earthClearance,
  screenPresence,
  targetExposure,
} from '../src/renderer/exposure.ts';

const SUN = [1, 0, 0] as const; // カメラから見た太陽の方向

test('太陽の手前に地球があると隠れる', () => {
  assert.equal(earthClearance([-3.3, 0, 0], SUN, 1), 0); // 真後ろ
  assert.equal(earthClearance([-3.3, 0.5, 0], SUN, 1), 0);
});

test('地球の横に見えると隠れない', () => {
  assert.equal(earthClearance([-3.3, 1.6, 0], SUN, 1), 1);
});

test('太陽を背にした側からは常に隠れない', () => {
  assert.equal(earthClearance([3.3, 0, 0], SUN, 1), 1);
});

test('地球の縁から出る途中は値が増えていく', () => {
  const low = earthClearance([-3.3, 1.0, 0], SUN, 1);
  const high = earthClearance([-3.3, 1.03, 0], SUN, 1);
  assert.ok(low > 0 && low < high && high < 1, `${low} ${high}`);
});

test('画面の外へ出ると太陽の影響がなくなる', () => {
  assert.equal(screenPresence(0.3, 0.2, true), 1);
  assert.equal(screenPresence(1.5, 0, true), 0);
  assert.equal(screenPresence(0, 0, false), 0); // カメラの後ろ
  const edge = screenPresence(1.2, 0, true);
  assert.ok(edge > 0 && edge < 1);
});

test('太陽が見えると絞り、夜側では開ける', () => {
  assert.ok(targetExposure(0, 1) < targetExposure(0, 0) * 0.5);
  assert.ok(targetExposure(-1, 0) > 1);
  assert.ok(targetExposure(1, 0) < 1);
});

test('露出は急に変わらず、絞るほうが開けるより速い', () => {
  const closing = adaptExposure(1, 0.3, 0.1);
  const opening = adaptExposure(0.3, 1, 0.1);
  assert.ok(closing < 1 && closing > 0.3);
  assert.ok(opening > 0.3 && opening < 1);
  assert.ok(1 - closing > opening - 0.3);
});

test('十分時間がたつと目標に落ち着く', () => {
  let exposure = 0.3;
  for (let i = 0; i < 600; i++) exposure = adaptExposure(exposure, 1, 1 / 60);
  assert.ok(Math.abs(exposure - 1) < 0.01);
});
