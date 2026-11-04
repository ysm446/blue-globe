// 過去の時刻を見るスライダーの計算。画面の計算から切り離して検証できるよう、DOM に依存しない
export const TIME_RANGE_MINUTES = 24 * 60;
export const TIME_STEP_MINUTES = 15;

// 何分前かから、見る時刻を求める。0 は今で、null を返す
export function viewTimeAt(minutesBefore: number, now: number = Date.now()): Date | null {
  return minutesBefore === 0 ? null : new Date(now - minutesBefore * 60_000);
}

// value を goal へ、行き過ぎずになめらかに近づける (臨界減衰のばね)。velocity は値の変わる速さで、
// 次の呼び出しへ引き継ぐ。goal が動き続けても (スライダーをドラッグしている間) 速さが途切れない。
// smoothTime はおおよそ追いつくまでの時間の目安
export function smoothTowards(
  value: number,
  goal: number,
  velocity: number,
  smoothTime: number,
  dt: number,
): { value: number; velocity: number } {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x); // exp(-x) の近似
  const change = value - goal;
  const temp = (velocity + omega * change) * dt;
  const next = goal + (change + temp) * decay;
  // 速さが残っていると goal を越えることがある。越えたら goal で止める
  if (change !== 0 && Math.sign(next - goal) !== Math.sign(change)) return { value: goal, velocity: 0 };
  return { value: next, velocity: (velocity - omega * temp) * decay };
}

export function offsetLabel(minutesBefore: number): string {
  if (minutesBefore === 0) return 'いま';
  const hours = Math.floor(minutesBefore / 60);
  const minutes = minutesBefore % 60;
  return `${hours > 0 ? `${hours}時間` : ''}${minutes > 0 ? `${minutes}分` : ''}前`;
}
