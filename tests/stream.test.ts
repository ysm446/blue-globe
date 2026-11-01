// 文章の順次表示の計画の検証。実行: node --test tests/stream.test.ts
// (DOM に触らない planStream だけを読み込む)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planStream } from '../src/renderer/stream.ts';

test('最初の表示は上の段落から順に流す', () => {
  const [first, second, third] = planStream(['あいう', 'かきくけこ', 'さ'], ['', '', '']);
  assert.equal(first.startMs, 0);
  assert.ok(first.animate && second.animate && third.animate);
  assert.ok(second.startMs > 0);
  assert.ok(third.startMs > second.startMs);
});

test('段落の間には少し間があり、前の段落より後に始まる', () => {
  const [first, second] = planStream(['あいう', 'か'], ['', '']);
  const perChar = (planStream(['ああ'], [''])[0].durationMs - planStream(['あ'], [''])[0].durationMs);
  assert.ok(second.startMs > 3 * perChar - 1, `${second.startMs} ${perChar}`);
  assert.ok(first.durationMs > 0);
});

test('内容が同じ段落は流し直さない', () => {
  const plan = planStream(['同じ', '同じ'], ['同じ', '同じ']);
  assert.deepEqual(plan.map((step) => step.animate), [false, false]);
});

test('変わった段落だけを最初から流し、待たせない', () => {
  const plan = planStream(['同じ文章です', '変わった'], ['同じ文章です', '以前']);
  assert.equal(plan[0].animate, false);
  assert.equal(plan[1].animate, true);
  assert.equal(plan[1].startMs, 0);
});

test('空の段落は流さず、後ろの段落を遅らせない', () => {
  const plan = planStream(['', 'あ'], ['', '']);
  assert.equal(plan[0].animate, false);
  assert.equal(plan[1].startMs, 0);
});

test('絵文字のような 2 単位の文字も 1 文字として数える', () => {
  assert.equal(planStream(['𠮷'], [''])[0].durationMs, planStream(['あ'], [''])[0].durationMs);
});
