import { initDemo } from './demo-controller';
import { el, errorMessage, setStatus } from './dom';
import { initGlobe } from './globe-view';
import { initMapLayers } from './map-layers';
import { hideNews, initNewsView, renderHourly, renderNews, setClockOffset, showClockPlace } from './news-view';
import { initSettingsDialog } from './settings-dialog';

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

// パネルの開閉。閉じた状態は次に起動したときも残す
function initPanelFolds(): (panels: PanelSettings) => void {
  const folds: Record<keyof PanelSettings, HTMLDetailsElement> = {
    news: el<HTMLDetailsElement>('fold-news'),
    hourly: el<HTMLDetailsElement>('fold-hourly'),
    weekly: el<HTMLDetailsElement>('fold-weekly'),
  };
  const read = (): PanelSettings => ({
    news: folds.news.open,
    hourly: folds.hourly.open,
    weekly: folds.weekly.open,
  });
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
  return (panels) => {
    saved = JSON.stringify(panels);
    folds.news.open = panels.news;
    folds.hourly.open = panels.hourly;
    folds.weekly.open = panels.weekly;
  };
}

async function init(): Promise<void> {
  initNewsView();
  initScreenshotToast();
  const applyPanels = initPanelFolds();
  const globe = initGlobe();
  window.__weatherNewsDebug.renderHourly = renderHourly;
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
    el('view-hint').hidden = next !== 'region';
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
      if (button.dataset.view === 'region') button.disabled = next === 'wind';
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

  const status = el('news-status');
  const refreshBtn = el<HTMLButtonElement>('refresh');

  let homeNews: NewsReport | null = null;
  let showingCity = false;
  let requestId = 0;
  async function refreshNews(): Promise<void> {
    const id = ++requestId;
    refreshBtn.disabled = true;
    setStatus(status, '最新の天気をまとめています…');
    try {
      const news = await window.weatherApi.getNews();
      if (id !== requestId) return; // 地点変更などで新しい取得が始まっていたら捨てる
      homeNews = news;
      if (!showingCity) renderNews(news); // デモで都市を見せている間は、戻るときに出す
      setStatus(status, '');
    } catch (err) {
      if (id !== requestId) return;
      setStatus(status, errorMessage(err), true);
    } finally {
      if (id === requestId) refreshBtn.disabled = false;
    }
  }

  let hasLocation = false;
  const settingsDialog = initSettingsDialog(
    (settings) => {
      hasLocation = settings.location !== null;
      showClockPlace(settings.location);
      hideNews();
      if (settings.location) globe.focusLocation(settings.location);
      void refreshNews();
    },
    () => {
      if (hasLocation) void refreshNews();
    },
    (graphics) => globe.applyGraphics(graphics),
  );

  refreshBtn.addEventListener('click', () => {
    if (hasLocation) void refreshNews();
    else void settingsDialog.open();
  });
  el('open-settings').addEventListener('click', () => void settingsDialog.open());
  el('return-home').addEventListener('click', () => globe.returnToLocation());
  initDemo(
    globe,
    { get: () => mode, apply: applyMode },
    { get: () => view, show: showView },
    {
      hasHome: () => hasLocation,
      showHome(): void {
        if (!showingCity) return;
        showingCity = false;
        setClockOffset(null);
        if (homeNews) {
          renderNews(homeNews);
          showClockPlace(homeNews.location);
        } else {
          showClockPlace(null);
        }
      },
      showCity(news: NewsReport): void {
        showingCity = true;
        setClockOffset(news.utc_offset_seconds);
        renderNews(news);
        showClockPlace(news.location);
      },
    },
  );

  try {
    const settings = await window.weatherApi.getSettings();
    hasLocation = settings.location !== null;
    showClockPlace(settings.location);
    if (settings.graphics) globe.applyGraphics(settings.graphics);
    if (settings.panels) applyPanels(settings.panels);
    applyMode(settings.mode ?? 'normal');
    if (settings.location) {
      globe.startFromOverview(settings.location);
      void refreshNews();
    } else {
      setStatus(status, '天気を表示する地点を設定してください。');
      await settingsDialog.open();
    }
  } catch (err) {
    setStatus(status, errorMessage(err), true);
    refreshBtn.disabled = true;
    return;
  }

  window.setInterval(() => {
    if (hasLocation) void refreshNews();
  }, NEWS_REFRESH_MS);
}

void init();
