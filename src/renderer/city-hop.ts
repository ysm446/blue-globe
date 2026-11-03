// 地域ビューで、矢印キーの向きにある次の都市を選ぶ。
// 画面の向き (方角) に合わせて ↑ を正面とし、押した向きに近く、近い都市を選ぶ
import { DEG, separationDegrees, wrapDegrees, type LonLat } from './math.ts';

export type HopDirection = 'up' | 'down' | 'left' | 'right';

const DIRECTION_OFFSET: Record<HopDirection, number> = { up: 0, right: 90, down: 180, left: -90 };
const MAX_OFFSET = 50; // 押した向きから左右にこの角度までを候補にする
const OFFSET_PENALTY = 2; // 向きが 45° ずれると、距離が 3 倍の都市と同じ扱いになる
const MIN_SEPARATION = 0.05; // 出発点とほぼ同じ場所の都市 (今いる都市) は選ばない (約 5km)

// from から to へ向かう方位 (度)。0 が北、90 が東
export function bearingDegrees(from: LonLat, to: LonLat): number {
  const dLon = (to.lon - from.lon) * DEG;
  const y = Math.sin(dLon) * Math.cos(to.lat * DEG);
  const x =
    Math.cos(from.lat * DEG) * Math.sin(to.lat * DEG) -
    Math.sin(from.lat * DEG) * Math.cos(to.lat * DEG) * Math.cos(dLon);
  return Math.atan2(y, x) / DEG;
}

// candidates の中から選ぶ。maxDistance (度) より遠い都市は選ばない。押した向きに候補がなければ null
export function pickCityInDirection<T extends LonLat>(
  origin: LonLat,
  heading: number,
  direction: HopDirection,
  candidates: readonly T[],
  maxDistance = 180,
): T | null {
  const wanted = heading + DIRECTION_OFFSET[direction];
  let best: T | null = null;
  let bestCost = Infinity;
  for (const city of candidates) {
    const distance = separationDegrees(origin, city);
    if (distance < MIN_SEPARATION || distance > maxDistance) continue;
    const offset = Math.abs(wrapDegrees(bearingDegrees(origin, city) - wanted));
    if (offset > MAX_OFFSET) continue;
    const cost = distance * (1 + OFFSET_PENALTY * (offset / 45) ** 2);
    if (cost < bestCost) {
      best = city;
      bestCost = cost;
    }
  }
  return best;
}
