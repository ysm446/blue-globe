// 星座の線を表示し始めるときの、線の伸ばし方の計算。画面の計算から切り離して検証できるよう、Three.js に依存しない。
// 見ている方向に近い星座から順に、少しずつずらして描き始める。1 つの星座の中では、線を 1 本ずつ星から星へ一定の速さで伸ばす
import { clamp, DEG, dot, type Vec3 } from './math.ts';

const DEGREES_PER_SECOND = 40; // 線の伸びる速さ (空の角度)
const STAGGER_SECONDS = 0.12; // 次の星座が描き始めるまでの間

export interface RevealSegment {
  start: number; // 伸び始める時刻 (秒)
  duration: number; // 伸びきるまでの時間 (秒)
}

const angleBetween = (a: Vec3, b: Vec3): number => Math.acos(clamp(dot(a, b), -1, 1));

function centroid(lines: readonly (readonly Vec3[])[]): Vec3 {
  const sum = [0, 0, 0];
  for (const line of lines) for (const point of line) for (let i = 0; i < 3; i++) sum[i] += point[i];
  const length = Math.hypot(sum[0], sum[1], sum[2]) || 1;
  return [sum[0] / length, sum[1] / length, sum[2] / length];
}

// constellations は星座ごとの、線ごとの星の単位ベクトル。view は見ている方向の単位ベクトル (同じ座標)。
// 返すのは線分ごとの伸ばし方で、星座、線、線分の順に並ぶ
export function revealSchedule(constellations: readonly (readonly (readonly Vec3[])[])[], view: Vec3): RevealSegment[] {
  const order = constellations
    .map((lines, index) => ({ index, angle: angleBetween(centroid(lines), view) }))
    .sort((a, b) => a.angle - b.angle);
  const rank = new Array<number>(constellations.length);
  order.forEach(({ index }, i) => (rank[index] = i));

  const segments: RevealSegment[] = [];
  constellations.forEach((lines, index) => {
    let time = rank[index] * STAGGER_SECONDS;
    for (const line of lines) {
      for (let i = 0; i + 1 < line.length; i++) {
        const duration = angleBetween(line[i], line[i + 1]) / DEG / DEGREES_PER_SECOND;
        segments.push({ start: time, duration });
        time += duration;
      }
    }
  });
  return segments;
}
