// 地域ビューで読み込むタイルの範囲の計算。画面の計算から切り離して検証できるよう、Three.js に依存しない。
// NASA GIBS の 500m の面は 512 画素のタイルで、1 枚が 2.25 度四方。列は経度 -180 度から、行は北極から数える
export const TILE_DEGREES = 2.25;
export const TILE_PIXELS = 512;
export const WINDOW_TILES = 14; // 約 31.5 度四方
export const TILE_COLS = 160;
export const TILE_ROWS = 80;
const RECENTER_TILES = 3; // 中心がこれだけ離れたら範囲を動かす。少し動くたびに読み直さないため

// 範囲の中心。列は日付変更線をまたいでも連続した値のまま持ち、画像の中での置き場所が変わらないようにする
export interface TileWindow {
  col: number;
  row: number;
}

export interface WindowTile {
  col: number; // 取得するタイルの列 (0〜159)
  row: number;
  slotX: number; // 画像の中での置き場所 (0〜13)
  slotY: number;
  distance: number; // 範囲の中心からの距離 (タイル数)
}

function positiveMod(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

export function nextTileWindow(current: TileWindow | null, lat: number, lon: number): TileWindow {
  const col = (lon + 180) / TILE_DEGREES;
  const row = (90 - lat) / TILE_DEGREES;
  if (!current) return { col: Math.floor(col), row: Math.floor(row) };
  const offset = positiveMod(col - current.col + TILE_COLS / 2, TILE_COLS) - TILE_COLS / 2;
  if (Math.abs(offset) < RECENTER_TILES && Math.abs(row - current.row) < RECENTER_TILES) return current;
  return { col: Math.floor(current.col + offset), row: Math.floor(row) };
}

// 範囲に入るタイルを、中心に近い順に返す。地球の外になる行は含めない
export function tilesInWindow(window: TileWindow): WindowTile[] {
  const half = WINDOW_TILES / 2;
  const tiles: WindowTile[] = [];
  for (let row = window.row - half; row < window.row + half; row++) {
    if (row < 0 || row >= TILE_ROWS) continue;
    for (let col = window.col - half; col < window.col + half; col++) {
      tiles.push({
        col: positiveMod(col, TILE_COLS),
        row,
        slotX: positiveMod(col, WINDOW_TILES),
        slotY: positiveMod(row, WINDOW_TILES),
        distance: Math.hypot(col + 0.5 - window.col, row + 0.5 - window.row),
      });
    }
  }
  return tiles.sort((a, b) => a.distance - b.distance);
}
