// NOAA NOMADS の GRIB filter から GFS の地上10m風を取得する。
// 注意: NOMADS の OpenDAP (DODS) は 2025 年に廃止済み (SCN 25-81)。
// filter エンドポイントで変数・高度を絞った小さな GRIB2 (約 160KB) を取得し、
// 自前のデコーダ (grib2.ts) で展開する。
// 例:
//   https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl
//     ?file=gfs.t06z.pgrb2.1p00.f000&var_UGRD=on&var_VGRD=on
//     &lev_10_m_above_ground=on&dir=%2Fgfs.20260612%2F06%2Fatmos

import { decodeGrib2, Grib2Message } from './grib2';

const FILTER_BASE = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl';
const CLOUD_FILTER_BASE = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl';
const STEP_HOURS = 3; // gfs 1.00° の予報時間刻み
const MAX_FORECAST_HOUR = 384;
const PUBLISH_DELAY_HOURS = 5; // ランが NOMADS に並ぶまでのおおよその遅れ

export interface GfsRecordHeader {
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

export interface GfsFetchResult {
  records: GfsRecord[];
  refTime: string;
  forecastHour: number;
}

// 直近の GFS ラン(00/06/12/18Z)を新しい順に列挙する
export function candidateRuns(now: Date = new Date()): Date[] {
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

export function buildFilterUrl(run: Date, forecastHour: number): string {
  const yyyy = run.getUTCFullYear();
  const mm = String(run.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(run.getUTCDate()).padStart(2, '0');
  const hh = String(run.getUTCHours()).padStart(2, '0');
  const fff = String(forecastHour).padStart(3, '0');
  const params = new URLSearchParams({
    file: `gfs.t${hh}z.pgrb2.1p00.f${fff}`,
    var_UGRD: 'on',
    var_VGRD: 'on',
    lev_10_m_above_ground: 'on',
    dir: `/gfs.${yyyy}${mm}${dd}/${hh}/atmos`,
  });
  return `${FILTER_BASE}?${params.toString()}`;
}

async function fetchBinary(
  url: string,
  timeoutMs = 90_000,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
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

// デコード済み GRIB2 メッセージを内部形式 (cambecc/earth 互換 JSON) に変換する
export function gribMessageToRecord(msg: Grib2Message): GfsRecord {
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

// ランの中で現在時刻に最も近い予報時間
function nearestForecastHour(run: Date): number {
  const hours = (Date.now() - run.getTime()) / 3600_000;
  return Math.max(0, Math.min(MAX_FORECAST_HOUR, Math.round(hours / STEP_HOURS) * STEP_HOURS));
}

export interface GfsCloudResult {
  nx: number;
  ny: number;
  refTime: string;
  forecastTime: number;
  data: Uint8Array; // 1 格子 1 バイトの雲量 (0〜255)。北端から南へ、経度 0 度から東へ
}

// 現在時刻に最も近い全層雲量を 0.25° 格子 (約 1.7MB) で取得する
export async function fetchCurrentGfsCloud(signal?: AbortSignal): Promise<GfsCloudResult> {
  for (const run of candidateRuns()) {
    const yyyymmdd = run.toISOString().slice(0, 10).replace(/-/g, '');
    const hh = String(run.getUTCHours()).padStart(2, '0');
    const fff = String(nearestForecastHour(run)).padStart(3, '0');
    const params = new URLSearchParams({
      file: `gfs.t${hh}z.pgrb2.0p25.f${fff}`,
      var_TCDC: 'on',
      lev_entire_atmosphere: 'on',
      dir: `/gfs.${yyyymmdd}/${hh}/atmos`,
    });
    const bytes = await fetchBinary(`${CLOUD_FILTER_BASE}?${params.toString()}`, undefined, signal);
    if (signal?.aborted) throw new Error('cancelled');
    if (!bytes || !isGrib(bytes)) continue; // ラン未公開時は HTML エラーページが返る

    const msg = decodeGrib2(bytes).find((m) => m.parameterCategory === 6 && m.parameterNumber === 1);
    if (!msg) continue;
    if (msg.scanMode !== 0 || msg.la1 !== 90 || msg.lo1 !== 0) {
      throw new Error(`unexpected grid layout: scan=${msg.scanMode} la1=${msg.la1} lo1=${msg.lo1}`);
    }
    const data = new Uint8Array(msg.data.length);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.round(Math.max(0, Math.min(100, msg.data[i])) * 2.55);
    }
    return { nx: msg.nx, ny: msg.ny, refTime: msg.refTime, forecastTime: msg.forecastTime, data };
  }
  throw new Error('利用可能な GFS ランが NOMADS に見つかりませんでした');
}

// 最新の利用可能なランを探して、現在時刻に最も近い予報時間の地上10m風を取得する。
// signal で中断できる (中断時は 'cancelled' を投げる)
export async function fetchCurrentGfsWind(signal?: AbortSignal): Promise<GfsFetchResult> {
  for (const run of candidateRuns()) {
    const fh = nearestForecastHour(run);
    const bytes = await fetchBinary(buildFilterUrl(run, fh), undefined, signal);
    if (signal?.aborted) throw new Error('cancelled');
    if (!bytes || !isGrib(bytes)) continue; // ラン未公開時は HTML エラーページが返る

    const messages = decodeGrib2(bytes);
    const uMsg = messages.find(
      (m) => m.parameterCategory === 2 && m.parameterNumber === 2 && m.levelType === 103,
    );
    const vMsg = messages.find(
      (m) => m.parameterCategory === 2 && m.parameterNumber === 3 && m.levelType === 103,
    );
    if (!uMsg || !vMsg) continue;
    // 内部形式は北端から南へ・西端から東への走査 (scanMode 0) を前提とする
    if (uMsg.scanMode !== 0 || uMsg.la1 !== 90 || uMsg.lo1 !== 0) {
      throw new Error(`unexpected grid layout: scan=${uMsg.scanMode} la1=${uMsg.la1} lo1=${uMsg.lo1}`);
    }

    return {
      records: [gribMessageToRecord(uMsg), gribMessageToRecord(vMsg)],
      refTime: uMsg.refTime,
      forecastHour: fh,
    };
  }

  throw new Error('利用可能な GFS ランが NOMADS に見つかりませんでした');
}
