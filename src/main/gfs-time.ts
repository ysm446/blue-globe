// GFS のランと予報時間の選び方、過去の時刻の扱い。通信から切り離して検証できるよう、他に依存しない
const STEP_HOURS = 3; // gfs 1.00° の予報時間刻み
const MAX_FORECAST_HOUR = 384;
const PUBLISH_DELAY_HOURS = 5; // ランが NOMADS に並ぶまでのおおよその遅れ
const HOUR_MS = 3600_000;
export const PAST_LIMIT_HOURS = 25; // 画面は 24 時間まで。操作の間に少し過ぎても受け付ける

// target の時点を含むラン (00/06/12/18Z) を新しい順に列挙する。まだ公開されていないランは含めない
export function candidateRuns(target: Date, now: Date = new Date()): Date[] {
  const d = new Date(Math.min(target.getTime(), now.getTime() - PUBLISH_DELAY_HOURS * HOUR_MS));
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(d.getUTCHours() / 6) * 6);
  const runs: Date[] = [];
  for (let i = 0; i < 4; i++) {
    runs.push(new Date(t));
    t -= 6 * HOUR_MS;
  }
  return runs;
}

// ランの中で target に最も近い予報時間
export function nearestForecastHour(run: Date, target: Date): number {
  const hours = (target.getTime() - run.getTime()) / HOUR_MS;
  return Math.max(0, Math.min(MAX_FORECAST_HOUR, Math.round(hours / STEP_HOURS) * STEP_HOURS));
}

// target に最も近い 3 時間の区切りを YYYYMMDDHH (UTC) で表す。保存するファイル名に使う
export function nearestStepStamp(target: Date): string {
  const step = STEP_HOURS * HOUR_MS;
  const iso = new Date(Math.round(target.getTime() / step) * step).toISOString();
  return iso.slice(0, 13).replace(/[-T]/g, '');
}

// 画面から受け取った過去の時刻を確かめる
export function parsePastTime(value: unknown, now: Date = new Date()): Date {
  const time = new Date(typeof value === 'string' ? value : Number.NaN);
  const age = now.getTime() - time.getTime();
  if (Number.isNaN(age) || age < -60_000 || age > PAST_LIMIT_HOURS * HOUR_MS) {
    throw new Error(`unknown time: ${String(value)}`);
  }
  return time;
}
