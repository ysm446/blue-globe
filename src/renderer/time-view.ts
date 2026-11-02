// 過去の時刻を見るスライダーの計算。画面の計算から切り離して検証できるよう、DOM に依存しない
export const TIME_RANGE_MINUTES = 24 * 60;
export const TIME_STEP_MINUTES = 15;

// 何分前かから、見る時刻を求める。0 は今で、null を返す
export function viewTimeAt(minutesBefore: number, now: number = Date.now()): Date | null {
  return minutesBefore === 0 ? null : new Date(now - minutesBefore * 60_000);
}

export function offsetLabel(minutesBefore: number): string {
  if (minutesBefore === 0) return 'いま';
  const hours = Math.floor(minutesBefore / 60);
  const minutes = minutesBefore % 60;
  return `${hours > 0 ? `${hours}時間` : ''}${minutes > 0 ? `${minutes}分` : ''}前`;
}
