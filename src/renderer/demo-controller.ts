// デモの進行と、始める、終わるの操作。場面の順番と行き先は demo.ts で決める
import { DEMO_SCENES, pickDemoPlace, type DemoPlace } from './demo';
import { el } from './dom';
import type { GlobeController } from './globe-view';

const DEMO_HINT_MS = 4000;

// 地球の回転と地域ビューを順に見せる。操作すると終わり、元のモードと視点へ戻す
export function initDemo(
  globe: GlobeController,
  modes: { get(): MapMode; apply(mode: MapMode): void },
  views: { get(): GlobeView; show(view: GlobeView): void },
  weather: { hasHome(): boolean; showHome(): void; showCity(news: NewsReport): void; backToNow(): void },
): void {
  const start = el<HTMLButtonElement>('start-demo');
  const caption = el('demo-caption');
  const hint = el('demo-hint');
  let restore: { mode: MapMode; view: GlobeView } | null = null;
  let timer = 0;
  let hintTimer = 0;
  let step = 0;
  let stoppedByStartButton = false;
  let cityRequest = 0;
  const recent: string[] = [];

  function showCaption(text: string): void {
    caption.textContent = text;
    caption.hidden = !text;
  }

  // 天気が届くまでと取得できないときは、どの都市を見ているかを字幕で示す
  function showCity(place: DemoPlace): void {
    const request = ++cityRequest;
    showCaption(place.name);
    window.weatherApi
      .getPlaceNews(place.name, place.lat, place.lon)
      .then((news) => {
        if (request !== cityRequest) return;
        weather.showCity(news);
        showCaption('');
      })
      .catch((err) => {
        console.error('city weather failed', place.name, err);
        if (request === cityRequest) showCaption(`${place.name}(天気を取得できませんでした)`);
      });
  }

  function showHomeWeather(): void {
    cityRequest++;
    weather.showHome();
    globe.setMarker();
    showCaption('');
  }

  function runScene(): void {
    const scene = DEMO_SCENES[step % DEMO_SCENES.length];
    step++;
    modes.apply(scene.mode);
    views.show(scene.view);
    if (scene.view === 'globe') {
      showHomeWeather();
      globe.demoGlobe(scene.dayside);
    } else if (scene.place === 'home' && weather.hasHome()) {
      showHomeWeather();
      globe.demoRegion();
    } else {
      const kind = scene.place === 'home' || !scene.place ? 'city' : scene.place;
      const place = pickDemoPlace(kind, globe.sunLonLat(), recent);
      globe.demoRegion(place);
      globe.setMarker(place);
      showCity(place);
    }
    timer = window.setTimeout(runScene, scene.seconds * 1000 * window.__tinyEarthDebug.demoTimeScale);
  }

  function wake(): void {
    document.body.classList.remove('demo-idle');
    hint.hidden = false;
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => {
      document.body.classList.add('demo-idle');
      hint.hidden = true;
    }, DEMO_HINT_MS);
  }

  function stop(): void {
    if (!restore) return;
    const { mode, view } = restore;
    restore = null;
    window.clearTimeout(timer);
    window.clearTimeout(hintTimer);
    window.removeEventListener('pointerdown', onInput, true);
    window.removeEventListener('wheel', onInput, true);
    window.removeEventListener('keydown', onInput, true);
    window.removeEventListener('mousemove', wake);
    document.body.classList.remove('demo', 'demo-idle');
    start.setAttribute('aria-pressed', 'false');
    start.setAttribute('aria-label', 'デモを再生');
    start.title = 'デモを再生';
    showHomeWeather();
    hint.hidden = true;
    globe.setDemoMotion(false);
    modes.apply(mode);
    views.show(view);
    if (view === 'solar') {
      globe.setView('solar');
      return;
    }
    if (view === 'region') globe.setView('region');
    else globe.demoGlobe();
    globe.returnToLocation();
  }

  // 地球の操作やキー操作で終わる。スクリーンショット、パネルの開閉やスクロール、音楽の操作では終わらない
  function onInput(event: Event): void {
    if (event instanceof KeyboardEvent && event.key === 'F12') return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('#panels, #detail-panel, #screenshot-toast, #music-toggle, #music-popup')) return;
    if (target?.closest('#start-demo')) stoppedByStartButton = true; // 続く click で再開しない
    // 右上や右下のボタンはそのまま働かせる。地球は触った操作をドラッグとして始めない
    if (!(event instanceof KeyboardEvent) && target?.closest('button')) {
      stop();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    stop();
  }

  start.addEventListener('click', () => {
    if (stoppedByStartButton) {
      stoppedByStartButton = false;
      return;
    }
    if (restore) return;
    weather.backToNow();
    restore = { mode: modes.get(), view: views.get() };
    step = 0;
    start.blur();
    start.setAttribute('aria-pressed', 'true');
    start.setAttribute('aria-label', 'デモを停止');
    start.title = 'デモを停止';
    document.body.classList.add('demo');
    globe.setDemoMotion(true);
    window.addEventListener('pointerdown', onInput, true);
    window.addEventListener('wheel', onInput, { capture: true, passive: false });
    window.addEventListener('keydown', onInput, true);
    window.addEventListener('mousemove', wake);
    wake();
    runScene();
  });
}
