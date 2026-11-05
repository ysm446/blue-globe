// Python バックエンド (.venv の uvicorn) の起動と呼び出し。
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const HEALTH_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 12_000;

let child: ChildProcess | null = null;
let baseUrl = '';
let starting: Promise<void> | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function launch(root: string, dataDir: string): Promise<void> {
  const python = path.join(root, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) {
    throw new Error('.venv が見つかりません。start.bat から起動してください');
  }
  const port = await freePort();
  const logDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'backend.log'), 'w');
  // stdin は親の生存確認に使う。Electron が落ちると閉じ、バックエンドが終了する
  child = spawn(
    python,
    ['-m', 'uvicorn', 'server.api:app', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: root,
      stdio: ['pipe', log, log],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        BLUE_GLOBE_WATCH_STDIN: '1',
        BLUE_GLOBE_DATA_DIR: dataDir,
      },
    },
  );
  fs.closeSync(log);
  child.on('exit', () => {
    child = null;
  });
  baseUrl = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!child) throw new Error('バックエンドが起動直後に終了しました。data/logs/backend.log を確認してください');
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // 起動待ち
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('バックエンドの起動がタイムアウトしました');
}

export function startBackend(root: string, dataDir: string): Promise<void> {
  starting ??= launch(root, dataDir);
  return starting;
}

export async function backendRequest(pathname: string, init?: RequestInit): Promise<unknown> {
  if (!starting) throw new Error('バックエンドが起動していません');
  await starting;
  const res = await fetch(`${baseUrl}${pathname}`, init);
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  if (!res.ok) {
    throw new Error(typeof body?.detail === 'string' ? body.detail : `HTTP ${res.status}`);
  }
  return body;
}

// stdin を閉じて正常終了を待つ。応答がなければプロセスツリーごと止める
export function stopBackend(): Promise<void> {
  const target = child;
  if (!target) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (target.pid) spawnSync('taskkill', ['/PID', String(target.pid), '/T', '/F']);
      resolve();
    }, STOP_TIMEOUT_MS);
    target.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    target.stdin?.end();
  });
}
