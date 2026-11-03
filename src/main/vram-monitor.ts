// 使っている VRAM の量。WebGL からは取れないので、Windows のパフォーマンスカウンター
// (タスクマネージャーの「専用 GPU メモリ」と同じ値) を typeperf で読む。描画は GPU プロセスが行うので、その分を数える
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { app } from 'electron';

const SAMPLE_SECONDS = 2;

let typeperf: ChildProcess | null = null;

// 読めないときは onUsage に null を渡す
export function startVramMonitor(onUsage: (bytes: number | null) => void): void {
  if (typeperf) return;
  const gpuPid = app.getAppMetrics().find((metric) => metric.type === 'GPU')?.pid;
  if (process.platform !== 'win32' || gpuPid === undefined) {
    onUsage(null);
    return;
  }
  // GPU が複数あると同じ pid の項目が GPU ごとに出るので、合計する
  const counter = `\\GPU Process Memory(pid_${gpuPid}_*)\\Dedicated Usage`;
  const child = spawn('typeperf', [counter, '-si', String(SAMPLE_SECONDS)], { windowsHide: true });
  typeperf = child;
  child.on('error', () => onUsage(null));
  // 止めていないのに終わったのは、カウンターを読めなかったとき
  child.on('exit', () => {
    if (typeperf !== child) return;
    typeperf = null;
    onUsage(null);
  });
  // 1 行目は項目名。2 行目からは "時刻","値","値",... が届く
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (!line.startsWith('"') || line.startsWith('"(PDH-CSV')) return;
    const values = line.split(',').slice(1).map((cell) => Number(cell.replaceAll('"', '')));
    const valid = values.filter(Number.isFinite);
    onUsage(valid.length > 0 ? valid.reduce((sum, value) => sum + value, 0) : null);
  });
}

export function stopVramMonitor(): void {
  typeperf?.kill();
  typeperf = null;
}
