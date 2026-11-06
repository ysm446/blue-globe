// 標高のタイル (AWS Terrain Tiles の Terrarium 形式) の取得と保存、地形の傾きの画像の作成。
// 標高のタイルは配信の PNG のまま data/earth-tiles/terrain/{ズーム}/{x}/{y}.png に保存し、取り直さない。
// 傾きの画像は保存せず、求められるたびに作る (1 枚数ミリ秒)
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { buildSlopeTile, TERRAIN_TILE_PIXELS, TERRAIN_ZOOM, terrainTilesFor, terrariumHeight, type TerrainTileKey } from './terrain';

const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const FETCH_TIMEOUT_MS = 20_000;
const DECODED_CACHE_TILES = 64; // 隣どうしの地域ビューのタイルで共有するので、展開した標高をしばらく持つ (1 枚 256KB)

type WriteFile = (filePath: string, data: Uint8Array) => Promise<void>;

export function createTerrainSource(tileDir: string, writeFile: WriteFile) {
  const decoded = new Map<string, Float32Array>(); // 古い順。使うたびに末尾へ移す
  const pending = new Map<string, Promise<Float32Array | null>>();

  async function readOrFetch(key: TerrainTileKey): Promise<Buffer | null> {
    const filePath = path.join(tileDir, String(TERRAIN_ZOOM), String(key.x), `${key.y}.png`);
    try {
      return await fs.promises.readFile(filePath);
    } catch {
      // 保存していないので取得する
    }
    try {
      const url = `${TERRAIN_URL}/${TERRAIN_ZOOM}/${key.x}/${key.y}.png`;
      const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) return null;
      const received = Buffer.from(await response.arrayBuffer());
      if (nativeImage.createFromBuffer(received).isEmpty()) return null;
      await writeFile(filePath, received);
      return received;
    } catch {
      return null;
    }
  }

  function decode(png: Buffer): Float32Array | null {
    const image = nativeImage.createFromBuffer(png);
    const { width, height } = image.getSize();
    if (width !== TERRAIN_TILE_PIXELS || height !== TERRAIN_TILE_PIXELS) return null;
    const bitmap = image.toBitmap(); // Windows では 1 画素が B, G, R, A の順
    const heights = new Float32Array(width * height);
    for (let i = 0; i < heights.length; i++) {
      heights[i] = terrariumHeight(bitmap[i * 4 + 2], bitmap[i * 4 + 1], bitmap[i * 4]);
    }
    return heights;
  }

  function loadTile(key: TerrainTileKey): Promise<Float32Array | null> {
    const name = `${key.x}/${key.y}`;
    const cached = decoded.get(name);
    if (cached) {
      decoded.delete(name);
      decoded.set(name, cached);
      return Promise.resolve(cached);
    }
    // 同じタイルを同時に取りに行かない
    let request = pending.get(name);
    if (!request) {
      request = readOrFetch(key).then((png) => {
        pending.delete(name);
        const heights = png ? decode(png) : null;
        if (heights) {
          decoded.set(name, heights);
          if (decoded.size > DECODED_CACHE_TILES) decoded.delete(decoded.keys().next().value as string);
        }
        return heights;
      });
      pending.set(name, request);
    }
    return request;
  }

  // 地域ビューのタイル (col, row) の傾きの画像。標高のタイルが 1 枚でも取得できなければ null を返し、あとで取り直してもらう
  async function getSlopeTile(col: number, row: number): Promise<Uint8Array | null> {
    const keys = terrainTilesFor(col, row);
    const tiles = await Promise.all(keys.map(loadTile));
    if (tiles.some((tile) => tile === null)) return null;
    const byName = new Map(keys.map((key, index) => [`${key.x}/${key.y}`, tiles[index] as Float32Array]));
    return buildSlopeTile(col, row, (x, y) => byName.get(`${x}/${y}`) ?? null);
  }

  return { getSlopeTile };
}
