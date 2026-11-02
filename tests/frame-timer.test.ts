// 1 フレームの処理時間の検証。実行: node --test tests/frame-timer.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFrameStats, GpuTimer } from '../src/renderer/frame-timer.ts';

const TIME_ELAPSED = 1;
const DISJOINT = 2;
const AVAILABLE = 3;
const RESULT = 4;

// 問い合わせを作った順に番号を振り、ready に入れた番号だけ結果が届いたことにする
function fakeGl(hasTimer = true) {
  const state = { created: 0, deleted: 0, ready: new Set<number>(), nanoseconds: 2_500_000, lost: false, open: 0, parameterReads: 0 };
  const gl = {
    QUERY_RESULT_AVAILABLE: AVAILABLE,
    QUERY_RESULT: RESULT,
    getExtension: () => (hasTimer ? { TIME_ELAPSED_EXT: TIME_ELAPSED, GPU_DISJOINT_EXT: DISJOINT } : null),
    createQuery: () => ++state.created,
    deleteQuery: () => state.deleted++,
    beginQuery: () => state.open++,
    endQuery: () => state.open--,
    getParameter: () => {
      state.parameterReads++;
      return state.lost;
    },
    getQueryParameter: (query: number, name: number) => (name === AVAILABLE ? state.ready.has(query) : state.nanoseconds),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, state };
}

test('結果が届いたものだけを ms で返す', () => {
  const { gl, state } = fakeGl();
  const timer = new GpuTimer(gl);
  timer.begin();
  timer.end();
  assert.deepEqual(timer.collect(), []);
  state.ready.add(1);
  assert.deepEqual(timer.collect(), [2.5]);
  assert.equal(state.deleted, 1);
  assert.deepEqual(timer.collect(), []);
});

test('計測中の問い合わせは読まない', () => {
  const { gl, state } = fakeGl();
  const timer = new GpuTimer(gl);
  timer.begin();
  state.ready.add(1);
  assert.deepEqual(timer.collect(), []);
  timer.end();
  assert.deepEqual(timer.collect(), [2.5]);
});

test('GPU の時刻が飛んだ間の結果は捨てる', () => {
  const { gl, state } = fakeGl();
  const timer = new GpuTimer(gl);
  timer.begin();
  timer.end();
  state.ready.add(1);
  state.lost = true;
  assert.deepEqual(timer.collect(), []);
  assert.equal(state.deleted, 1);
});

test('結果が届かなくても問い合わせを溜め続けない', () => {
  const { gl, state } = fakeGl();
  const timer = new GpuTimer(gl);
  for (let i = 0; i < 20; i++) {
    timer.begin();
    timer.end();
  }
  assert.equal(state.created, 8);
  assert.equal(state.open, 0);
});

test('タイマーがない環境でも動く', () => {
  const { gl, state } = fakeGl(false);
  const timer = new GpuTimer(gl);
  timer.begin();
  timer.end();
  assert.deepEqual(timer.collect(), []);
  assert.equal(state.created, 0);
  assert.equal(state.parameterReads, 0); // 拡張の定数がないのに読むと GL のエラーになる
});

test('表示は合計と内訳を出し、GPU を測れないときは CPU だけと分かるようにする', () => {
  assert.equal(formatFrameStats(59.6, 1.24, 3.1), '60 FPS 4.3 ms (CPU 1.2 / GPU 3.1)');
  assert.equal(formatFrameStats(30, 2, null), '30 FPS 2.0 ms (CPU)');
});
