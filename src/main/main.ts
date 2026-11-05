import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { parseByteRange } from './byte-range';
import { nearestStepStamp, parsePastTime } from './gfs-time';
import { fetchGfsCloud, fetchGfsWind } from './nomads';
import { backendRequest, startBackend, stopBackend } from './backend';
import { startVramMonitor, stopVramMonitor } from './vram-monitor';

const GFS_MAX_AGE_MS = 3 * 3600_000; // GFS 1.0° は 3 時間刻み
const GFS_FETCH_TIMEOUT_MS = 30_000;
const PAST_KEEP_MS = 48 * 3600_000; // 見られるのは 24 時間前まで。古いものは残しておいても使わない
const AUDIO_SCHEME = 'weather-audio';
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'flac'];

// 音源を少しずつ読むための読み込み口。app の準備ができる前に登録する必要がある
protocol.registerSchemesAsPrivileged([{ scheme: AUDIO_SCHEME, privileges: { standard: true, stream: true } }]);

// 動作検証時に実際の設定を汚さないよう、環境変数で差し替えられる
function dataDir(): string {
  return process.env.BLUE_GLOBE_DATA_DIR || path.join(app.getAppPath(), 'data');
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

// ファイルがなければ Infinity を返す
async function fileAgeMs(filePath: string): Promise<number> {
  try {
    return Date.now() - (await fs.promises.stat(filePath)).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// 書き込みの途中で落ちても、壊れたファイルがキャッシュに残らないようにする
async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(tempPath, data);
  await fs.promises.rename(tempPath, filePath);
}

// 過去の時刻のデータは溜まり続けないよう、古いものを消す
async function prunePast(dir: string): Promise<void> {
  for (const name of await fs.promises.readdir(dir).catch(() => [])) {
    const filePath = path.join(dir, name);
    if ((await fileAgeMs(filePath)) > PAST_KEEP_MS) await fs.promises.rm(filePath, { force: true });
  }
}

// 過去の風は、一番近い 3 時間の区切りのものを使う。取得できなければ records が null
async function getPastWind(at: Date): Promise<unknown> {
  const dir = path.join(dataDir(), 'wind-cache', 'past');
  const filePath = path.join(dir, `${nearestStepStamp(at)}.json`);
  if (Number.isFinite(await fileAgeMs(filePath))) return { source: 'cache', records: await readJson(filePath) };
  try {
    const records = await fetchGfsWind(AbortSignal.timeout(GFS_FETCH_TIMEOUT_MS), at);
    await writeFileAtomic(filePath, JSON.stringify(records));
    await prunePast(dir);
    return { source: 'nomads', records };
  } catch (err) {
    console.error('past wind fetch failed', err);
    return { source: 'unavailable', records: null };
  }
}

// 風データの探索順: 新しいキャッシュ → NOMADS → 古いキャッシュ → アプリ同梱サンプル
ipcMain.handle('wind:get', async (_event, at?: unknown) => {
  if (at !== undefined) return getPastWind(parsePastTime(at));
  const cachePath = path.join(dataDir(), 'wind-cache', 'current-wind.json');
  const cacheAge = await fileAgeMs(cachePath);
  if (cacheAge < GFS_MAX_AGE_MS) return { source: 'cache', records: await readJson(cachePath) };

  try {
    const records = await fetchGfsWind(AbortSignal.timeout(GFS_FETCH_TIMEOUT_MS));
    await writeFileAtomic(cachePath, JSON.stringify(records));
    return { source: 'nomads', records };
  } catch (err) {
    console.error('wind fetch failed', err);
  }
  if (Number.isFinite(cacheAge)) return { source: 'stale', records: await readJson(cachePath) };
  return {
    source: 'sample',
    records: await readJson(path.join(app.getAppPath(), 'assets', 'data', 'current-wind.json')),
  };
});

function cloudCachePath(name: string): string {
  return path.join(dataDir(), 'cloud-cache', name);
}

// GFS の雲量を data/cloud-cache に用意する。新しいキャッシュ → NOMADS → 古いキャッシュの順に探す
async function ensureGfsCloud(): Promise<boolean> {
  const metaPath = cloudCachePath('current-cloud.json');
  const binPath = cloudCachePath('current-cloud.bin');
  const binAge = await fileAgeMs(binPath);
  const cached = Number.isFinite(binAge) && Number.isFinite(await fileAgeMs(metaPath));
  if (cached && binAge < GFS_MAX_AGE_MS) return true;

  try {
    const { data, ...meta } = await fetchGfsCloud(AbortSignal.timeout(GFS_FETCH_TIMEOUT_MS));
    await writeFileAtomic(binPath, data);
    await writeFileAtomic(metaPath, JSON.stringify(meta));
    return true;
  } catch (err) {
    console.error('cloud fetch failed', err);
    return cached;
  }
}

// 衛星の雲マップを取れないときは、GFS だけで表示する。経度 0 度始まりなので -180 度始まりへ回す
async function readGfsFallback(name = 'current-cloud'): Promise<unknown> {
  const meta = (await readJson(cloudCachePath(`${name}.json`))) as {
    nx: number;
    ny: number;
    refTime: string;
    forecastTime: number;
  };
  const raw = await fs.promises.readFile(cloudCachePath(`${name}.bin`));
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

// 過去の時刻の GFS の雲量を用意する。返すのは cloud-cache/past の中の名前で、取得できなければ null
async function ensurePastGfsCloud(at: Date): Promise<string | null> {
  const name = `gfs-${nearestStepStamp(at)}`;
  const metaPath = cloudCachePath(`past/${name}.json`);
  if (Number.isFinite(await fileAgeMs(metaPath))) return name;
  try {
    const { data, ...meta } = await fetchGfsCloud(AbortSignal.timeout(GFS_FETCH_TIMEOUT_MS), at);
    await writeFileAtomic(cloudCachePath(`past/${name}.bin`), data);
    await writeFileAtomic(metaPath, JSON.stringify(meta));
    return name;
  } catch (err) {
    console.error('past cloud fetch failed', err);
    return null;
  }
}

// 過去の雲は、一番近い 1 時間の衛星画像から作る。GFS は今の雲マップと同じ補助に使う
async function getPastClouds(at: Date): Promise<unknown> {
  const gfs = await ensurePastGfsCloud(at);
  try {
    const params = new URLSearchParams({ at: at.toISOString(), ...(gfs ? { gfs } : {}) });
    const sat = (await backendRequest(`/clouds/satellite?${params.toString()}`)) as {
      nx: number;
      ny: number;
      valid_time: string;
      file: string;
    };
    const data = new Uint8Array(await fs.promises.readFile(cloudCachePath(`past/${sat.file}`)));
    return { source: 'satellite', nx: sat.nx, ny: sat.ny, validTime: sat.valid_time, stale: false, data };
  } catch (err) {
    console.error('past satellite cloud failed', err);
    return gfs ? readGfsFallback(`past/${gfs}`) : null;
  } finally {
    await prunePast(cloudCachePath('past'));
  }
}

ipcMain.handle('clouds:get', async (_event, at?: unknown) => {
  if (at !== undefined) return getPastClouds(parsePastTime(at));
  const hasGfs = await ensureGfsCloud();
  try {
    const sat = (await backendRequest('/clouds/satellite')) as {
      nx: number;
      ny: number;
      valid_time: string;
      stale: boolean;
    };
    const data = new Uint8Array(await fs.promises.readFile(cloudCachePath('current-sat.bin')));
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
  'earth-water': 'earth-water.png',
};

ipcMain.handle('texture:get', async (_event, name: string) => {
  const file = Object.hasOwn(TEXTURES, name) ? TEXTURES[name] : null;
  if (!file) throw new Error(`unknown texture: ${name}`);
  return new Uint8Array(await fs.promises.readFile(path.join(app.getAppPath(), 'assets', 'textures', file)));
});

// 地域ビューの地表、街明かり、水域 (NASA GIBS の 500m の面)。中身の変わらない合成画像なので、取得したら取り直さない
const TILE_FETCH_TIMEOUT_MS = 20_000;
const NIGHT_TILE_JPEG_QUALITY = 85; // 配信は PNG で 1 枚 140〜300KB ある
const TILE_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best';
const TILE_SOURCES: Record<string, string> = {
  day: 'BlueMarble_ShadedRelief_Bathymetry/default/500m/7/{row}/{col}.jpeg',
  night: 'VIIRS_Black_Marble/default/2016-01-01/500m/7/{row}/{col}.png',
  water: 'MODIS_Water_Mask/default/250m/7/{row}/{col}.png', // レベル 7 は他の面と同じ 160×80 枚
};

// 取得できないときは null を返す。画面は今の画像のまま表示を続ける
ipcMain.handle('earth-tile:get', async (_event, layer: string, col: number, row: number) => {
  const source = Object.hasOwn(TILE_SOURCES, layer) ? TILE_SOURCES[layer] : null;
  if (!source || !Number.isInteger(col) || !Number.isInteger(row) || col < 0 || col >= 160 || row < 0 || row >= 80) {
    throw new Error(`unknown tile: ${layer} ${col} ${row}`);
  }
  // 水域は 2 値なので PNG のまま保存する。JPEG にすると境界がにじみ、容量も減らない
  const filePath = path.join(dataDir(), 'earth-tiles', layer, String(row), `${col}.${layer === 'water' ? 'png' : 'jpg'}`);
  try {
    return new Uint8Array(await fs.promises.readFile(filePath));
  } catch {
    // キャッシュにないので取得する
  }
  try {
    const url = `${TILE_URL}/${source.replace('{row}', String(row)).replace('{col}', String(col))}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS) });
    if (!response.ok) return null;
    const received = Buffer.from(await response.arrayBuffer());
    const image = nativeImage.createFromBuffer(received);
    if (image.isEmpty()) return null;
    const bytes = layer === 'night' ? image.toJPEG(NIGHT_TILE_JPEG_QUALITY) : received;
    await writeFileAtomic(filePath, bytes);
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
});

const jsonPut = (body: unknown): RequestInit => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// 過去の時刻を見ているときは at を付ける
const atQuery = (at?: unknown): string => (at === undefined ? '' : `at=${encodeURIComponent(parsePastTime(at).toISOString())}`);

ipcMain.handle('news:get', (_event, at?: unknown) => backendRequest(`/news?${atQuery(at)}`));
ipcMain.handle('news:place', (_event, name: string, latitude: number, longitude: number, at?: unknown) =>
  backendRequest(`/news/place?name=${encodeURIComponent(name)}&latitude=${latitude}&longitude=${longitude}&${atQuery(at)}`),
);
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
ipcMain.handle('graphics:defaults', () => backendRequest('/settings/graphics/defaults'));
ipcMain.handle('panels:set', (_event, panels: unknown) =>
  backendRequest('/settings/panels', jsonPut(panels)),
);
// FPS の表示に出す VRAM の量。表示している間だけ読む (アプリを閉じるときは before-quit で止める)
ipcMain.handle('vram:watch', (event, enabled: boolean) => {
  if (!enabled) {
    stopVramMonitor();
    return;
  }
  const sender = event.sender;
  startVramMonitor((bytes) => {
    if (!sender.isDestroyed()) sender.send('vram:usage', bytes);
  });
});
// パスを決めるのはメインプロセスのダイアログだけにする。画面から任意のファイルを読めないように
ipcMain.handle('audio:choose', async (event) => {
  const options: Electron.OpenDialogOptions = {
    title: '音源ファイルを選ぶ',
    defaultPath: path.join(app.getAppPath(), 'assets', 'bgm'),
    properties: ['openFile'],
    filters: [{ name: '音声ファイル', extensions: AUDIO_EXTENSIONS }],
  };
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return backendRequest('/settings/audio-file', jsonPut({ file: result.filePaths[0] }));
});
ipcMain.handle('audio:clear', () => backendRequest('/settings/audio-file', jsonPut({ file: null })));
ipcMain.handle('audio:volume', (_event, volume: number) =>
  backendRequest('/settings/audio-volume', jsonPut({ volume })),
);
ipcMain.handle('locations:search', (_event, query: string) =>
  backendRequest(`/locations?q=${encodeURIComponent(query)}`),
);
// ループの先頭へ戻るにはシークが要るので、Range に応える
async function audioResponse(file: string, rangeHeader: string | null): Promise<Response> {
  const size = await fs.promises.stat(file).then((stat) => stat.size, () => 0);
  if (size === 0) return new Response(null, { status: 404 });
  const range = parseByteRange(rangeHeader, size);
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const headers: Record<string, string> = { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
  return new Response(body, { status: range ? 206 : 200, headers });
}

function screenshotDir(): string {
  return path.join(dataDir(), 'screenshots');
}

// 通知のクリックから保存先を開く。スクリーンショットのフォルダの中だけ受け付ける
ipcMain.handle('screenshot:reveal', (_event, filePath: string) => {
  if (path.dirname(filePath) === screenshotDir() && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});

// 連続で撮っても前の通知が写らないよう、消えた画面が描かれるまで待つ
const HIDE_TOAST_SCRIPT = `new Promise((resolve) => {
  document.getElementById('screenshot-toast')?.setAttribute('hidden', '');
  requestAnimationFrame(() => requestAnimationFrame(resolve));
})`;

// capturePage は物理ピクセルで撮る。logical (Shift+F12) のときはウィンドウの論理サイズへ縮め、
// 表示倍率 100% で同じ大きさのウィンドウを撮ったときの画素数にする。構図は変わらない
async function captureScreenshot(win: BrowserWindow, logical: boolean): Promise<void> {
  let filePath: string | null = null;
  try {
    await win.webContents.executeJavaScript(HIDE_TOAST_SCRIPT);
    let image = await win.webContents.capturePage();
    if (logical) {
      const [width, height] = win.getContentSize();
      image = image.resize({ width, height, quality: 'best' });
    }
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    await fs.promises.mkdir(screenshotDir(), { recursive: true });
    filePath = path.join(screenshotDir(), `screenshot-${stamp}${logical ? '-100pct' : ''}.png`);
    await fs.promises.writeFile(filePath, image.toPNG());
  } catch (err) {
    console.error('screenshot failed', err);
    filePath = null;
  }
  if (!win.isDestroyed()) win.webContents.send('screenshot:done', filePath);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    useContentSize: true,
    backgroundColor: '#0a0e14',
    icon: path.join(app.getAppPath(), 'assets', 'icons', 'blue-globe.png'),
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
  // 読み直した画面は FPS の表示の設定から改めて頼んでくる
  win.webContents.on('did-start-loading', stopVramMonitor);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    // F12 は物理ピクセルのまま、Shift+F12 は表示倍率 100% 相当の大きさで保存する
    if (input.key === 'F12') void captureScreenshot(win, input.shift);
    // Ctrl+R で画面だけを読み直す。メニューを外しているので Electron の標準の操作は効かない
    if (input.control && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      win.webContents.reload();
    }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // URL によらず、設定で選んだ音源だけを返す
  protocol.handle(AUDIO_SCHEME, async (request) => {
    const { audio_file: file } = (await backendRequest('/settings')) as { audio_file: string | null };
    return file ? audioResponse(file, request.headers.get('range')) : new Response(null, { status: 404 });
  });
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
  stopVramMonitor();
  void stopBackend().finally(() => {
    stopped = true;
    app.quit();
  });
});
