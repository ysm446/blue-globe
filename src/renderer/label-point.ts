// 範囲 (山脈、砂漠など) の名前を置く点。重心は、細長く曲がった範囲 (アンデス山脈など) では範囲の外に出るので、
// 範囲の内側で縁から一番遠い点を求める (polylabel と同じ考え方。マス目を分けながら、縁から遠そうなマスだけを調べる)。
// DOM に依存しない
import { unwrapLongitudes } from './highlight-data.ts';

const PRECISION_DEG = 0.05; // これより細かくは探さない (約 5km)

export interface LonLatPoint {
  lon: number;
  lat: number;
}

type Ring = Array<[number, number]>; // 平面に直した [x, y]

// 輪の面積 (平面の座標。符号は向き)
function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

// 点から多角形の縁までの距離。内側なら正、外側なら負
function signedDistance(x: number, y: number, rings: Ring[]): number {
  let inside = false;
  let minSq = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[j];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq)) : 0;
      const ex = ax + t * dx - x;
      const ey = ay + t * dy - y;
      minSq = Math.min(minSq, ex * ex + ey * ey);
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minSq);
}

interface Cell {
  x: number;
  y: number;
  half: number;
  distance: number;
  potential: number; // このマスの中で取りうる距離の上限
}

function makeCell(x: number, y: number, half: number, rings: Ring[]): Cell {
  const distance = signedDistance(x, y, rings);
  return { x, y, half, distance, potential: distance + half * Math.SQRT2 };
}

// 1 つの多角形 (最初の輪が外周、残りが穴) の内側で、縁から一番遠い点
function poleOfInaccessibility(rings: Ring[]): [number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of rings[0]) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const size = Math.min(maxX - minX, maxY - minY);
  if (size <= 0) return [minX, minY];
  let half = size / 2;
  const queue: Cell[] = [];
  for (let x = minX; x < maxX; x += size) {
    for (let y = minY; y < maxY; y += size) queue.push(makeCell(x + half, y + half, half, rings));
  }
  // 最初の候補は外接する四角の中心
  let best = makeCell((minX + maxX) / 2, (minY + maxY) / 2, 0, rings);
  while (queue.length) {
    // 上限の一番大きいマスから調べる (件数は多くないので、毎回探す)
    let index = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].potential > queue[index].potential) index = i;
    const cell = queue.splice(index, 1)[0];
    if (cell.distance > best.distance) best = cell;
    if (cell.potential - best.distance <= PRECISION_DEG) continue;
    half = cell.half / 2;
    queue.push(
      makeCell(cell.x - half, cell.y - half, half, rings),
      makeCell(cell.x + half, cell.y - half, half, rings),
      makeCell(cell.x - half, cell.y + half, half, rings),
      makeCell(cell.x + half, cell.y + half, half, rings),
    );
  }
  return [best.x, best.y];
}

// 穴の輪を、外周の経度の近くへ 360 度ずつずらす
function nearLongitude(coords: number[], lon0: number): number[] {
  const shift = Math.round((lon0 - coords[0]) / 360) * 360;
  return shift === 0 ? coords : coords.map((value, index) => (index % 2 === 0 ? value + shift : value));
}

// polygons は多角形の並びで、多角形は輪 (経度, 緯度を交互に並べた配列) の並び。最初の輪が外周。
// 一番大きい多角形の内側に置く。経度は日付変更線をまたいでも続くように直し、緯度で横の縮みを補う
export function labelPoint(polygons: number[][][]): LonLatPoint {
  let best: { rings: Ring[]; area: number; lat0: number; lon0: number } | null = null;
  for (const polygon of polygons) {
    const outer = unwrapLongitudes(polygon[0]);
    const lon0 = outer[0];
    let latSum = 0;
    for (let i = 1; i < outer.length; i += 2) latSum += outer[i];
    const lat0 = latSum / (outer.length / 2);
    const scale = Math.cos((lat0 * Math.PI) / 180);
    const rings = polygon.map((coords, index) => {
      const unwrapped = index === 0 ? outer : nearLongitude(unwrapLongitudes(coords), lon0);
      const ring: Ring = [];
      for (let i = 0; i < unwrapped.length; i += 2) ring.push([(unwrapped[i] - lon0) * scale, unwrapped[i + 1]]);
      return ring;
    });
    const area = Math.abs(ringArea(rings[0]));
    if (!best || area > best.area) best = { rings, area, lat0, lon0 };
  }
  if (!best) return { lon: 0, lat: 0 };
  const [x, y] = poleOfInaccessibility(best.rings);
  const scale = Math.cos((best.lat0 * Math.PI) / 180);
  let lon = x / scale + best.lon0;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lon, lat: y };
}
