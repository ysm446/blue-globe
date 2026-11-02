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

async function loadWind(setWind: (field: WindField) => void): Promise<LayerCaption> {
  try {
    const result = await window.weatherApi.getWind();
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
    setWind(makeSyntheticWind());
    return { text: '風データを読み込めず、合成データを表示中', warn: true };
  }
}

async function loadClouds(
  setClouds: (nx: number, ny: number, data: Uint8Array) => void,
): Promise<LayerCaption> {
  try {
    const result = await window.weatherApi.getClouds();
    if (!result) return { text: '雲データを取得できませんでした', warn: true };
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
    return { text: '雲データを読み込めませんでした', warn: true };
  }
}

type DataMode = Exclude<MapMode, 'normal'>;

export function initMapLayers(globe: Pick<GlobeController, 'setClouds' | 'setWind'>) {
  const layers: Record<DataMode, { caption: LayerCaption | null; loadedAt: number; loading: boolean; load: () => Promise<LayerCaption> }> = {
    weather: { caption: null, loadedAt: 0, loading: false, load: () => loadClouds(globe.setClouds) },
    wind: { caption: null, loadedAt: 0, loading: false, load: () => loadWind(globe.setWind) },
  };
  let mode: MapMode = 'normal';

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
    if (layer.loading || Date.now() - layer.loadedAt < LAYER_REFRESH_MS) return;
    layer.loading = true;
    layer.caption = await layer.load();
    layer.loading = false;
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
  };
}
