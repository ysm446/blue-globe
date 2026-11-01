// 地域ビューのタイルの範囲の検証。実行: node --test tests/tile-window.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextTileWindow, tilesInWindow, TILE_COLS, TILE_ROWS } from '../src/renderer/tile-window.ts';

test('東京湾付近は行 24、列 142 のタイルに入る', () => {
  // 実際に取得して東京湾が写っていることを確かめたタイル
  assert.deepEqual(nextTileWindow(null, 35.0, 140.0), { col: 142, row: 24 });
});

test('中心が少し動いただけでは範囲を動かさない', () => {
  const window = nextTileWindow(null, 35.5, 139.7);
  assert.equal(nextTileWindow(window, 36.5, 141), window);
  assert.notEqual(nextTileWindow(window, 35.5, 139.7 + 2.25 * 4), window);
  assert.notEqual(nextTileWindow(window, 35.5 + 2.25 * 4, 139.7), window);
});

test('日付変更線をまたいでも列は連続したまま', () => {
  const window = { col: 159, row: 30 };
  const moved = nextTileWindow(window, 22.5, -170); // 東へ 8.9 タイル
  assert.equal(moved.col, 164);
});

test('範囲は 14×14 枚で、置き場所が重ならない', () => {
  const tiles = tilesInWindow({ col: 142, row: 24 });
  assert.equal(tiles.length, 196);
  assert.equal(new Set(tiles.map((t) => `${t.slotX},${t.slotY}`)).size, 196);
  assert.equal(new Set(tiles.map((t) => `${t.col},${t.row}`)).size, 196);
});

test('中心に近いタイルから順に読む', () => {
  const tiles = tilesInWindow({ col: 142, row: 24 });
  assert.ok(Math.abs(tiles[0].col - 142) <= 1 && Math.abs(tiles[0].row - 24) <= 1);
  for (let i = 1; i < tiles.length; i++) assert.ok(tiles[i].distance >= tiles[i - 1].distance);
});

test('日付変更線の向こうのタイルは列を折り返して取得し、置き場所は連続する', () => {
  const tiles = tilesInWindow({ col: 158, row: 24 });
  assert.ok(tiles.every((t) => t.col >= 0 && t.col < TILE_COLS));
  // 列 159 の次は列 0 (折り返す前の 160)
  const last = tiles.find((t) => t.col === 159 && t.row === 24);
  const next = tiles.find((t) => t.col === 0 && t.row === 24);
  assert.equal(next!.slotX, (last!.slotX + 1) % 14);
});

test('左へ折り返しても置き場所は 0 以上', () => {
  const tiles = tilesInWindow({ col: 2, row: 24 });
  assert.ok(tiles.every((t) => t.slotX >= 0 && t.slotX < 14 && t.col >= 0 && t.col < TILE_COLS));
  assert.equal(new Set(tiles.map((t) => t.slotX)).size, 14);
});

test('極の近くでは地球の外の行を含めない', () => {
  const north = tilesInWindow({ col: 80, row: 3 });
  assert.ok(north.every((t) => t.row >= 0));
  assert.equal(north.length, 14 * 10);
  const south = tilesInWindow({ col: 80, row: TILE_ROWS - 2 });
  assert.ok(south.every((t) => t.row < TILE_ROWS));
});
