// 過去の時刻を見るスライダーの計算。画面の計算から切り離して検証できるよう、DOM に依存しない
export const TIME_RANGE_MINUTES = 24 * 60;
export const TIME_STEP_MINUTES = 15;
export const MAX_DAYS_BACK = 3; // 日付のメニューで選べるのは 3 日前まで
const DAY_MS = TIME_RANGE_MINUTES * 60_000;

// daysBack 日前の 0 時。offsetSeconds は時計の時差で、null はパソコンの時刻
export function dayStart(daysBack: number, now: number, offsetSeconds: number | null): number {
  if (offsetSeconds === null) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - daysBack);
    return date.getTime();
  }
  const shift = offsetSeconds * 1000;
  return Math.floor((now + shift) / DAY_MS) * DAY_MS - daysBack * DAY_MS - shift;
}

// スライダーの左端の時刻。今日は今から 24 時間前まで、過去の日はその日の 0 時から
export function windowStart(daysBack: number, now: number, offsetSeconds: number | null): number {
  return daysBack === 0 ? now - DAY_MS : dayStart(daysBack, now, offsetSeconds);
}

// スライダーの右端の値 (左端からの分)。今日の右端は今。過去の日は翌日の 0 時を含めない
export function windowMax(daysBack: number): number {
  return daysBack === 0 ? TIME_RANGE_MINUTES : TIME_RANGE_MINUTES - TIME_STEP_MINUTES;
}

// 日を選んだときのスライダーの値。見ている時刻の時と分を保つ。今日は今より先へは行かない
export function sliderValueForDay(daysBack: number, viewAt: number, now: number, offsetSeconds: number | null): number {
  const minutesIntoDay = (viewAt - dayStart(0, viewAt, offsetSeconds)) / 60_000;
  const step = TIME_STEP_MINUTES;
  if (daysBack === 0) {
    const target = Math.min(now, dayStart(0, now, offsetSeconds) + minutesIntoDay * 60_000);
    return TIME_RANGE_MINUTES - Math.round((now - target) / 60_000 / step) * step;
  }
  return Math.min(windowMax(daysBack), Math.round(minutesIntoDay / step) * step);
}

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
