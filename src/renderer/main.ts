import type { DemoPlace } from './demo';
import { initDemo } from './demo-controller';
import { initLensControls } from './camera-panel';
import { el, errorMessage, setStatus } from './dom';
import { initGlobe } from './globe-view';
import { initMapLayers } from './map-layers';
import { initMusicPlayer } from './music-player';
import { hideNews, initNewsView, renderHourly, renderNews, setClockOffset, setClockTime, showClockPlace } from './news-view';
import { initSettingsDialog } from './settings-dialog';
import { initTimeControl } from './time-control';
import { applyUiFont } from './ui-font';

const NEWS_REFRESH_MS = 15 * 60_000; // Open-Meteo の現在値は 15 分刻み

const SCREENSHOT_TOAST_MS = 6000; // クリックする余裕を持たせる

function initScreenshotToast(): void {
  const toast = el('screenshot-toast');
  const open = el<HTMLButtonElement>('screenshot-toast-open');
  const dialog = el<HTMLDialogElement>('settings');
  let savedPath: string | null = null;
  let timer = 0;
  const hide = (): void => {
    window.clearTimeout(timer);
    toast.hidden = true;
  };

  window.weatherApi.onScreenshot((filePath) => {
    savedPath = filePath;
    el('screenshot-toast-title').textContent = filePath
      ? 'スクリーンショットを保存しました'
      : 'スクリーンショットを保存できませんでした';
    el('screenshot-toast-file').textContent = filePath ? (filePath.split(/[\\/]/).pop() ?? '') : '';
    el('screenshot-toast-hint').textContent = filePath ? 'クリックで保存先を開く' : '';
    open.disabled = !filePath;
    // 設定画面を開いている間は、その外の要素がクリックを受けないので中へ移す
    (dialog.open ? dialog : document.body).append(toast);
    toast.hidden = false;
    window.clearTimeout(timer);
    timer = window.setTimeout(hide, SCREENSHOT_TOAST_MS);
  });
  dialog.addEventListener('close', () => document.body.append(toast));
  open.addEventListener('click', () => {
    if (savedPath) void window.weatherApi.revealScreenshot(savedPath);
    hide();
  });
  el('screenshot-toast-close').addEventListener('click', hide);
}

const PANELS_RIGHT_MIN_WIDTH = 901; // これより狭い画面ではパネルを下に置く (style.css と合わせる)
// これ以下の高さでは、左下の予報が左上のパネルに重なるので右の列へ移す
const PANELS_RIGHT_HEIGHT = 810;
const PANELS_RIGHT_HEIGHT_DETAILS_CLOSED = 710;

// 設定でパネルを隠すときの body のクラス (style.css と合わせる) と、その設定の項目
const PANEL_VISIBILITY: Record<keyof PanelSettings, [className: string, setting: keyof GraphicsSettings]> = {
  hourly: ['hide-hourly-panel', 'show_hourly_panel'],
  weekly: ['hide-weekly-panel', 'show_weekly_panel'],
  details: ['hide-details-panel', 'show_details_panel'],
  camera: ['hide-camera-panel', 'show_camera_panel'],
};

// パネルの開閉と、設定での表示・非表示。閉じた状態は次に起動したときも残す
function initPanelFolds() {
  const folds: Record<keyof PanelSettings, HTMLDetailsElement> = {
    hourly: el<HTMLDetailsElement>('fold-hourly'),
    weekly: el<HTMLDetailsElement>('fold-weekly'),
    details: el<HTMLDetailsElement>('fold-details'),
    camera: el<HTMLDetailsElement>('fold-camera'),
  };
  const read = (): PanelSettings => ({
    hourly: folds.hourly.open,
    weekly: folds.weekly.open,
    details: folds.details.open,
    camera: folds.camera.open,
  });
  const isShown = (key: keyof PanelSettings): boolean =>
    !document.body.classList.contains(PANEL_VISIBILITY[key][0]);
  function syncPanelColumn(): void {
    const limit = folds.details.open && isShown('details') ? PANELS_RIGHT_HEIGHT : PANELS_RIGHT_HEIGHT_DETAILS_CLOSED;
    document.body.classList.toggle('panels-right', window.innerWidth >= PANELS_RIGHT_MIN_WIDTH && window.innerHeight <= limit);
  }
  window.addEventListener('resize', syncPanelColumn);
  folds.details.addEventListener('toggle', syncPanelColumn);
  syncPanelColumn();
  let saved = JSON.stringify(read());
  let saving: Promise<unknown> = Promise.resolve();
  for (const fold of Object.values(folds)) {
    fold.addEventListener('toggle', () => {
      const panels = read();
      // 起動時に保存された状態を反映したときも toggle が届く
      if (JSON.stringify(panels) === saved) return;
      saved = JSON.stringify(panels);
      saving = saving
        .then(() => window.weatherApi.setPanels(panels))
        .catch((err) => console.error('panels save failed', err));
    });
  }
  return {
    applyPanels(panels: PanelSettings): void {
      saved = JSON.stringify(panels);
      folds.hourly.open = panels.hourly;
      folds.weekly.open = panels.weekly;
      folds.details.open = panels.details;
      folds.camera.open = panels.camera;
    },
    showPanels(graphics: GraphicsSettings): void {
      for (const [className, setting] of Object.values(PANEL_VISIBILITY)) {
        document.body.classList.toggle(className, !graphics[setting]);
      }
      syncPanelColumn();
    },
  };
}

async function init(): Promise<void> {
  initNewsView();
  initScreenshotToast();
  const { applyPanels, showPanels } = initPanelFolds();
  const globe = initGlobe(selectCity);
  window.__tinyEarthDebug.renderHourly = renderHourly;
  const mapLayers = initMapLayers(globe);
  let mode: MapMode = 'normal';

  const modeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#mode-switch button'),
  );
  const viewButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#view-switch button'),
  );

  let view: GlobeView = 'globe';
  function showView(next: GlobeView): void {
    view = next;
    for (const button of viewButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.view === next));
    }
    // 太陽系では、地表の表示モードと時刻のスライダー、カメラのパネルは意味がないので止める
    document.body.classList.toggle('solar', next === 'solar');
    for (const button of modeButtons) button.disabled = next === 'solar';
  }

  for (const button of viewButtons) {
    button.addEventListener('click', () => {
      const next = button.dataset.view as GlobeView;
      showView(next);
      globe.setView(next);
    });
  }

  function applyMode(next: MapMode): void {
    mode = next;
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === next));
    }
    // 風速モードは地球ビューだけ。カメラは changeMode が戻す
    if (next === 'wind') showView('globe');
    for (const button of viewButtons) {
      if (button.dataset.view !== 'globe') button.disabled = next === 'wind';
    }
    globe.changeMode(next);
    mapLayers.show(next);
  }

  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      const next = button.dataset.mode as MapMode;
      if (next === mode) return;
      applyMode(next);
      window.weatherApi.setMode(next).catch((err) => console.error('mode save failed', err));
    });
  }
  applyMode('normal');

  const status = el('weather-status');
  const refreshBtn = el<HTMLButtonElement>('refresh');

  let homeNews: NewsReport | null = null;
  let showingCity = false;
  let requestId = 0;
  async function refreshNews(): Promise<void> {
    const id = ++requestId;
    refreshBtn.disabled = true;
    setStatus(status, '最新の天気をまとめています…');
    try {
      const news = await window.weatherApi.getNews(viewAt?.toISOString());
      if (id !== requestId) return; // 地点変更などで新しい取得が始まっていたら捨てる
      homeNews = news;
      if (!showingCity) renderNews(news); // 都市を見せている間は、戻るときに出す
      setStatus(status, '');
    } catch (err) {
      if (id !== requestId) return;
      setStatus(status, errorMessage(err), true);
    } finally {
      if (id === requestId) refreshBtn.disabled = false;
    }
  }

  // 時計に出す場所。時刻のスライダーの日の出と日の入りも、同じ場所と時差 (null はパソコンの時刻) で出す
  function setClockPlace(location: WeatherLocation | null, offsetSeconds: number | null = null): void {
    showClockPlace(location);
    timeControl.setSunPlace(location && { lat: location.latitude, lon: location.longitude }, offsetSeconds);
  }

  function showCity(news: NewsReport): void {
    showingCity = true;
    setClockOffset(news.utc_offset_seconds);
    renderNews(news);
    setClockPlace(news.location, news.utc_offset_seconds);
  }

  function showHome(): void {
    cityRequest++;
    if (selectedCity) setStatus(status, '');
    selectedCity = null;
    if (!showingCity) return;
    showingCity = false;
    setClockOffset(null);
    if (homeNews) {
      renderNews(homeNews);
      setClockPlace(homeNews.location);
    } else {
      hideNews(); // 地点が未設定のときは、都市の文を残さない
      setClockPlace(null);
    }
  }

  // ラベルで選んだ都市の天気。設定地点は変えず、「ホームへ戻る」で元に戻す
  let selectedCity: DemoPlace | null = null;
  let cityRequest = 0;
  async function loadCity(place: DemoPlace): Promise<void> {
    const request = ++cityRequest;
    setStatus(status, `${place.name}の天気を取得しています…`);
    try {
      const news = await window.weatherApi.getPlaceNews(place.name, place.lat, place.lon, viewAt?.toISOString());
      if (request !== cityRequest) return; // 別の都市を選んだり、地点へ戻ったりしていたら捨てる
      showCity(news);
      setStatus(status, '');
    } catch (err) {
      console.error('city weather failed', place.name, err);
      if (request === cityRequest) setStatus(status, `${place.name}の天気を取得できませんでした`, true);
    }
  }

  function selectCity(place: DemoPlace): void {
    selectedCity = place;
    globe.showPlace(place);
    void loadCity(place);
  }

  let hasLocation = false;

  // 過去の時刻。null は今で、動かしている間は太陽と時計だけが追従し、止めるとデータを取りに行く
  let viewAt: Date | null = null;
  const timeControl = initTimeControl(
    (at) => {
      globe.setViewTime(at);
      setClockTime(at);
    },
    (at) => {
      viewAt = at;
      mapLayers.setTime(at);
      if (hasLocation) void refreshNews();
      if (selectedCity) void loadCity(selectedCity);
    },
  );

  // 今の画質の設定。カメラのパネルの被写界深度と F 値は、これを書き換えて保存する
  let graphics: GraphicsSettings | null = null;
  function applyGraphics(next: GraphicsSettings): void {
    graphics = next;
    globe.applyGraphics(next);
    applyUiFont(next.ui_font);
    showPanels(next);
    lensControls.sync(next);
  }
  // 保存は順番に行い、最後の操作が必ず残るようにする
  let graphicsSave: Promise<unknown> = Promise.resolve();
  const lensControls = initLensControls((lens, commit) => {
    if (!graphics) return;
    graphics = { ...graphics, ...lens };
    globe.applyGraphics(graphics);
    if (!commit) return;
    const saved = graphics;
    graphicsSave = graphicsSave
      .then(() => window.weatherApi.setGraphics(saved))
      .catch((err) => console.error('lens settings save failed', err));
  });

  const settingsDialog = initSettingsDialog(
    (settings) => {
      showHome();
      hasLocation = settings.location !== null;
      setClockPlace(settings.location);
      hideNews();
      if (settings.location) {
        if (view === 'solar') showView('globe'); // 新しい地点の上へ戻る
        globe.focusLocation(settings.location);
      }
      void refreshNews();
    },
    applyGraphics,
    (settings) => music.apply(settings),
  );
  const music = initMusicPlayer(() => void settingsDialog.open('tab-music'));

  refreshBtn.addEventListener('click', () => {
    if (selectedCity) void loadCity(selectedCity);
    else if (hasLocation) void refreshNews();
    else void settingsDialog.open();
  });
  el('open-settings').addEventListener('click', () => void settingsDialog.open());
  el('return-home').addEventListener('click', () => {
    if (view === 'solar') showView('globe');
    showHome();
    globe.setMarker();
    globe.returnToLocation();
  });
  initDemo(
    globe,
    { get: () => mode, apply: applyMode },
    { get: () => view, show: showView },
    { hasHome: () => hasLocation, showHome, showCity, backToNow: () => timeControl.reset() },
  );

  try {
    const settings = await window.weatherApi.getSettings();
    hasLocation = settings.location !== null;
    setClockPlace(settings.location);
    if (settings.graphics) applyGraphics(settings.graphics);
    if (settings.panels) applyPanels(settings.panels);
    music.apply(settings);
    applyMode(settings.mode ?? 'normal');
    if (settings.location) {
      globe.startFromOverview(settings.location);
      void refreshNews();
    } else {
      setStatus(status, '天気を表示する場所を設定してください。');
      await settingsDialog.open();
    }
  } catch (err) {
    setStatus(status, errorMessage(err), true);
    refreshBtn.disabled = true;
    return;
  }

  window.setInterval(() => {
    if (viewAt) return; // 過去の値は変わらない
    if (hasLocation) void refreshNews();
    if (selectedCity) void loadCity(selectedCity);
  }, NEWS_REFRESH_MS);
}

void init();
