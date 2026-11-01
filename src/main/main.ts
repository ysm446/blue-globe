import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fetchCurrentGfsWind } from './nomads';
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
