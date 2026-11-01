import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Globe, createCoastlines, createBorders, lonLatToVector3 } from './globe';
import { WindField, makeSyntheticWind } from './wind';
import { ParticleSystem, COLOR_SCHEMES } from './particles';
import { GpuParticleSystem } from './gpu-particles';
import { SpeedOverlay } from './overlay';
import { RAMP_MAX_SPEED } from './wind-texture';
import { weatherIcon } from './icons';

const COLORS = {
  ocean: '#0c1422',
  land: '#31445e',
  graticule: '#ffffff',
  coastline: '#e4eeff',
  halo: '#4a7fc9',
  background: '#0a0e14',
  stars: '#5a6a82',
};
const COLOR_STOPS = COLOR_SCHEMES.earth;

const GLOBE_RADIUS = 1;
const PARTICLE_RADIUS = 1.004; // 地表より少し浮かせて Z ファイティングを避ける
const PARTICLE_TEX_SIZE = 512; // 粒子数 = この値の 2 乗
const PARTICLE_SPEED = 0.1;
const TRAIL_FADE = 0.953;
const PARTICLE_BRIGHTNESS = 0.7; // 海岸線が風に埋もれないよう控えめにする
const OVERLAY_OPACITY = 0.2;
const COASTLINE_OPACITY = 0.9;

const MIN_DIST = 1.2;
const MAX_DIST = 8;
const FOCUS_DIST = 2.15; // 地点に寄ったときのカメラ距離
const OVERVIEW_DIST = 3.8;
const FLY_SECONDS = 2.8;
const PANEL_OVERLAP_WIDTH = 900; // これより狭い画面ではパネルを下に置く

const NEWS_REFRESH_MS = 15 * 60_000; // Open-Meteo の現在値は 15 分刻み
const WIND_REFRESH_MS = 60 * 60_000;

const METHOD_LABEL: Record<NewsOutlook['method'], string> = {
  rule: '気象庁の文を整形',
  llm: '気象庁の文を LLM で要約',
  verbatim: '気象庁の原文',
};

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function errorMessage(err: unknown): string {
  // ipcRenderer.invoke は "Error invoking remote method 'x': Error: 本文" の形で返す
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function initGlobe() {
  const container = el('app');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COLORS.background);

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1, 3.6);

  // ニュースパネルに隠れないよう、地球儀を残りの領域の中央に寄せる
  function applyViewOffset(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const panel = el('news').offsetWidth;
    if (w > PANEL_OVERLAP_WIDTH) camera.setViewOffset(w, h, (panel + 16) / 2, 0, w, h);
    else camera.setViewOffset(w, h, 0, el('news').offsetHeight / 2, w, h);
  }
  applyViewOffset();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = MIN_DIST;
  controls.maxDistance = MAX_DIST;
  controls.rotateSpeed = 0.5;

  scene.add(
    new Globe(
      GLOBE_RADIUS,
      { ocean: COLORS.ocean, land: COLORS.land, graticule: COLORS.graticule },
      COLORS.halo,
    ).group,
  );

  // ベクター海岸線・国境線 (LOD 付き)。地表より少し浮かせて Z ファイティングを避ける
  const coastlines = createCoastlines(GLOBE_RADIUS * 1.0015);
  coastlines.setColor(COLORS.coastline);
  coastlines.setOpacity(COASTLINE_OPACITY);
  const borders = createBorders(GLOBE_RADIUS * 1.0014);
  scene.add(coastlines.group, borders.group);

  const overlay = new SpeedOverlay(GLOBE_RADIUS * 1.0008);
  overlay.setColorStops(COLOR_STOPS);
  overlay.setOpacity(OVERLAY_OPACITY);
  overlay.setEnabled(true);
  scene.add(overlay.mesh);

  // 薄い星空
  {
    const starCount = 1200;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 20);
      positions.set([v.x, v.y, v.z], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    scene.add(
      new THREE.Points(
        geometry,
        new THREE.PointsMaterial({ color: COLORS.stars, size: 0.06, sizeAttenuation: true }),
      ),
    );
  }

  let gpuParticles: GpuParticleSystem | null = null;
  let cpuParticles: ParticleSystem | null = null;

  function setWind(field: WindField): void {
    overlay.setWind(field);
    if (gpuParticles) {
      gpuParticles.setWind(field);
    } else if (cpuParticles) {
      cpuParticles.setWind(field);
    } else if (GpuParticleSystem.isSupported(renderer)) {
      gpuParticles = new GpuParticleSystem(
        renderer,
        field,
        PARTICLE_TEX_SIZE,
        PARTICLE_RADIUS,
        GLOBE_RADIUS,
      );
      gpuParticles.speedFactor = PARTICLE_SPEED;
      gpuParticles.trailFade = TRAIL_FADE;
      gpuParticles.brightness = PARTICLE_BRIGHTNESS;
      gpuParticles.setColorStops(COLOR_STOPS);
    } else {
      // GPU 非対応環境では CPU 移流にフォールバック
      cpuParticles = new ParticleSystem(6000, PARTICLE_RADIUS, field, 32);
      cpuParticles.speedFactor = PARTICLE_SPEED;
      cpuParticles.brightness = PARTICLE_BRIGHTNESS;
      cpuParticles.colorStops = COLOR_STOPS;
      scene.add(cpuParticles.object3d);
    }
  }

  // 地点へのカメラ移動。移動中は OrbitControls を止め、操作されたら打ち切る
  let flight: { from: THREE.Vector3; to: THREE.Vector3; elapsed: number } | null = null;
  const marker = el('marker');
  const markerPos = new THREE.Vector3();
  const projected = new THREE.Vector3();
  let markerNormal: THREE.Vector3 | null = null;

  renderer.domElement.addEventListener('pointerdown', () => {
    flight = null;
  });
  renderer.domElement.addEventListener('wheel', () => {
    flight = null;
  });

  function focusLocation(location: WeatherLocation): void {
    el('marker-label').textContent = location.name;
    lonLatToVector3(location.longitude, location.latitude, PARTICLE_RADIUS, markerPos);
    markerNormal = markerPos.clone().normalize();
    marker.hidden = false;
    flight = {
      from: camera.position.clone(),
      to: markerNormal.clone().multiplyScalar(FOCUS_DIST),
      elapsed: 0,
    };
  }

  function startFromOverview(location: WeatherLocation): void {
    // 地点から少し離れた遠景から寄っていく
    const start = lonLatToVector3(location.longitude - 55, location.latitude * 0.5 + 8, OVERVIEW_DIST);
    camera.position.copy(start);
    camera.lookAt(0, 0, 0);
    focusLocation(location);
  }

  function updateFlight(dt: number): void {
    if (!flight) {
      controls.update();
      return;
    }
    flight.elapsed = Math.min(FLY_SECONDS, flight.elapsed + dt);
    const t = flight.elapsed / FLY_SECONDS;
    const eased = t * t * (3 - 2 * t);
    // 球面に沿って向きを補間し、距離は別に補間する
    const fromLen = flight.from.length();
    const toLen = flight.to.length();
    const q = new THREE.Quaternion().setFromUnitVectors(
      flight.from.clone().normalize(),
      flight.to.clone().normalize(),
    );
    const partial = new THREE.Quaternion().slerp(q, eased);
    camera.position
      .copy(flight.from)
      .normalize()
      .applyQuaternion(partial)
      .multiplyScalar(fromLen + (toLen - fromLen) * eased);
    camera.lookAt(0, 0, 0);
    if (flight.elapsed >= FLY_SECONDS) flight = null;
  }

  function updateMarker(): void {
    if (!markerNormal) return;
    // 地球の裏側にあるときは隠す
    const facing = markerNormal.dot(camera.position.clone().normalize());
    const visible = facing > GLOBE_RADIUS / camera.position.length();
    marker.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) return;
    projected.copy(markerPos).project(camera);
    const x = ((projected.x + 1) / 2) * window.innerWidth;
    const y = ((1 - projected.y) / 2) * window.innerHeight;
    marker.style.transform = `translate(${x}px, ${y}px)`;
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    applyViewOffset();
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    gpuParticles?.resize();
  });

  let lastFrameTime = 0;
  renderer.setAnimationLoop((time: number) => {
    const dt = lastFrameTime === 0 ? 0.016 : Math.min(0.1, (time - lastFrameTime) / 1000);
    lastFrameTime = time;
    updateFlight(dt);
    coastlines.update(camera.position.length());
    borders.update(camera.position.length());
    gpuParticles?.update(camera);
    cpuParticles?.update();
    renderer.render(scene, camera);
    gpuParticles?.composite();
    updateMarker();
  });

  return { setWind, focusLocation, startFromOverview };
}

async function loadWind(setWind: (field: WindField) => void): Promise<void> {
  const sourceEl = el('wind-source');
  try {
    const result = await window.weatherApi.getWind();
    const field = WindField.fromGfsJson(result.records);
    if (!field) throw new Error('invalid wind data');
    setWind(field);
    if (result.source === 'sample') {
      sourceEl.textContent = '最新の風を取得できず、サンプルデータ(2014年)を表示中';
      sourceEl.className = 'warn';
      return;
    }
    const validMs = new Date(field.refTime!).getTime() + (field.forecastTime ?? 0) * 3600_000;
    const label = new Date(validMs).toLocaleString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    sourceEl.textContent = `NOAA GFS ${label} 時点${result.source === 'stale' ? '(取得できず前回のデータ)' : ''}`;
    sourceEl.className = result.source === 'stale' ? 'warn' : '';
  } catch (err) {
    console.error('wind load failed', err);
    setWind(makeSyntheticWind());
    sourceEl.textContent = '風データを読み込めず、合成データを表示中';
    sourceEl.className = 'warn';
  }
}

function formatReportTime(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function renderStat(id: string, value: string, unit: string, prefix = ''): void {
  const target = el(id);
  target.textContent = prefix + value;
  const small = document.createElement('small');
  small.textContent = unit;
  target.append(small);
}

function renderHourly(news: NewsReport): void {
  const rows: Array<[string, (h: NewsReport['hourly'][number]) => string]> = [
    ['hourly-time', (h) => h.time],
    ['hourly-temperature', (h) => `${h.temperature}°`],
    ['hourly-rain', (h) => (h.rain === null ? '–' : `${h.rain}%`)],
  ];
  for (const [id, format] of rows) {
    const row = el<HTMLTableRowElement>(id);
    row.querySelectorAll('td').forEach((cell) => cell.remove());
    for (const hour of news.hourly) {
      const cell = row.insertCell();
      cell.textContent = format(hour);
      cell.title = hour.weather;
    }
  }
  const iconRow = el<HTMLTableRowElement>('hourly-icon');
  iconRow.querySelectorAll('td').forEach((cell) => cell.remove());
  for (const hour of news.hourly) {
    iconRow.insertCell().append(weatherIcon(hour.icon, hour.is_day, hour.weather, 24));
  }
}

function renderWeekly(news: NewsReport): void {
  const body = el<HTMLTableSectionElement>('weekly-body');
  body.replaceChildren();
  news.weekly.forEach((day, index) => {
    const row = body.insertRow();
    if (index === 0) row.className = 'today';
    const addCell = (text: string, className = ''): HTMLTableCellElement => {
      const cell = row.insertCell();
      cell.textContent = text;
      cell.className = className;
      return cell;
    };
    addCell(day.label);
    addCell('').append(weatherIcon(day.icon, true, day.weather, 20));
    addCell(day.weather).title = day.weather;
    addCell(`${day.high}°`, 'num');
    addCell(`${day.low}°`, 'num low');
    addCell(day.rain === null ? '–' : `${day.rain}%`, 'num');
  });
}

function renderNews(news: NewsReport): void {
  el('headline').textContent = news.headline;
  el('current-icon').replaceChildren(
    weatherIcon(news.current.icon, news.current.is_day, news.current.weather, 52),
  );
  el('clock-icon').replaceChildren(
    weatherIcon(news.current.icon, news.current.is_day, news.current.weather, 48),
  );
  el('clock-temperature').textContent = `${news.current.temperature.toFixed(1)}℃`;
  el('clock-condition').textContent = news.current.weather;
  el('clock-weather').hidden = false;
  el('current-text').textContent = news.current_text;
  el('day-text').textContent = news.day_text;
  renderStat('stat-temperature', news.current.temperature.toFixed(1), '℃');
  renderStat('stat-apparent', news.current.apparent.toFixed(1), '℃');
  renderStat('stat-humidity', String(news.current.humidity), '%');
  renderStat('stat-wind', news.current.wind_speed.toFixed(1), 'm/s');
  renderStat('stat-gust', news.current.gust.toFixed(1), 'm/s');
  el('stat-wind').title = `${news.current.wind_direction}寄りの風`;
  renderHourly(news);
  renderWeekly(news);

  const { outlook } = news;
  const outlookText = el('outlook-text');
  outlookText.textContent = outlook?.text ?? '';
  outlookText.hidden = !outlook;
  const note = el('outlook-note');
  note.textContent = news.note ?? '';
  note.hidden = !news.note;
  el('original-box').hidden = !outlook?.original || outlook.method === 'verbatim';
  el('original-text').textContent = outlook?.original ?? '';

  const parts = ['予報値: Open-Meteo'];
  if (outlook) {
    parts.push(METHOD_LABEL[outlook.method]);
    if (outlook.model) parts.push(outlook.model);
    if (outlook.reported_at) parts.push(`${formatReportTime(outlook.reported_at)} 発表`);
  }
  el('outlook-source').textContent = parts.join('・');
  el('news-body').hidden = false;
}

function initSettingsDialog(
  onLocationChange: (settings: AppSettings) => void,
  onModelChange: () => void,
) {
  const dialog = el<HTMLDialogElement>('settings');
  const dirInput = el<HTMLInputElement>('models-dir');
  const modelSelect = el<HTMLSelectElement>('model-select');
  const modelStatus = el('model-status');
  const locationStatus = el('location-status');
  const results = el<HTMLUListElement>('location-results');
  let settings: AppSettings = { location: null, models_dir: '', model: null };
  let modelChanged = false;

  dialog.addEventListener('close', () => {
    if (modelChanged) onModelChange();
    modelChanged = false;
  });

  function setStatus(target: HTMLElement, message: string, isError = false): void {
    target.textContent = message;
    target.classList.toggle('error', isError);
  }

  function showCurrentLocation(): void {
    const { location } = settings;
    el('current-location').textContent = location
      ? `現在の地点: ${[location.admin1, location.name].filter(Boolean).join(' ')}`
      : '天気を表示する地点を検索して選んでください。';
  }

  async function save(next: AppSettings): Promise<boolean> {
    try {
      settings = await window.weatherApi.saveSettings(next);
      return true;
    } catch (err) {
      setStatus(modelStatus, errorMessage(err), true);
      return false;
    }
  }

  // 一覧を読み込む。フォルダを読めなかったら false を返す
  async function loadModels(): Promise<boolean> {
    modelSelect.replaceChildren(new Option('使わない(気象庁の原文を表示)', ''));
    setStatus(modelStatus, '');
    const { models, error } = await window.weatherApi.listModels(dirInput.value);
    if (error) {
      setStatus(modelStatus, error, true);
    } else if (models.length === 0) {
      setStatus(modelStatus, 'このフォルダにモデルが見つかりません。', true);
    }
    for (const model of models) {
      const option = new Option(`${model.name}(${model.size_gb} GB)`, model.path);
      option.title = model.path;
      modelSelect.add(option);
    }
    const selected = settings.model;
    if (selected && models.some((m) => m.path === selected)) {
      modelSelect.value = selected;
    } else {
      if (selected && !error) {
        setStatus(modelStatus, `選択中のモデルが見つかりません: ${selected}`, true);
      }
      modelSelect.value = '';
    }
    return !error;
  }

  async function changeModelsDir(dir: string): Promise<void> {
    dirInput.value = dir;
    // 打ち間違いで今の選択を失わないよう、読めないフォルダは保存しない
    if (!(await loadModels())) return;
    // 新しいフォルダにないモデルは選択を外してから保存する
    if (await save({ ...settings, models_dir: dir, model: modelSelect.value || null })) {
      modelChanged = true;
      if (modelStatus.textContent === '') setStatus(modelStatus, '保存しました。');
    }
  }

  dirInput.addEventListener('change', () => void changeModelsDir(dirInput.value.trim()));
  el('pick-folder').addEventListener('click', async () => {
    const dir = await window.weatherApi.pickFolder(dirInput.value);
    if (dir) await changeModelsDir(dir);
  });
  modelSelect.addEventListener('change', async () => {
    if (await save({ ...settings, model: modelSelect.value || null })) {
      modelChanged = true;
      setStatus(modelStatus, '保存しました。');
    }
  });

  el<HTMLFormElement>('location-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = el<HTMLInputElement>('location-query').value.trim();
    if (!query) return;
    results.replaceChildren();
    setStatus(locationStatus, '検索しています…');
    try {
      const rows = await window.weatherApi.searchLocations(query);
      setStatus(locationStatus, rows.length ? '' : '見つかりませんでした。別の表記でお試しください。');
      for (const row of rows) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = row.name;
        const detail = document.createElement('small');
        detail.textContent = [row.admin1, row.country].filter(Boolean).join('・');
        button.append(detail);
        button.addEventListener('click', async () => {
          if (await save({ ...settings, location: row })) {
            results.replaceChildren();
            el<HTMLInputElement>('location-query').value = '';
            showCurrentLocation();
            modelChanged = false; // 地点変更の取得で新しいモデルも反映される
            dialog.close();
            onLocationChange(settings);
          }
        });
        const item = document.createElement('li');
        item.append(button);
        results.append(item);
      }
    } catch (err) {
      setStatus(locationStatus, errorMessage(err), true);
    }
  });

  async function open(): Promise<void> {
    settings = await window.weatherApi.getSettings();
    dirInput.value = settings.models_dir;
    showCurrentLocation();
    dialog.showModal();
    await loadModels();
  }

  return { open };
}

// PC の時刻を表示する。スリープ復帰後もすぐ合うよう、毎秒確かめて変わったときだけ書き換える
function initClock(): void {
  const timeEl = el('clock-time');
  const dateEl = el('clock-date');
  const update = (): void => {
    const now = new Date();
    const time = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString('ja-JP', {
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    });
    if (timeEl.textContent !== time) timeEl.textContent = time;
    if (dateEl.textContent !== date) dateEl.textContent = date;
  };
  update();
  window.setInterval(update, 1000);
}

async function init(): Promise<void> {
  initClock();
  const globe = initGlobe();
  el('legend-bar').style.background = `linear-gradient(to right, ${COLOR_STOPS.map(
    ([speed, [r, g, b]]) => `rgb(${r} ${g} ${b}) ${(speed / RAMP_MAX_SPEED) * 100}%`,
  ).join(', ')})`;
  void loadWind(globe.setWind);
  window.setInterval(() => void loadWind(globe.setWind), WIND_REFRESH_MS);

  const status = el('news-status');
  const refreshBtn = el<HTMLButtonElement>('refresh');

  function setStatus(message: string, isError = false): void {
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  let requestId = 0;
  async function refreshNews(): Promise<void> {
    const id = ++requestId;
    refreshBtn.disabled = true;
    setStatus('最新の天気をまとめています…');
    try {
      const news = await window.weatherApi.getNews();
      if (id !== requestId) return; // 地点変更などで新しい取得が始まっていたら捨てる
      renderNews(news);
      setStatus('');
    } catch (err) {
      if (id !== requestId) return;
      setStatus(errorMessage(err), true);
    } finally {
      if (id === requestId) refreshBtn.disabled = false;
    }
  }

  let hasLocation = false;
  const settingsDialog = initSettingsDialog(
    (settings) => {
      hasLocation = settings.location !== null;
      // 前の地点の文を、新しい地点のマーカーと並べて見せない
      el('news-body').hidden = true;
      el('clock-weather').hidden = true;
      if (settings.location) globe.focusLocation(settings.location);
      void refreshNews();
    },
    () => {
      if (hasLocation) void refreshNews();
    },
  );

  refreshBtn.addEventListener('click', () => {
    if (hasLocation) void refreshNews();
    else void settingsDialog.open();
  });
  el('open-settings').addEventListener('click', () => void settingsDialog.open());

  try {
    const settings = await window.weatherApi.getSettings();
    hasLocation = settings.location !== null;
    if (settings.location) {
      globe.startFromOverview(settings.location);
      void refreshNews();
    } else {
      setStatus('天気を表示する地点を設定してください。');
      await settingsDialog.open();
    }
  } catch (err) {
    setStatus(errorMessage(err), true);
    refreshBtn.disabled = true;
    return;
  }

  window.setInterval(() => {
    if (hasLocation) void refreshNews();
  }, NEWS_REFRESH_MS);
}

void init();
