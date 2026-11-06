// ツアーの時刻の計算。画面の計算から切り離して検証できるよう、ほかに依存しない
// 地方時 hour の、今日 (UTC の日付) の日時。経度 15 度で 1 時間ずれる
export function localHourToDate(hour: number, lon: number, now = new Date()): Date {
  const utcHours = hour - lon / 15;
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  date.setTime(date.getTime() + utcHours * 3600_000);
  return date;
}
