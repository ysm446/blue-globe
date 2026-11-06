// ツアーのハイライトのデータ (Natural Earth の川と、山脈・砂漠などの範囲) の検索と、範囲の計算。
// 描画 (highlights.ts) から切り離して検証できるよう、Three.js に依存しない。
// データは scripts/build-highlights.mjs で作る。座標はすべて [lon, lat, lon, lat, ...] の平らな並び

// 川。l は線ごとの [始点の源流からの距離 (km), lon, lat, ...]、L は源流から河口までの長さ (km)
export interface RiverRecord {
  n: string; // 英語名
  a: string[]; // 別名 (現地の名前など)
  r: number; // 重要度 (Natural Earth の scalerank。小さいほど大きな川)
  L: number;
  l: number[][];
}

// 山脈、砂漠、高原などの範囲。p は多角形ごとの輪の並び (1 つ目が外周、残りが穴)
export interface RegionRecord {
  n: string;
  ja: string;
  c: string; // 種類 (Range/mtn, Desert, Plateau など)
  r: number;
  p: number[][][];
}

export interface Bounds {
  south: number;
  north: number;
  west: number; // 日付変更線をまたぐときは east より大きいことがある
  east: number;
}

// 名前をそろえる。大文字と小文字、アクセント記号、前後の空白の違いを無視する
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// 「〜川」「~ River」のような付け足しを除く。名前だけで探し直すため
function stripSuffix(name: string): string {
  return name
    .replace(/\s*(river|rio|mountains?|range|desert|plateau)$/i, '')
    .replace(/^(river|rio|mount|mt\.?)\s+/i, '')
    .replace(/(川|河|江|山脈|山地|砂漠|高原)$/, '')
    .trim();
}

// 名前で探す。完全に一致するものを先に、なければ付け足しを除いて一致するもの、最後に名前を含むものを探す。
// 候補が複数あるときは重要度の高い (rank の小さい) ものを選ぶ
export function findByName<T extends { r: number }>(records: T[], query: string, namesOf: (record: T) => string[]): T | null {
  const target = normalizeName(query);
  const bare = normalizeName(stripSuffix(query));
  if (!target) return null;
  const best = (match: (name: string) => boolean): T | null => {
    let found: T | null = null;
    for (const record of records) {
      if (!namesOf(record).some((name) => match(normalizeName(name)))) continue;
      if (!found || record.r < found.r) found = record;
    }
    return found;
  };
  return (
    best((name) => name === target) ??
    best((name) => name === bare || normalizeName(stripSuffix(name)) === bare) ??
    (bare.length >= 3 ? best((name) => name.includes(bare)) : null)
  );
}

export const riverNames = (river: RiverRecord): string[] => [river.n, ...river.a];
export const regionNames = (region: RegionRecord): string[] => [region.n, region.ja];

// 経度を、前の点から 180 度より離れないように続ける (日付変更線をまたいでも途切れないように)
export function unwrapLongitudes(coords: number[], start = 0): number[] {
  const out = coords.slice();
  for (let i = start + 2; i < out.length; i += 2) {
    const previous = out[i - 2];
    while (out[i] - previous > 180) out[i] -= 360;
    while (out[i] - previous < -180) out[i] += 360;
  }
  return out;
}

// 平らな座標の並びをいくつか受け取り、全体を囲む範囲を返す。start は各並びで座標が始まる位置
export function boundsOf(lists: number[][], start = 0): Bounds {
  let south = Infinity;
  let north = -Infinity;
  const lons: number[] = [];
  for (const list of lists) {
    for (let i = start; i + 1 < list.length; i += 2) {
      lons.push(((((list[i] + 180) % 360) + 360) % 360) - 180);
      south = Math.min(south, list[i + 1]);
      north = Math.max(north, list[i + 1]);
    }
  }
  // 経度は円なので、点のない一番広い隙間の反対側を範囲にする
  lons.sort((a, b) => a - b);
  let gap = 360 - (lons[lons.length - 1] - lons[0]);
  let west = lons[0];
  let east = lons[lons.length - 1];
  for (let i = 1; i < lons.length; i++) {
    const g = lons[i] - lons[i - 1];
    if (g > gap) {
      gap = g;
      west = lons[i];
      east = lons[i - 1];
    }
  }
  return { south, north, west, east };
}
