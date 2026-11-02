// 天気と風速のモードのデータの取得と、凡例の表示。データは、そのモードに入ったときに初めて取得する
import { el, formatDateTime } from './dom';
import type { GlobeController } from './globe-view';
import { makeSyntheticWind, WindField } from './wind';
import { RAMP_MAX_SPEED, WIND_COLOR_STOPS } from './wind-texture';

const LAYER_REFRESH_MS = 60 * 60_000; // 地図のデータの取得元は 3 時間刻みで、結果もキャッシュされる
const LAYER_CHECK_MS = 60_000; // 取得した時刻は起動時刻とずれるので、更新の間隔より細かく確かめる

const WIND_LEGEND = `linear-gradient(to right, ${WIND_COLOR_STOPS.map(
  ([speed, [r, g, b]]) => `rgb(${r} ${g} ${b}) ${(speed / RAMP_MAX_SPEED) * 100}%`,
).join(', ')})`;
const CLOUD_LEGEND = 'linear-gradient(to right, rgb(240 245 255 / 0.08), rgb(240 245 255))';

interface LayerCaption {
  text: string;
  warn: boolean;
}

function validTimeLabel(refTime: string, forecastHours: number): string {
  return formatDateTime(new Date(new Date(refTime).getTime() + forecastHours * 3600_000));
}

// at は過去の時刻で、null は今。isCurrent が false なら新しい取得が始まっているので、結果を捨てる
async function loadWind(
  setWind: (field: WindField) => void,
  at: Date | null,
  isCurrent: () => boolean,
): Promise<LayerCaption | null> {
  try {
    const result = await window.weatherApi.getWind(at?.toISOString());
    if (!isCurrent()) return null;
    if (result.source === 'unavailable') {
      return { text: 'この時刻の風を取得できず、前の表示のままです', warn: true };
    }
    const field = WindField.fromGfsJson(result.records);
    if (!field) throw new Error('invalid wind data');
    setWind(field);
    if (result.source === 'sample') {
      return { text: '最新の風を取得できず、サンプルデータ(2014年)を表示中', warn: true };
    }
    const stale = result.source === 'stale';
    const label = validTimeLabel(field.refTime!, field.forecastTime ?? 0);
    return { text: `NOAA GFS ${label} 時点${stale ? '(取得できず前回のデータ)' : ''}`, warn: stale };
  } catch (err) {
    console.error('wind load failed', err);
    if (!isCurrent()) return null;
    if (at) return { text: 'この時刻の風を読み込めず、前の表示のままです', warn: true };
    setWind(makeSyntheticWind());
    return { text: '風データを読み込めず、合成データを表示中', warn: true };
  }
}

async function loadClouds(
  setClouds: (nx: number, ny: number, data: Uint8Array) => void,
  at: Date | null,
  isCurrent: () => boolean,
): Promise<LayerCaption | null> {
  try {
    const result = await window.weatherApi.getClouds(at?.toISOString());
    if (!isCurrent()) return null;
    if (!result) return { text: at ? 'この時刻の雲を取得できず、前の表示のままです' : '雲データを取得できませんでした', warn: true };
    setClouds(result.nx, result.ny, result.data);
    const label = validTimeLabel(result.validTime, 0);
    if (result.source === 'gfs') {
      return { text: `衛星画像を取得できず、NOAA GFS の予報 ${label} 時点を表示中`, warn: true };
    }
    return {
      text: `NOAA GMGSI と GFS を加工 ${label} 時点${result.stale ? '(取得できず前回のデータ)' : ''}`,
      warn: result.stale,
    };
  } catch (err) {
    console.error('cloud load failed', err);
    if (!isCurrent()) return null;
    return { text: at ? 'この時刻の雲を読み込めず、前の表示のままです' : '雲データを読み込めませんでした', warn: true };
  }
}

type DataMode = Exclude<MapMode, 'normal'>;

export function initMapLayers(globe: Pick<GlobeController, 'setClouds' | 'setWind'>) {
  interface Layer {
    caption: LayerCaption | null;
    loadedAt: number;
    loadedKey: string | null; // 読み込んだ時刻。今は 'now'、過去は時間の番号
    pendingKey: string | null;
    request: number;
    load: (at: Date | null, isCurrent: () => boolean) => Promise<LayerCaption | null>;
  }
  const newLayer = (load: Layer['load']): Layer => ({ caption: null, loadedAt: 0, loadedKey: null, pendingKey: null, request: 0, load });
  const layers: Record<DataMode, Layer> = {
    weather: newLayer((at, isCurrent) => loadClouds(globe.setClouds, at, isCurrent)),
    wind: newLayer((at, isCurrent) => loadWind(globe.setWind, at, isCurrent)),
  };
  let mode: MapMode = 'normal';
  let viewAt: Date | null = null;

  function renderLayerInfo(): void {
    const info = el('layer-info');
    info.hidden = mode === 'normal';
    if (mode === 'normal') return;
    el('legend-bar').style.background = mode === 'wind' ? WIND_LEGEND : CLOUD_LEGEND;
    el('legend-min').textContent = mode === 'wind' ? '0' : '薄い';
    el('legend-label').textContent = mode === 'wind' ? '風速 m/s' : '雲';
    el('legend-max').textContent = mode === 'wind' ? String(RAMP_MAX_SPEED) : '厚い';
    const caption = layers[mode].caption;
    const source = el('layer-source');
    source.textContent = caption?.text ?? 'データを取得しています…';
    source.className = caption?.warn ? 'warn' : '';
  }

  async function loadLayer(target: MapMode): Promise<void> {
    if (target === 'normal') return;
    const layer = layers[target];
    const key = viewAt ? String(Math.round(viewAt.getTime() / 3600_000)) : 'now';
    // 過去のデータは変わらないので取り直さない
    const fresh = layer.loadedKey === key && (viewAt !== null || Date.now() - layer.loadedAt < LAYER_REFRESH_MS);
    if (fresh || layer.pendingKey === key) return;
    const request = ++layer.request;
    layer.pendingKey = key;
    if (layer.loadedKey !== key) { // 取得している間、前の時刻の説明を残さない
      layer.caption = null;
      renderLayerInfo();
    }
    const caption = await layer.load(viewAt, () => request === layer.request);
    if (request !== layer.request) return;
    layer.pendingKey = null;
    layer.caption = caption;
    layer.loadedKey = key;
    layer.loadedAt = Date.now();
    renderLayerInfo();
  }

  window.setInterval(() => void loadLayer(mode), LAYER_CHECK_MS);

  return {
    show(next: MapMode): void {
      mode = next;
      renderLayerInfo();
      void loadLayer(next);
    },
    setTime(at: Date | null): void {
      viewAt = at;
      void loadLayer(mode);
    },
  };
}
