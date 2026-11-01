import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Globe, createCoastlines, createBorders, lonLatToVector3 } from './globe';
import { WindField, makeSyntheticWind } from './wind';
import { ParticleSystem, COLOR_SCHEMES } from './particles';
import { GpuParticleSystem } from './gpu-particles';
import { SpeedOverlay } from './overlay';
import { RAMP_MAX_SPEED } from './wind-texture';
import { weatherIcon } from './icons';
import { RealisticEarth } from './earth';
import { adaptExposure, earthClearance, screenPresence, targetExposure } from './exposure';
import { HdrPipeline } from './hdr';
import { Sky } from './sky';

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
const COASTLINE_OPACITY = 0.9; // 風速モード
const EARTH_COASTLINE_OPACITY = 0.1; // 写実的な地球の上では控えめにする
const BORDER_OPACITY = 0.3;
const EARTH_BORDER_OPACITY = 0.04;
const SKY_UPDATE_MS = 60_000; // 太陽も星も 1 分で 0.25° しか動かない

const REFERENCE_HZ = 120; // 粒子の移動量と軌跡の長さ、カメラの慣性はこの更新回数を基準に合わせてある
const MAX_PARTICLE_STEPS = 6; // 1 フレームで進める粒子の更新回数の上限
const FRAME_TOLERANCE_MS = 1; // 垂直同期のゆらぎで 1 回分飛ばさないよう、少し早めに通す
const DAMPING_AT_REFERENCE = 0.08;

const MIN_DIST = 1.2;
const MAX_DIST = 8;
const FOCUS_DIST = 2.15; // 風速モードで地点に寄ったときのカメラ距離
const EARTH_VIEW_DIST = 3.3; // 通常・天気モードは地球全体が見える距離にする
const OVERVIEW_DIST = 4.6;
const FLY_SECONDS = 2.8;
const PANEL_OVERLAP_WIDTH = 900; // これより狭い画面ではパネルを下に置く

const NEWS_REFRESH_MS = 15 * 60_000; // Open-Meteo の現在値は 15 分刻み
const LAYER_REFRESH_MS = 60 * 60_000; // 地図のデータの取得元は 3 時間刻みで、結果もキャッシュされる

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
  controls.dampingFactor = DAMPING_AT_REFERENCE;
  controls.enablePan = false;
  controls.minDistance = MIN_DIST;
  controls.maxDistance = MAX_DIST;
  renderer.domElement.classList.add('globe-canvas');

  // 風速モードの地球。写実的な地球の読み込みが終わるまでの代わりにも使う
  const flatGlobe = new Globe(
    GLOBE_RADIUS,
    { ocean: COLORS.ocean, land: COLORS.land, graticule: COLORS.graticule },
    COLORS.halo,
  );
  scene.add(flatGlobe.group);

  const earth = new RealisticEarth(GLOBE_RADIUS * 1.0005);
  earth.group.visible = false;
  scene.add(earth.group);
  let earthReady = false;

  const hdr = new HdrPipeline(renderer, scene, camera);
  const flatBackground = new THREE.Color(COLORS.background);
  const spaceBackground = createSpaceBackground();

  // ベクター海岸線・国境線 (LOD 付き)。地表より少し浮かせて Z ファイティングを避ける
  const coastlines = createCoastlines(GLOBE_RADIUS * 1.0015);
  coastlines.setColor(COLORS.coastline);
  coastlines.setOpacity(COASTLINE_OPACITY);
  const borders = createBorders(GLOBE_RADIUS * 1.0014);
  scene.add(coastlines.group, borders.group);

  const overlay = new SpeedOverlay(GLOBE_RADIUS * 1.0008);
  overlay.setColorStops(COLOR_STOPS);
  overlay.setOpacity(OVERLAY_OPACITY);
  scene.add(overlay.mesh);

  // 実際の星、太陽、月 (通常・天気モード)
  const sky = new Sky(renderer.getPixelRatio());
  scene.add(sky.group);

  // 風速モードの薄い星空
  let windStars: THREE.Points;
  {
    const starCount = 1200;
    const positions = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(40 + Math.random() * 20);
      positions.set([v.x, v.y, v.z], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    windStars = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ color: COLORS.stars, size: 0.06, sizeAttenuation: true }),
    );
    scene.add(windStars);
  }

  let gpuParticles: GpuParticleSystem | null = null;
  let cpuParticles: ParticleSystem | null = null;
  let mode: MapMode = 'normal';
  let showMapLines = true;

  // 風速モードは線がないと風の場所が分からないので、設定にかかわらず描く
  function syncMapLines(): void {
    const visible = mode === 'wind' || showMapLines;
    coastlines.group.visible = visible;
    borders.group.visible = visible;
  }

  function updateSky(): void {
    sky.setTime(new Date());
    earth.setSunDirection(sky.sunDir);
  }

  function setMode(next: MapMode): void {
    // 隠している間に古くなった軌跡を、戻ったときに見せない
    if (next === 'wind' && mode !== 'wind') gpuParticles?.resize();
    mode = next;
    const wind = mode === 'wind';
    overlay.setEnabled(wind);
    if (cpuParticles) cpuParticles.object3d.visible = wind;
    // 風速モードは昼夜も天体も描かず、風だけを見せる
    earth.group.visible = !wind && earthReady;
    flatGlobe.group.visible = wind || !earthReady;
    earth.setCloudsEnabled(mode === 'weather');
    if (wind) earth.hideCloudsNow();
    sky.group.visible = !wind;
    windStars.visible = wind;
    scene.background = wind ? flatBackground : spaceBackground;
    coastlines.setOpacity(wind ? COASTLINE_OPACITY : EARTH_COASTLINE_OPACITY);
    borders.setOpacity(wind ? BORDER_OPACITY : EARTH_BORDER_OPACITY);
    syncMapLines();
  }
  setMode(mode);

  void Promise.all([loadEarthTexture('earth-day', renderer), loadEarthTexture('earth-night', renderer)])
    .then(([day, night]) => {
      earth.setTextures(day, night);
      earthReady = true;
      setMode(mode);
    })
    .catch((err) => console.error('earth texture load failed', err));

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
      cpuParticles.object3d.visible = mode === 'wind';
      scene.add(cpuParticles.object3d);
    }
  }

  updateSky();
  window.setInterval(updateSky, SKY_UPDATE_MS);

  // 地点へのカメラ移動。移動中は OrbitControls を止め、操作されたら打ち切る
  let flight: { from: THREE.Vector3; to: THREE.Vector3; elapsed: number } | null = null;
  const marker = el('marker');
  const markerPos = new THREE.Vector3();
  const projected = new THREE.Vector3();
  let markerNormal: THREE.Vector3 | null = null;
  let focused: WeatherLocation | null = null;

  renderer.domElement.addEventListener('pointerdown', () => {
    flight = null;
  });
  renderer.domElement.addEventListener('wheel', () => {
    flight = null;
  });

  function focusLocation(location: WeatherLocation): void {
    focused = location;
    el('marker-label').textContent = location.name;
    lonLatToVector3(location.longitude, location.latitude, PARTICLE_RADIUS, markerPos);
    markerNormal = markerPos.clone().normalize();
    marker.hidden = false;
    flight = {
      from: camera.position.clone(),
      to: markerNormal.clone().multiplyScalar(mode === 'wind' ? FOCUS_DIST : EARTH_VIEW_DIST),
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

  function returnToLocation(): void {
    if (focused) focusLocation(focused);
  }

  // 風速モードと他のモードでは見やすい距離が違うので、向きは保ったまま距離だけ変える
  function changeMode(next: MapMode): void {
    const crossesWind = (mode === 'wind') !== (next === 'wind');
    setMode(next);
    if (!crossesWind) return;
    flight = {
      from: camera.position.clone(),
      to: camera.position.clone().setLength(next === 'wind' ? FOCUS_DIST : EARTH_VIEW_DIST),
      elapsed: 0,
    };
  }

  function updateFlight(dt: number): void {
    if (!flight) {
      // 寄るほどゆっくり回し、触ったときに地表が指に付いてくる感覚に近づける
      const altitude = camera.position.length() - GLOBE_RADIUS;
      controls.rotateSpeed = THREE.MathUtils.clamp(altitude * 0.32, 0.05, 0.6);
      // 慣性はフレームごとに減衰するので、FPS によらず同じ時間で止まるように換算する
      controls.dampingFactor = 1 - Math.pow(1 - DAMPING_AT_REFERENCE, dt * REFERENCE_HZ);
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
    hdr.setSize(window.innerWidth, window.innerHeight);
    gpuParticles?.resize();
  });

  // 太陽の見え方から露出を決める。風速モードでは使わない
  let exposure = 1;
  let autoExposure = true;
  const toSun = new THREE.Vector3();
  const sunNdc = new THREE.Vector3();
  function updateExposure(dt: number): void {
    toSun.copy(sky.sunPosition).sub(camera.position).normalize();
    // カメラは常に地球の中心を向くので、太陽が手前側にあるかは位置だけで分かる
    const inFront = toSun.dot(camera.position) < 0;
    sunNdc.copy(sky.sunPosition).project(camera);
    const visibility =
      screenPresence(sunNdc.x, sunNdc.y, inFront) *
      earthClearance(
        [camera.position.x, camera.position.y, camera.position.z],
        [toSun.x, toSun.y, toSun.z],
        GLOBE_RADIUS,
      );
    const facing = camera.position.clone().normalize().dot(sky.sunDir);
    exposure = adaptExposure(exposure, autoExposure ? targetExposure(facing, visibility) : 1, dt);
    hdr.setExposure(exposure, autoExposure ? visibility : 0);
  }

  let fpsLimit = 0;
  const fpsCounter = el('fps-counter');
  function applyGraphics(graphics: GraphicsSettings): void {
    fpsLimit = graphics.fps_limit;
    autoExposure = graphics.auto_exposure;
    hdr.setBloomEnabled(graphics.bloom);
    sky.setStarBrightness(graphics.star_brightness);
    showMapLines = graphics.show_map_lines;
    syncMapLines();
    fpsCounter.hidden = !graphics.show_fps;
    const ratio = (Math.min(window.devicePixelRatio, 2) * graphics.render_scale) / 100;
    if (ratio !== renderer.getPixelRatio()) {
      renderer.setPixelRatio(ratio);
      hdr.setPixelRatio(ratio);
      sky.setPixelRatio(ratio);
      gpuParticles?.resize();
    }
  }

  let lastFrameTime = 0;
  let nextFrameTime = 0;
  let particleClock = 0;
  let particleSteps = 0;
  let renderedFrames = 0;
  let fpsWindowStart = 0;
  let fpsWindowFrames = 0;
  renderer.setAnimationLoop((time: number) => {
    if (time < nextFrameTime - FRAME_TOLERANCE_MS) return;
    // 余りを持ち越し、リフレッシュレートが上限の整数倍でなくても平均を上限に合わせる
    const interval = fpsLimit > 0 ? 1000 / fpsLimit : 0;
    nextFrameTime = interval > 0 ? Math.max(nextFrameTime + interval, time + interval / 2) : 0;
    const dt = lastFrameTime === 0 ? 0.016 : Math.min(0.1, (time - lastFrameTime) / 1000);
    lastFrameTime = time;

    renderedFrames++;
    fpsWindowFrames++;
    if (time - fpsWindowStart >= 1000) {
      fpsCounter.textContent = `${Math.round((fpsWindowFrames * 1000) / (time - fpsWindowStart))} FPS`;
      fpsWindowStart = time;
      fpsWindowFrames = 0;
    }

    updateFlight(dt);
    coastlines.update(camera.position.length());
    borders.update(camera.position.length());
    // 粒子は風速モードのときだけ動かす (他のモードでは GPU を使わない)。
    // 1 回の更新で動く量は一定なので、FPS によらず同じ速さになるよう回数を時間で決める
    if (mode === 'wind') {
      particleClock += dt * REFERENCE_HZ;
      const steps = Math.min(MAX_PARTICLE_STEPS, Math.floor(particleClock + 1e-3));
      particleClock = steps === MAX_PARTICLE_STEPS ? 0 : particleClock - steps;
      for (let i = 0; i < steps; i++) {
        gpuParticles?.update(camera);
        cpuParticles?.update();
      }
      particleSteps += steps;
    }
    // 風速モードは元の見た目のまま、HDR の処理を通さず画面へ直接描く
    if (mode !== 'wind' && earthReady) {
      earth.updateClouds(dt);
      updateExposure(dt);
      hdr.render();
    } else {
      renderer.render(scene, camera);
    }
    if (mode === 'wind') gpuParticles?.composite();
    updateMarker();
  });

  // 動作検証用: 太陽や月が地球の横に見える位置へカメラを動かす
  (window as unknown as Record<string, unknown>).__weatherNewsDebug = {
    exposure: () => exposure,
    cloudProgress: () => earth.cloudProgress,
    camera,
    sky,
    mapLinesVisible: () => [coastlines.group.visible, borders.group.visible],
    stats: () => ({ renderedFrames, particleSteps, canvasWidth: renderer.domElement.width }),
    peekAt(body: 'sun' | 'moon' | 'dayside' | 'sunrise'): void {
      flight = null;
      if (body === 'dayside') {
        camera.position.copy(sky.sunDir).multiplyScalar(EARTH_VIEW_DIST);
        return;
      }
      const target = body === 'moon' ? sky.moonDir : sky.sunDir;
      const side = new THREE.Vector3(0, 1, 0).cross(target).normalize();
      camera.position.copy(target).multiplyScalar(-4).addScaledVector(side, body === 'sunrise' ? -1.03 : -1.6);
    },
  };

  return {
    applyGraphics,
    changeMode,
    setWind,
    setClouds: earth.setCloudData.bind(earth),
    focusLocation,
    startFromOverview,
    returnToLocation,
  };
}

function createSpaceBackground(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(440, 512, 60, 440, 512, 800);
  gradient.addColorStop(0, '#0f2448');
  gradient.addColorStop(0.45, '#07122b');
  gradient.addColorStop(1, '#02040b');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1024, 1024);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// file:// の画像は WebGL で使えないので、メインプロセスから受け取ったバイト列を読み込む
async function loadEarthTexture(
  name: 'earth-day' | 'earth-night',
  renderer: THREE.WebGLRenderer,
): Promise<THREE.Texture> {
  const bytes = await window.weatherApi.getTexture(name);
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }), {
    imageOrientation: 'flipY',
  });
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false;
  if (name === 'earth-day') texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}

interface LayerCaption {
  text: string;
  warn: boolean;
}

function validTimeLabel(refTime: string, forecastHours: number): string {
  return new Date(new Date(refTime).getTime() + forecastHours * 3600_000).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
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
  onGraphicsChange: (graphics: GraphicsSettings) => void,
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

  const fpsSelect = el<HTMLSelectElement>('fps-limit');
  const scaleSelect = el<HTMLSelectElement>('render-scale');
  const bloomToggle = el<HTMLInputElement>('bloom-toggle');
  const exposureToggle = el<HTMLInputElement>('exposure-toggle');
  const fpsToggle = el<HTMLInputElement>('fps-toggle');
  const mapLinesToggle = el<HTMLInputElement>('map-lines-toggle');
  const starSlider = el<HTMLInputElement>('star-brightness');

  // スライダーは対数にして、1 目盛りごとに同じ比率で変わるようにする
  function showStarBrightness(): void {
    el('star-brightness-value').textContent = `×${(2 ** Number(starSlider.value)).toFixed(2)}`;
  }

  function readGraphics(): GraphicsSettings {
    return {
      fps_limit: Number(fpsSelect.value),
      render_scale: Number(scaleSelect.value),
      bloom: bloomToggle.checked,
      auto_exposure: exposureToggle.checked,
      show_fps: fpsToggle.checked,
      show_map_lines: mapLinesToggle.checked,
      star_brightness: 2 ** Number(starSlider.value),
    };
  }

  function showGraphics(graphics: GraphicsSettings): void {
    fpsSelect.value = String(graphics.fps_limit);
    scaleSelect.value = String(graphics.render_scale);
    bloomToggle.checked = graphics.bloom;
    exposureToggle.checked = graphics.auto_exposure;
    fpsToggle.checked = graphics.show_fps;
    mapLinesToggle.checked = graphics.show_map_lines;
    starSlider.value = String(Math.log2(graphics.star_brightness));
    showStarBrightness();
  }

  // 変更はすぐ画面に反映し、そのあと保存する。保存は順番に行い、最後の操作が必ず残るようにする
  let graphicsSave: Promise<unknown> = Promise.resolve();
  // スライダーは動かしている間も画面に反映し、離したときに保存する
  starSlider.addEventListener('input', () => {
    showStarBrightness();
    onGraphicsChange(readGraphics());
  });
  for (const control of [fpsSelect, scaleSelect, bloomToggle, exposureToggle, mapLinesToggle, fpsToggle, starSlider]) {
    control.addEventListener('change', () => {
      const graphics = readGraphics();
      onGraphicsChange(graphics);
      const status = el('graphics-status');
      graphicsSave = graphicsSave
        .then(() => window.weatherApi.setGraphics(graphics))
        .then((saved) => {
          settings = saved;
          setStatus(status, '');
        })
        .catch((err) => setStatus(status, errorMessage(err), true));
    });
  }

  async function open(): Promise<void> {
    settings = await window.weatherApi.getSettings();
    dirInput.value = settings.models_dir;
    showCurrentLocation();
    if (settings.graphics) showGraphics(settings.graphics);
    dialog.showModal();
    await loadModels();
  }

  return { open };
}

// PC の時刻を表示する。スリープ復帰後もすぐ合うよう、毎秒確かめて変わったときだけ書き換える
function initClock(): void {
  const timeEl = el('clock-time');
  const dateEl = el('clock-date');
  // 日付の文字数は月日で変わるので、文字の大きさを変えて時刻と同じ幅に揃える
  const fitDate = (): void => {
    dateEl.style.fontSize = '';
    const base = parseFloat(getComputedStyle(dateEl).fontSize);
    const ratio = timeEl.getBoundingClientRect().width / dateEl.getBoundingClientRect().width;
    dateEl.style.fontSize = `${base * ratio}px`;
  };
  const update = (): void => {
    const now = new Date();
    const time = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const date = now.toLocaleDateString('ja-JP', {
      month: 'long',
      day: 'numeric',
      weekday: 'short',
    });
    if (timeEl.textContent !== time) timeEl.textContent = time;
    if (dateEl.textContent !== date) {
      dateEl.textContent = date;
      fitDate();
    }
  };
  update();
  window.setInterval(update, 1000);
  void document.fonts.ready.then(fitDate);
}

async function init(): Promise<void> {
  initClock();
  const globe = initGlobe();
  const windLegend = `linear-gradient(to right, ${COLOR_STOPS.map(
    ([speed, [r, g, b]]) => `rgb(${r} ${g} ${b}) ${(speed / RAMP_MAX_SPEED) * 100}%`,
  ).join(', ')})`;
  const cloudLegend = 'linear-gradient(to right, rgb(240 245 255 / 0.08), rgb(240 245 255))';

  // データは、そのモードに入ったときに初めて取得する
  type DataMode = Exclude<MapMode, 'normal'>;
  const layers: Record<DataMode, { caption: LayerCaption | null; loadedAt: number; loading: boolean; load: () => Promise<LayerCaption> }> = {
    weather: { caption: null, loadedAt: 0, loading: false, load: () => loadClouds(globe.setClouds) },
    wind: { caption: null, loadedAt: 0, loading: false, load: () => loadWind(globe.setWind) },
  };
  let mode: MapMode = 'normal';

  function renderLayerInfo(): void {
    const info = el('layer-info');
    info.hidden = mode === 'normal';
    if (mode === 'normal') return;
    el('legend-bar').style.background = mode === 'wind' ? windLegend : cloudLegend;
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

  const modeButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#mode-switch button'),
  );

  function applyMode(next: MapMode): void {
    mode = next;
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === next));
    }
    globe.changeMode(next);
    renderLayerInfo();
    void loadLayer(next);
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
  window.setInterval(() => void loadLayer(mode), LAYER_REFRESH_MS);

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
    (graphics) => globe.applyGraphics(graphics),
  );

  refreshBtn.addEventListener('click', () => {
    if (hasLocation) void refreshNews();
    else void settingsDialog.open();
  });
  el('open-settings').addEventListener('click', () => void settingsDialog.open());
  el('return-home').addEventListener('click', () => globe.returnToLocation());

  try {
    const settings = await window.weatherApi.getSettings();
    hasLocation = settings.location !== null;
    if (settings.graphics) globe.applyGraphics(settings.graphics);
    applyMode(settings.mode ?? 'normal');
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
