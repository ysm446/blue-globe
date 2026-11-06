// 標高のタイル (AWS Terrain Tiles の Terrarium 形式。Web メルカトル) から、
// 地域ビューのタイル (正距円筒図法、2.25 度四方) の地形の傾きの画像を作る。
// Electron に依存しない計算だけを置き、取得と保存は terrain-tiles.ts で行う
import { TILE_DEGREES } from '../renderer/tile-window.ts';

export const TERRAIN_ZOOM = 7; // 1 画素が赤道で約 1.2km、北緯 35 度で約 1km
export const TERRAIN_TILE_PIXELS = 256; // 配信のタイルの大きさ
export const SLOPE_TILE_PIXELS = 256; // 作る傾きの画像の大きさ。1 画素が約 1km
export const SLOPE_RANGE = 2; // 符号化できる傾きの上限 (高さ / 水平距離)。約 63 度
const EARTH_RADIUS_M = 6_371_000;
const MAX_MERCATOR_LAT = 85.0511287798; // Web メルカトルの端

// Terrarium 形式の画素から標高 (m) を求める
export function terrariumHeight(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

// 経度と緯度から、ズーム zoom の世界全体での画素の位置を求める (画素の左上が整数)
export function mercatorPixel(lon: number, lat: number, zoom: number): { x: number; y: number } {
  const size = TERRAIN_TILE_PIXELS * 2 ** zoom;
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const phi = (clamped * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * size,
    y: ((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2) * size,
  };
}

// 傾きの画像の画素の中心の経度と緯度。i, j は -1 と SLOPE_TILE_PIXELS (隣のタイルの 1 画素) も受け付ける
function pixelLonLat(col: number, row: number, i: number, j: number): { lon: number; lat: number } {
  const step = TILE_DEGREES / SLOPE_TILE_PIXELS;
  return {
    lon: col * TILE_DEGREES - 180 + (i + 0.5) * step,
    lat: 90 - row * TILE_DEGREES - (j + 0.5) * step,
  };
}

export interface TerrainTileKey {
  x: number;
  y: number;
}

// 地域ビューのタイル (col, row) の傾きを求めるのに要る、標高のタイルの一覧。
// メルカトルの範囲 (北緯・南緯 85 度) の外だけのタイルは空になる
export function terrainTilesFor(col: number, row: number, zoom = TERRAIN_ZOOM): TerrainTileKey[] {
  const north = pixelLonLat(col, row, -1, -1);
  const south = pixelLonLat(col, row, SLOPE_TILE_PIXELS, SLOPE_TILE_PIXELS);
  if (south.lat >= MAX_MERCATOR_LAT || north.lat <= -MAX_MERCATOR_LAT) return [];
  const topLeft = mercatorPixel(north.lon, north.lat, zoom);
  const bottomRight = mercatorPixel(south.lon, south.lat, zoom);
  const count = 2 ** zoom;
  // 両隣の画素を混ぜるので、半画素ずつ広げる
  const x0 = Math.floor((topLeft.x - 1) / TERRAIN_TILE_PIXELS);
  const x1 = Math.floor((bottomRight.x + 1) / TERRAIN_TILE_PIXELS);
  const y0 = Math.max(0, Math.floor((topLeft.y - 1) / TERRAIN_TILE_PIXELS));
  const y1 = Math.min(count - 1, Math.floor((bottomRight.y + 1) / TERRAIN_TILE_PIXELS));
  const tiles: TerrainTileKey[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) tiles.push({ x: ((x % count) + count) % count, y });
  }
  return tiles;
}

// 傾きを 1 バイトに詰める。平地の小さな傾きを細かく残すよう、平方根で詰める (0.5 付近が平ら)
export function encodeSlope(slope: number): number {
  const amount = Math.sqrt(Math.min(Math.abs(slope) / SLOPE_RANGE, 1));
  return Math.round(127.5 + 127.5 * Math.sign(slope) * amount);
}

// encodeSlope の逆。シェーダーでも同じ式で戻す (earth.ts)
export function decodeSlope(byte: number): number {
  const v = (byte / 255) * 2 - 1;
  return Math.sign(v) * v * v * SLOPE_RANGE;
}

// 標高のタイルの中身。heights は 256×256 の標高 (m)。取得できなかったタイルは null
export type TerrainLookup = (x: number, y: number) => Float32Array | null;

// 地域ビューのタイル (col, row) の傾きの画像を作る。1 画素 2 バイトで、東向きの傾き、北向きの傾きの順。
// 海 (標高が 0 より下) は平らにする。海底の地形は描かず、海岸で急な崖にならないようにするため
export function buildSlopeTile(col: number, row: number, lookup: TerrainLookup, zoom = TERRAIN_ZOOM): Uint8Array {
  const size = SLOPE_TILE_PIXELS;
  const span = size + 2; // 両隣の 1 画素を含める
  const heights = new Float32Array(span * span);
  const count = 2 ** zoom;
  const world = TERRAIN_TILE_PIXELS * count;

  const heightAt = (px: number, py: number): number => {
    const tx = Math.floor(px / TERRAIN_TILE_PIXELS);
    const ty = Math.floor(py / TERRAIN_TILE_PIXELS);
    if (ty < 0 || ty >= count) return 0;
    const tile = lookup(((tx % count) + count) % count, ty);
    if (!tile) return 0;
    const lx = px - tx * TERRAIN_TILE_PIXELS;
    const ly = py - ty * TERRAIN_TILE_PIXELS;
    return Math.max(0, tile[ly * TERRAIN_TILE_PIXELS + lx]);
  };

  for (let j = -1; j <= size; j++) {
    for (let i = -1; i <= size; i++) {
      const { lon, lat } = pixelLonLat(col, row, i, j);
      let value = 0;
      if (Math.abs(lat) < MAX_MERCATOR_LAT) {
        // 画素の中心どうしで線形に混ぜる
        const p = mercatorPixel(lon, lat, zoom);
        const fx = p.x - 0.5;
        const fy = Math.min(Math.max(p.y - 0.5, 0), world - 1);
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const y1 = Math.min(y0 + 1, world - 1);
        const ax = fx - x0;
        const ay = fy - y0;
        const top = heightAt(x0, y0) * (1 - ax) + heightAt(x0 + 1, y0) * ax;
        const bottom = heightAt(x0, y1) * (1 - ax) + heightAt(x0 + 1, y1) * ax;
        value = top * (1 - ay) + bottom * ay;
      }
      heights[(j + 1) * span + (i + 1)] = value;
    }
  }

  const out = new Uint8Array(size * size * 2);
  const stepRadians = ((TILE_DEGREES / size) * Math.PI) / 180;
  const dy = stepRadians * EARTH_RADIUS_M; // 南北の 1 画素の距離 (m)
  for (let j = 0; j < size; j++) {
    const { lat } = pixelLonLat(col, row, 0, j);
    // 極の近くで東西の距離が 0 にならないよう抑える
    const dx = Math.max(stepRadians * EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180), dy * 0.05);
    for (let i = 0; i < size; i++) {
      const c = (j + 1) * span + (i + 1);
      const east = (heights[c + 1] - heights[c - 1]) / (2 * dx);
      const north = (heights[c - span] - heights[c + span]) / (2 * dy); // 上 (小さい j) が北
      out[(j * size + i) * 2] = encodeSlope(east);
      out[(j * size + i) * 2 + 1] = encodeSlope(north);
    }
  }
  return out;
}
