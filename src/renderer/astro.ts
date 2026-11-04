// 太陽・月・星の方向を日時から求める。結果は地球に固定した経度・緯度で表し、
// その地点の真上に天体がある、という形で扱う。天文年鑑の低精度式で、表示には十分な精度。
import { clamp, DEG, dot, separationDegrees, wrapDegrees, type LonLat, type Vec3 } from './math.ts';

const J2000_MS = Date.UTC(2000, 0, 1, 12);
const DAY_MS = 86_400_000;
const SUNRISE_ELEVATION = -0.833; // 日の出・日の入りの太陽の中心の高度。大気差と視半径の分だけ地平線の下
const SUN_EVENT_STEP_MS = 10 * 60_000; // 太陽高度を調べる間隔。この間に 2 回またぐことはない
const SUN_EVENT_REFINE_STEPS = 12; // 間隔を半分にしていく回数 (10 分 → 約 0.15 秒)

function daysSinceJ2000(date: Date): number {
  return (date.getTime() - J2000_MS) / DAY_MS;
}

// グリニッジ恒星時 (度)。赤経からこの値を引くと経度になる
export function siderealDegrees(date: Date): number {
  return 280.46061837 + 360.98564736629 * daysSinceJ2000(date);
}

function equatorialToLonLat(ra: number, dec: number, date: Date): LonLat {
  return { lon: wrapDegrees(ra - siderealDegrees(date)), lat: dec };
}

// 太陽直下点。誤差は角度で約 0.01°
export function subsolarPoint(date: Date): LonLat {
  const n = daysSinceJ2000(date);
  const meanLon = 280.46 + 0.9856474 * n;
  const anomaly = (357.528 + 0.9856003 * n) * DEG;
  const eclipticLon = (meanLon + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * DEG;
  const obliquity = (23.439 - 4e-7 * n) * DEG;
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLon)) / DEG;
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLon), Math.cos(eclipticLon)) / DEG;
  return equatorialToLonLat(ra, dec, date);
}

export interface SunEvent {
  kind: 'sunrise' | 'sunset';
  at: Date;
}

// place で from から to までの間に太陽が昇る時刻と沈む時刻を、早い順に返す。白夜や極夜では空
export function sunEvents(place: LonLat, from: Date, to: Date): SunEvent[] {
  const aboveHorizon = (ms: number): boolean =>
    90 - separationDegrees(place, subsolarPoint(new Date(ms))) > SUNRISE_ELEVATION;
  const events: SunEvent[] = [];
  const end = to.getTime();
  let start = from.getTime();
  let wasUp = aboveHorizon(start);
  while (start < end) {
    const next = Math.min(start + SUN_EVENT_STEP_MS, end);
    const isUp = aboveHorizon(next);
    if (isUp !== wasUp) {
      let [before, after] = [start, next];
      for (let i = 0; i < SUN_EVENT_REFINE_STEPS; i++) {
        const middle = (before + after) / 2;
        if (aboveHorizon(middle) === wasUp) before = middle;
        else after = middle;
      }
      events.push({ kind: isUp ? 'sunrise' : 'sunset', at: new Date((before + after) / 2) });
    }
    start = next;
    wasUp = isUp;
  }
  return events;
}

// 地球を照らす月明かりの強さ。満月を 1 とする。sun と moon は地球から見た太陽と月の方向 (単位ベクトル)。
// 月の明るさは照らされている割合に比例せず、半月で満月の約 1/10 しかない。割合の 3 乗 (半月で 1/8) で近づける
export function moonlightStrength(sun: Vec3, moon: Vec3): number {
  const lit = (1 - clamp(dot(sun, moon), -1, 1)) / 2;
  return lit ** 3;
}

// 月直下点 (地球中心から見た方向)。誤差は黄経で約 0.3°
export function sublunarPoint(date: Date): LonLat {
  const t = daysSinceJ2000(date) / 36525;
  const s = (a: number, b: number): number => Math.sin((a + b * t) * DEG);
  const lambda =
    218.32 + 481267.881 * t + 6.29 * s(135.0, 477198.87) - 1.27 * s(259.3, -413335.36) +
    0.66 * s(235.7, 890534.22) + 0.21 * s(269.9, 954397.74) - 0.19 * s(357.5, 35999.05) -
    0.11 * s(186.5, 966404.03);
  const beta =
    5.13 * s(93.3, 483202.02) + 0.28 * s(228.2, 960400.89) - 0.28 * s(318.3, 6003.15) -
    0.17 * s(217.6, -407332.21);
  const obliquity = (23.439 - 1.3e-2 * t) * DEG;
  const l = lambda * DEG;
  const b = beta * DEG;
  const x = Math.cos(b) * Math.cos(l);
  const y = Math.cos(obliquity) * Math.cos(b) * Math.sin(l) - Math.sin(obliquity) * Math.sin(b);
  const z = Math.sin(obliquity) * Math.cos(b) * Math.sin(l) + Math.cos(obliquity) * Math.sin(b);
  return equatorialToLonLat(Math.atan2(y, x) / DEG, Math.asin(z) / DEG, date);
}

// 0 等星の明るさ (画面の白を 1 とした値)。6 等星がかろうじて見える程度に合わせた表示上の倍率
const ZERO_MAGNITUDE_INTENSITY = 12;

// 等級から明るさへ。5 等級差でちょうど 100 倍 (ポグソンの式)
export function starIntensity(magnitude: number): number {
  return ZERO_MAGNITUDE_INTENSITY * 10 ** (-0.4 * magnitude);
}
