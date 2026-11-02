// NOAA NOMADS の GRIB filter から GFS の地上10m風と全層雲量を取得する。
// 注意: NOMADS の OpenDAP (DODS) は 2025 年に廃止済み (SCN 25-81)。
// filter エンドポイントで変数・高度を絞った小さな GRIB2 を取得し、
// 自前のデコーダ (grib2.ts) で展開する。
// 例:
//   https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl
//     ?file=gfs.t06z.pgrb2.1p00.f000&var_UGRD=on&var_VGRD=on
//     &lev_10_m_above_ground=on&dir=%2Fgfs.20260612%2F06%2Fatmos

import { decodeGrib2, Grib2Message } from './grib2';

const FILTER_BASE = 'https://nomads.ncep.noaa.gov/cgi-bin';
const STEP_HOURS = 3; // gfs 1.00° の予報時間刻み
const MAX_FORECAST_HOUR = 384;
const PUBLISH_DELAY_HOURS = 5; // ランが NOMADS に並ぶまでのおおよその遅れ

interface GfsRecordHeader {
  discipline: number;
  parameterCategory: number;
  parameterNumber: number;
  nx: number;
  ny: number;
  lo1: number;
  la1: number;
  dx: number;
  dy: number;
  refTime: string;
  forecastTime: number;
}

export interface GfsRecord {
  header: GfsRecordHeader;
  data: number[];
}

export interface GfsCloudResult {
  nx: number;
  ny: number;
  refTime: string;
  forecastTime: number;
  data: Uint8Array; // 1 格子 1 バイトの雲量 (0〜255)。北端から南へ、経度 0 度から東へ
}

// 直近の GFS ラン(00/06/12/18Z)を新しい順に列挙する
function candidateRuns(now: Date = new Date()): Date[] {
  const base = now.getTime() - PUBLISH_DELAY_HOURS * 3600_000;
  const d = new Date(base);
  let t = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    Math.floor(d.getUTCHours() / 6) * 6,
  );
  const runs: Date[] = [];
  for (let i = 0; i < 4; i++) {
    runs.push(new Date(t));
    t -= 6 * 3600_000;
  }
  return runs;
}

// ランの中で現在時刻に最も近い予報時間
function nearestForecastHour(run: Date): number {
  const hours = (Date.now() - run.getTime()) / 3600_000;
  return Math.max(0, Math.min(MAX_FORECAST_HOUR, Math.round(hours / STEP_HOURS) * STEP_HOURS));
}

function filterUrl(grid: '1p00' | '0p25', run: Date, variables: Record<string, string>): string {
  const yyyymmdd = run.toISOString().slice(0, 10).replace(/-/g, '');
  const hh = String(run.getUTCHours()).padStart(2, '0');
  const fff = String(nearestForecastHour(run)).padStart(3, '0');
  const params = new URLSearchParams({
    file: `gfs.t${hh}z.pgrb2.${grid}.f${fff}`,
    ...variables,
    dir: `/gfs.${yyyymmdd}/${hh}/atmos`,
  });
  return `${FILTER_BASE}/filter_gfs_${grid}.pl?${params.toString()}`;
}

async function fetchBinary(url: string, signal: AbortSignal): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

function isGrib(bytes: Uint8Array): boolean {
  return (
    bytes.length > 16 &&
    bytes[0] === 0x47 && // G
    bytes[1] === 0x52 && // R
    bytes[2] === 0x49 && // I
    bytes[3] === 0x42 // B
  );
}

// 内部形式は北端から南へ・西端から東への走査 (scanMode 0) を前提とする
function assertExpectedGrid(msg: Grib2Message): void {
  if (msg.scanMode !== 0 || msg.la1 !== 90 || msg.lo1 !== 0) {
    throw new Error(`unexpected grid layout: scan=${msg.scanMode} la1=${msg.la1} lo1=${msg.lo1}`);
  }
}

// 最新の利用可能なランを探す。read が null を返すと、1 つ古いランを試す。
// signal で中断できる (中断時は 'cancelled' を投げる)
async function fetchFromLatestRun<T>(
  urlOf: (run: Date) => string,
  read: (messages: Grib2Message[]) => T | null,
  signal: AbortSignal,
): Promise<T> {
  for (const run of candidateRuns()) {
    const bytes = await fetchBinary(urlOf(run), signal);
    if (signal.aborted) throw new Error('cancelled');
    if (!bytes || !isGrib(bytes)) continue; // ラン未公開時は HTML エラーページが返る
    const result = read(decodeGrib2(bytes));
    if (result !== null) return result;
  }
  throw new Error('利用可能な GFS ランが NOMADS に見つかりませんでした');
}

// デコード済み GRIB2 メッセージを内部形式 (cambecc/earth 互換 JSON) に変換する
function gribMessageToRecord(msg: Grib2Message): GfsRecord {
  return {
    header: {
      discipline: msg.discipline,
      parameterCategory: msg.parameterCategory,
      parameterNumber: msg.parameterNumber,
      nx: msg.nx,
      ny: msg.ny,
      lo1: msg.lo1,
      la1: msg.la1,
      dx: msg.dx,
      dy: msg.dy,
      refTime: msg.refTime,
      forecastTime: msg.forecastTime,
    },
    data: Array.from(msg.data),
  };
}

// 現在時刻に最も近い全層雲量を 0.25° 格子 (約 1.7MB) で取得する
export function fetchCurrentGfsCloud(signal: AbortSignal): Promise<GfsCloudResult> {
  return fetchFromLatestRun(
    (run) => filterUrl('0p25', run, { var_TCDC: 'on', lev_entire_atmosphere: 'on' }),
    (messages) => {
      const msg = messages.find((m) => m.parameterCategory === 6 && m.parameterNumber === 1);
      if (!msg) return null;
      assertExpectedGrid(msg);
      const data = new Uint8Array(msg.data.length);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.round(Math.max(0, Math.min(100, msg.data[i])) * 2.55);
      }
      return { nx: msg.nx, ny: msg.ny, refTime: msg.refTime, forecastTime: msg.forecastTime, data };
    },
    signal,
  );
}

// 現在時刻に最も近い予報時間の地上10m風を約 160KB で取得する
export function fetchCurrentGfsWind(signal: AbortSignal): Promise<GfsRecord[]> {
  return fetchFromLatestRun(
    (run) => filterUrl('1p00', run, { var_UGRD: 'on', var_VGRD: 'on', lev_10_m_above_ground: 'on' }),
    (messages) => {
      const windMessage = (parameterNumber: number): Grib2Message | undefined =>
        messages.find((m) => m.parameterCategory === 2 && m.parameterNumber === parameterNumber && m.levelType === 103);
      const uMsg = windMessage(2);
      const vMsg = windMessage(3);
      if (!uMsg || !vMsg) return null;
      assertExpectedGrid(uMsg);
      return [gribMessageToRecord(uMsg), gribMessageToRecord(vMsg)];
    },
    signal,
  );
}
