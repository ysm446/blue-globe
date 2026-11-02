// 計算の共通部品。DOM と Three.js に依存しない。
// node --test が直接読むファイルからは、拡張子付き ('./math.ts') で import する
export const DEG = Math.PI / 180;

export type Vec3 = readonly [number, number, number];

export interface LonLat {
  lat: number;
  lon: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// -180 以上 180 未満へ折り返す
export function wrapDegrees(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}

// 動き始めと終わりをなめらかにする。t は 0〜1
export function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  return easeInOut(clamp((x - edge0) / (edge1 - edge0), 0, 1));
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// 球面上の 2 点の角度
export function separationDegrees(a: LonLat, b: LonLat): number {
  const cosine =
    Math.sin(a.lat * DEG) * Math.sin(b.lat * DEG) +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((a.lon - b.lon) * DEG);
  return Math.acos(clamp(cosine, -1, 1)) / DEG;
}
