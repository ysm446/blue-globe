// 標高のタイルから傾きの画像を作る計算の検証。実行: node --test tests/terrain.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSlopeTile,
  decodeSlope,
  encodeSlope,
  mercatorPixel,
  SLOPE_RANGE,
  SLOPE_TILE_PIXELS,
  TERRAIN_TILE_PIXELS,
  terrainTilesFor,
  terrariumHeight,
  type TerrainLookup,
} from '../src/main/terrain.ts';

const ZOOM = 7;
const WORLD = TERRAIN_TILE_PIXELS * 2 ** ZOOM;

// 世界全体で標高が式 height(lon, lat) になる、作りものの標高のタイル
function syntheticLookup(height: (lon: number, lat: number) => number): TerrainLookup {
  const cache = new Map<string, Float32Array>();
  return (x, y) => {
    const key = `${x}/${y}`;
    let tile = cache.get(key);
    if (!tile) {
      tile = new Float32Array(TERRAIN_TILE_PIXELS * TERRAIN_TILE_PIXELS);
      for (let ly = 0; ly < TERRAIN_TILE_PIXELS; ly++) {
        for (let lx = 0; lx < TERRAIN_TILE_PIXELS; lx++) {
          const px = x * TERRAIN_TILE_PIXELS + lx + 0.5;
          const py = y * TERRAIN_TILE_PIXELS + ly + 0.5;
          const lon = (px / WORLD) * 360 - 180;
          const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / WORLD))) * 180) / Math.PI;
          tile[ly * TERRAIN_TILE_PIXELS + lx] = height(lon, lat);
        }
      }
      cache.set(key, tile);
    }
    return tile;
  };
}

function slopeAt(tile: Uint8Array, i: number, j: number): { east: number; north: number } {
  const index = (j * SLOPE_TILE_PIXELS + i) * 2;
  return { east: decodeSlope(tile[index]), north: decodeSlope(tile[index + 1]) };
}

test('Terrarium の画素から標高を求める', () => {
  assert.equal(terrariumHeight(128, 0, 0), 0);
  assert.equal(terrariumHeight(142, 192, 0), 3776); // 富士山の高さ
  assert.equal(terrariumHeight(127, 255, 128), -0.5);
});

test('メルカトルの画素の位置', () => {
  assert.deepEqual(mercatorPixel(-180, 0, ZOOM), { x: 0, y: WORLD / 2 });
  const tokyo = mercatorPixel(139.7, 35.7, ZOOM);
  // 東京はズーム 7 のタイル (113, 50) に入る
  assert.equal(Math.floor(tokyo.x / TERRAIN_TILE_PIXELS), 113);
  assert.equal(Math.floor(tokyo.y / TERRAIN_TILE_PIXELS), 50);
});

test('傾きの符号化は平らなところを 0 に戻し、上限で頭打ちになる', () => {
  assert.ok(Math.abs(decodeSlope(encodeSlope(0))) < 1e-4);
  for (const slope of [0.001, 0.02, 0.3, -0.3, 1.5]) {
    const back = decodeSlope(encodeSlope(slope));
    // 1 段の幅の半分は、平方根で詰めているので √(|傾き| × 上限) / 127.5 程度
    const halfStep = Math.sqrt(Math.abs(slope) * SLOPE_RANGE) / 127.5;
    assert.ok(Math.abs(back - slope) <= halfStep * 1.1, `${slope} → ${back}`);
  }
  assert.equal(encodeSlope(10), 255);
  assert.equal(encodeSlope(-10), 0);
  assert.ok(Math.abs(decodeSlope(255) - SLOPE_RANGE) < 1e-9);
});

test('富士山のあたりのタイルに要る標高のタイル', () => {
  // 地域ビューのタイル (141, 24) は東経 137.25〜139.5 度、北緯 34.5〜36.75 度
  const tiles = terrainTilesFor(141, 24, ZOOM);
  assert.ok(tiles.some((t) => t.x === 112 && t.y === 50));
  assert.ok(tiles.length >= 1 && tiles.length <= 6);
});

test('極の近く (北緯 85 度より北) のタイルは標高のタイルを使わない', () => {
  assert.deepEqual(terrainTilesFor(0, 0, ZOOM), []);
  assert.deepEqual(terrainTilesFor(0, 79, ZOOM), []);
  assert.ok(terrainTilesFor(0, 2, ZOOM).length > 0); // 北緯 83.25〜85.5 度は一部が入る
});

test('日付変更線の西側のタイルは、東の端の標高のタイルとつながる', () => {
  const tiles = terrainTilesFor(159, 30, ZOOM);
  assert.ok(tiles.some((t) => t.x === 0), '東隣は列 0 の標高のタイル');
  assert.ok(tiles.some((t) => t.x === 127));
});

test('東へ上る斜面は東向きの傾きが正になる', () => {
  // 経度 1 度ごとに 1000m 上る。北緯 35 度では東西 1 度が約 91km なので、傾きは約 0.011
  const lookup = syntheticLookup((lon) => Math.max(0, (lon - 130) * 1000));
  const tile = buildSlopeTile(142, 24, lookup, ZOOM);
  const { east, north } = slopeAt(tile, 128, 128);
  const expected = 1000 / ((Math.PI / 180) * 6_371_000 * Math.cos((34.875 * Math.PI) / 180));
  assert.ok(Math.abs(east - expected) / expected < 0.05, `東向き ${east}、期待 ${expected}`);
  assert.ok(Math.abs(north) < 1e-3, `北向き ${north}`);
});

test('北へ上る斜面は北向きの傾きが正になる', () => {
  const lookup = syntheticLookup((_lon, lat) => Math.max(0, (lat - 20) * 1000));
  const tile = buildSlopeTile(142, 24, lookup, ZOOM);
  const { east, north } = slopeAt(tile, 128, 128);
  const expected = 1000 / ((Math.PI / 180) * 6_371_000);
  assert.ok(Math.abs(north - expected) / expected < 0.05, `北向き ${north}、期待 ${expected}`);
  assert.ok(Math.abs(east) < 1e-3, `東向き ${east}`);
});

test('海 (標高が 0 より下) は平らにする', () => {
  const lookup = syntheticLookup((lon) => -4000 + (lon - 130) * 100); // このタイル (東経 139.5〜141.75 度) では -3000m 前後
  const tile = buildSlopeTile(142, 24, lookup, ZOOM);
  const { east, north } = slopeAt(tile, 100, 100);
  assert.ok(Math.abs(east) < 1e-4 && Math.abs(north) < 1e-4);
});

test('取得できなかった標高のタイルは平らとして扱う', () => {
  const tile = buildSlopeTile(142, 24, () => null, ZOOM);
  assert.ok(tile.every((byte) => byte === encodeSlope(0)));
});
