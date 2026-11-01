import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fetchCurrentGfsCloud, fetchCurrentGfsWind } from './nomads';
import { backendRequest, startBackend, stopBackend } from './backend';

const WIND_MAX_AGE_MS = 3 * 3600_000; // GFS 1.0° は 3 時間刻み
const WIND_FETCH_TIMEOUT_MS = 30_000;

// 動作検証時に実際の設定を汚さないよう、環境変数で差し替えられる
function dataDir(): string {
  return process.env.WEATHER_NEWS_DATA_DIR || path.join(app.getAppPath(), 'data');
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// 風データの探索順: 新しいキャッシュ → NOMADS → 古いキャッシュ → アプリ同梱サンプル
ipcMain.handle('wind:get', async () => {
  const cachePath = path.join(dataDir(), 'wind-cache', 'current-wind.json');
  const cacheAge = fs.existsSync(cachePath)
    ? Date.now() - fs.statSync(cachePath).mtimeMs
    : Number.POSITIVE_INFINITY;
  if (cacheAge < WIND_MAX_AGE_MS) return { source: 'cache', records: readJson(cachePath) };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WIND_FETCH_TIMEOUT_MS);
  try {
    const result = await fetchCurrentGfsWind(controller.signal);
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(result.records));
    return { source: 'nomads', records: result.records };
  } catch (err) {
    console.error('wind fetch failed', err);
  } finally {
    clearTimeout(timer);
  }
  if (Number.isFinite(cacheAge)) return { source: 'stale', records: readJson(cachePath) };
  return {
    source: 'sample',
    records: readJson(path.join(app.getAppPath(), 'assets', 'data', 'current-wind.json')),
  };
});

// GFS の雲量を data/cloud-cache に用意する。新しいキャッシュ → NOMADS → 古いキャッシュの順に探す
async function ensureGfsCloud(): Promise<boolean> {
  const metaPath = path.join(dataDir(), 'cloud-cache', 'current-cloud.json');
  const binPath = path.join(dataDir(), 'cloud-cache', 'current-cloud.bin');
  const cached = fs.existsSync(metaPath) && fs.existsSync(binPath);
  if (cached && Date.now() - fs.statSync(binPath).mtimeMs < WIND_MAX_AGE_MS) return true;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WIND_FETCH_TIMEOUT_MS);
  try {
    const { data, ...meta } = await fetchCurrentGfsCloud(controller.signal);
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, data);
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    return true;
  } catch (err) {
    console.error('cloud fetch failed', err);
    return cached;
  } finally {
    clearTimeout(timer);
  }
}

// 衛星の雲マップを取れないときは、GFS だけで表示する。経度 0 度始まりなので -180 度始まりへ回す
function readGfsFallback(): unknown {
  const meta = readJson(path.join(dataDir(), 'cloud-cache', 'current-cloud.json')) as {
    nx: number;
    ny: number;
    refTime: string;
    forecastTime: number;
  };
  const raw = fs.readFileSync(path.join(dataDir(), 'cloud-cache', 'current-cloud.bin'));
  const data = new Uint8Array(raw.length);
  const half = meta.nx / 2;
  for (let y = 0; y < meta.ny; y++) {
    const row = y * meta.nx;
    data.set(raw.subarray(row + half, row + meta.nx), row);
    data.set(raw.subarray(row, row + half), row + half);
  }
  const validMs = new Date(meta.refTime).getTime() + meta.forecastTime * 3600_000;
  return { source: 'gfs', nx: meta.nx, ny: meta.ny, validTime: new Date(validMs).toISOString(), stale: false, data };
}

ipcMain.handle('clouds:get', async () => {
  const hasGfs = await ensureGfsCloud();
  try {
    const sat = (await backendRequest('/clouds/satellite')) as {
      nx: number;
      ny: number;
      valid_time: string;
      stale: boolean;
    };
    const data = new Uint8Array(fs.readFileSync(path.join(dataDir(), 'cloud-cache', 'current-sat.bin')));
    return { source: 'satellite', nx: sat.nx, ny: sat.ny, validTime: sat.valid_time, stale: sat.stale, data };
  } catch (err) {
    console.error('satellite cloud failed', err);
  }
  return hasGfs ? readGfsFallback() : null;
});

// 同梱の地球の画像。名前は固定の一覧からだけ受け付ける
const TEXTURES: Record<string, string> = {
  'earth-day': 'earth-day.jpg',
  'earth-night': 'earth-night.jpg',
};

ipcMain.handle('texture:get', (_event, name: string) => {
  const file = Object.hasOwn(TEXTURES, name) ? TEXTURES[name] : null;
  if (!file) throw new Error(`unknown texture: ${name}`);
  return new Uint8Array(fs.readFileSync(path.join(app.getAppPath(), 'assets', 'textures', file)));
});

const jsonPut = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

ipcMain.handle('news:get', () => backendRequest('/news'));
ipcMain.handle('settings:get', () => backendRequest('/settings'));
ipcMain.handle('settings:set', (_event, settings: unknown) =>
  backendRequest('/settings', jsonPut(settings)),
);
ipcMain.handle('mode:set', (_event, mode: string) =>
  backendRequest('/settings/mode', jsonPut({ mode })),
);
ipcMain.handle('graphics:set', (_event, graphics: unknown) =>
  backendRequest('/settings/graphics', jsonPut(graphics)),
);
ipcMain.handle('locations:search', (_event, query: string) =>
  backendRequest(`/locations?q=${encodeURIComponent(query)}`),
);
ipcMain.handle('models:list', (_event, modelsDir: string) =>
  backendRequest(`/models?models_dir=${encodeURIComponent(modelsDir)}`),
);
ipcMain.handle('dialog:pick-folder', async (event, defaultPath: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    title: 'モデルフォルダを選択',
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory'],
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    useContentSize: true,
    backgroundColor: '#0a0e14',
    icon: path.join(app.getAppPath(), 'assets', 'icons', 'weather-news-v2.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 出典リンクは既定のブラウザで開き、アプリ内では遷移させない
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // 失敗は最初の API 呼び出しで画面に表示する
  startBackend(app.getAppPath(), dataDir()).catch((err) => console.error(err));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let stopped = false;
app.on('before-quit', (event) => {
  if (stopped) return;
  event.preventDefault();
  void stopBackend().finally(() => {
    stopped = true;
    app.quit();
  });
});
