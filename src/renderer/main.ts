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
import { streamParagraphs } from './stream';
import {
  approachDistance,
  clampRegionDistance,
  clampRegionView,
  coastRegionView,
  interpolateRegionView,
  lonLatOf,
  panRegionView,
  REGION_DISTANCE,
  REGION_STILL,
  REGION_TILT,
  regionPose,
  type LonLat,
  type RegionVelocity,
  type RegionView,
} from './region-camera';
import { RegionDetail } from './region-detail';

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

const EARTH_SURFACE_RADIUS = GLOBE_RADIUS * 1.0005;
const COASTLINE_RADIUS = GLOBE_RADIUS * 1.0015;
const BORDER_RADIUS = GLOBE_RADIUS * 1.0014;
const REGION_LINE_RADIUS = GLOBE_RADIUS * 1.0007; // 斜めに見ると線が地表からずれるので、地域ビューでは地表へ寄せる
const CAMERA_NEAR_MAX = 0.1;
const CAMERA_NEAR_MIN = 0.005;
const CLOUD_TOP = 0.012; // 雲の層の最も高い位置。カメラの手前の範囲はこれより内側に保つ
const REGION_BLEND_SECONDS = 0.5;
const REGION_RELEASE_BLEND = 0.01; // 地球ビューへ戻って、高解像度の画像が見えなくなったら解放する
const WHEEL_ZOOM_RATE = 0.0012;
const ROTATE_DEGREES_PER_HEIGHT = 180; // 右ドラッグで画面の高さぶん動かしたときの回転
const TILT_DEGREES_PER_HEIGHT = 90;
const VELOCITY_SMOOTHING = 0.5;
const VELOCITY_MIN_INTERVAL_MS = 16; // 間隔の詰まったイベントで速さを過大に見積もらない
const FLING_MAX_IDLE_MS = 80; // 止まってから指を離したら慣性を付けない

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

  const earth = new RealisticEarth(EARTH_SURFACE_RADIUS);
  earth.group.visible = false;
  scene.add(earth.group);
  let earthReady = false;

  const hdr = new HdrPipeline(renderer, scene, camera);
  const flatBackground = new THREE.Color(COLORS.background);
  const spaceBackground = createSpaceBackground();

  // ベクター海岸線・国境線 (LOD 付き)。地表より少し浮かせて Z ファイティングを避ける
  const coastlines = createCoastlines(COASTLINE_RADIUS);
  coastlines.setColor(COLORS.coastline);
  coastlines.setOpacity(COASTLINE_OPACITY);
  const borders = createBorders(BORDER_RADIUS);
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

  void Promise.all([
    loadEarthTexture('earth-day', renderer),
    loadEarthTexture('earth-night', renderer),
    loadEarthTexture('earth-water', renderer),
  ])
    .then(([day, night, water]) => {
      earth.setTextures(day, night, water);
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

  // 地域ビュー。null の間は地球ビューで、OrbitControls がカメラを動かす
  let regionView: RegionView | null = null;
  let regionFlight: { from: RegionView; to: RegionView; elapsed: number; leaving: boolean } | null = null;
  let regionVelocity: RegionVelocity = REGION_STILL;
  let regionDistanceGoal = REGION_DISTANCE;
  let regionBlend = 0;
  let regionDrag: { button: number; grabbed: LonLat | null; x: number; y: number; time: number } | null = null;
  const pointerRay = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const earthSphere = new THREE.Sphere(new THREE.Vector3(), EARTH_SURFACE_RADIUS);
  const pointerHit = new THREE.Vector3();

  function applyRegionPose(view: RegionView): void {
    const { position, target, up } = regionPose(view);
    camera.position.set(...position);
    camera.up.set(...up);
    camera.lookAt(...target);
    camera.updateMatrixWorld();
  }

  function groundUnderPointer(event: PointerEvent): LonLat | null {
    pointerNdc.set((event.clientX / window.innerWidth) * 2 - 1, 1 - (event.clientY / window.innerHeight) * 2);
    pointerRay.setFromCamera(pointerNdc, camera);
    const hit = pointerRay.ray.intersectSphere(earthSphere, pointerHit);
    return hit ? lonLatOf([hit.x, hit.y, hit.z]) : null;
  }

  function flyRegion(to: RegionView, leaving: boolean): void {
    if (!regionView) return;
    regionFlight = { from: regionView, to, elapsed: 0, leaving };
    regionVelocity = REGION_STILL;
    regionDrag = null;
  }

  // 真上から見た地球ビューの姿勢から続けて、傾きながら地点へ寄る
  function regionHomeOf(from: LonLat): RegionView {
    return {
      lat: focused?.latitude ?? from.lat,
      lon: focused?.longitude ?? from.lon,
      heading: 0,
      tilt: REGION_TILT,
      distance: REGION_DISTANCE,
    };
  }

  // 高解像度の画像は VRAM を多く使うので、地域ビューの間だけ持つ
  let regionDetail: RegionDetail | null = null;
  let regionRelief: THREE.Texture | null = null;
  let regionReliefRequested = false;
  let regionDetailEnabled = true;
  let regionBloom = 1;
  const viewStatus = el('view-status');

  function startRegionDetail(): void {
    if (!regionDetailEnabled) return;
    if (!regionDetail && RegionDetail.isSupported(renderer)) {
      regionDetail = new RegionDetail(renderer, (layer, col, row) => window.weatherApi.getEarthTile(layer, col, row));
      earth.setRegionDetail(regionDetail);
    }
    if (regionReliefRequested) return;
    regionReliefRequested = true;
    loadEarthTexture('earth-relief', renderer)
      .then((texture) => {
        // 読み込みの間に地球ビューへ戻っていたり、切り替えを繰り返して先に届いていたら使わない
        if (!regionReliefRequested || regionRelief) {
          texture.dispose();
          return;
        }
        regionRelief = texture;
        earth.setRelief(texture);
      })
      .catch((err) => console.error('relief texture load failed', err));
  }

  function stopRegionDetail(): void {
    earth.setRegionDetail(null);
    regionDetail?.dispose();
    regionDetail = null;
    earth.setRelief(null);
    regionRelief?.dispose();
    regionRelief = null;
    regionReliefRequested = false;
    viewStatus.hidden = true;
  }

  function updateRegionDetail(dt: number): void {
    if (regionView && !regionFlight?.leaving) {
      if (!regionDetail) return;
      // 飛んでいる間は行き先のタイルを先に読む
      const center = regionFlight?.to ?? regionView;
      regionDetail.setView(center.lat, center.lon);
      regionDetail.update(dt);
      const { shown, total, failed } = regionDetail.progress;
      viewStatus.classList.toggle('warn', failed > 0);
      viewStatus.hidden = shown === total;
      if (!viewStatus.hidden) {
        viewStatus.textContent = failed > 0
          ? '一部の高解像度の画像を取得できず、粗い画像で表示しています'
          : `高解像度の画像を読み込んでいます(${shown}/${total})`;
      }
      return;
    }
    viewStatus.hidden = true;
    if (!regionView && regionDetail && regionBlend < REGION_RELEASE_BLEND) stopRegionDetail();
  }

  function enterRegion(): void {
    if (mode === 'wind' || (regionView && !regionFlight?.leaving)) return;
    flight = null;
    controls.enabled = false;
    startRegionDetail();
    regionView ??= {
      ...lonLatOf([camera.position.x, camera.position.y, camera.position.z]),
      heading: 0,
      tilt: 0,
      distance: camera.position.length() - GLOBE_RADIUS,
    };
    flyRegion(regionHomeOf(regionView), false);
  }

  // 真上から見た姿勢まで戻してから、地球ビューの操作へ引き渡す
  function leaveRegion(distance: number): void {
    if (!regionView) return;
    flyRegion({ ...regionView, heading: 0, tilt: 0, distance: distance - GLOBE_RADIUS }, true);
  }

  function updateRegion(dt: number): void {
    if (!regionView) return;
    if (regionFlight) {
      regionFlight.elapsed = Math.min(FLY_SECONDS, regionFlight.elapsed + dt);
      const t = regionFlight.elapsed / FLY_SECONDS;
      regionView = interpolateRegionView(regionFlight.from, regionFlight.to, t * t * (3 - 2 * t));
      regionDistanceGoal = clampRegionDistance(regionView.distance);
      if (regionFlight.elapsed >= FLY_SECONDS) {
        const { leaving } = regionFlight;
        regionFlight = null;
        if (leaving) {
          applyRegionPose(regionView);
          regionView = null;
          camera.up.set(0, 1, 0);
          camera.lookAt(0, 0, 0);
          controls.enabled = true;
          return;
        }
      }
    } else {
      if (!regionDrag) {
        ({ view: regionView, velocity: regionVelocity } = coastRegionView(regionView, regionVelocity, dt));
      }
      regionView = clampRegionView({
        ...regionView,
        distance: approachDistance(regionView.distance, regionDistanceGoal, dt),
      });
    }
    applyRegionPose(regionView);
  }

  renderer.domElement.addEventListener('pointerdown', (event) => {
    flight = null;
    if (!regionView || regionFlight?.leaving) return;
    regionFlight = null;
    regionVelocity = REGION_STILL;
    regionDrag = {
      button: event.button,
      grabbed: event.button === 0 ? groundUnderPointer(event) : null,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
    };
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (!regionView || !regionDrag) return;
    const before = regionView;
    if (regionDrag.button === 0) {
      const current = groundUnderPointer(event);
      if (current && !regionDrag.grabbed) regionDrag.grabbed = current; // 空からドラッグして地面に入ったとき
      if (current && regionDrag.grabbed) regionView = panRegionView(regionView, regionDrag.grabbed, current);
    } else if (regionDrag.button === 2) {
      regionView = clampRegionView({
        ...regionView,
        heading: regionView.heading + ((event.clientX - regionDrag.x) / window.innerHeight) * ROTATE_DEGREES_PER_HEIGHT,
        tilt: regionView.tilt - ((event.clientY - regionDrag.y) / window.innerHeight) * TILT_DEGREES_PER_HEIGHT,
      });
    }
    applyRegionPose(regionView);
    // 指を離したあとの慣性のために、動く速さをならして覚えておく
    const seconds = Math.max(event.timeStamp - regionDrag.time, VELOCITY_MIN_INTERVAL_MS) / 1000;
    const after = regionView;
    const speed = (delta: number): number => (delta / seconds) * VELOCITY_SMOOTHING;
    const carried = (old: number, delta: number): number => old * (1 - VELOCITY_SMOOTHING) + speed(delta);
    const wrapped = (delta: number): number => ((delta + 540) % 360) - 180;
    regionVelocity = {
      lat: carried(regionVelocity.lat, after.lat - before.lat),
      lon: carried(regionVelocity.lon, wrapped(after.lon - before.lon)),
      heading: carried(regionVelocity.heading, wrapped(after.heading - before.heading)),
      tilt: carried(regionVelocity.tilt, after.tilt - before.tilt),
    };
    regionDrag.x = event.clientX;
    regionDrag.y = event.clientY;
    regionDrag.time = event.timeStamp;
  });
  const endRegionDrag = (event: PointerEvent): void => {
    if (!regionDrag) return;
    if (event.timeStamp - regionDrag.time > FLING_MAX_IDLE_MS) regionVelocity = REGION_STILL;
    regionDrag = null;
  };
  renderer.domElement.addEventListener('pointerup', endRegionDrag);
  renderer.domElement.addEventListener('pointercancel', endRegionDrag);
  renderer.domElement.addEventListener('wheel', (event) => {
    flight = null;
    if (!regionView || regionFlight?.leaving) return;
    regionFlight = null;
    regionDistanceGoal = clampRegionDistance(regionDistanceGoal * Math.exp(event.deltaY * WHEEL_ZOOM_RATE));
  });

  // 地表へ近づいても欠けないよう、カメラの手前の描画範囲は高度に合わせる
  function updateNearPlane(): void {
    const altitude = camera.position.length() - GLOBE_RADIUS;
    const near = THREE.MathUtils.clamp((altitude - CLOUD_TOP) * 0.5, CAMERA_NEAR_MIN, CAMERA_NEAR_MAX);
    if (near === camera.near) return;
    camera.near = near;
    camera.updateProjectionMatrix();
  }

  function updateRegionBlend(dt: number): void {
    const goal = regionView && !regionFlight?.leaving ? 1 : 0;
    regionBlend += (goal - regionBlend) * (1 - Math.exp(-dt / REGION_BLEND_SECONDS));
    earth.setRegionBlend(regionBlend);
    // 風速モードでは粒子の面より上に線を置く必要があるので、元の高さのまま
    const lineRadius = (radius: number): number =>
      THREE.MathUtils.lerp(radius, mode === 'wind' ? radius : REGION_LINE_RADIUS, regionBlend) / radius;
    coastlines.group.scale.setScalar(lineRadius(COASTLINE_RADIUS));
    borders.group.scale.setScalar(lineRadius(BORDER_RADIUS));
  }

  function focusLocation(location: WeatherLocation): void {
    focused = location;
    el('marker-label').textContent = location.name;
    lonLatToVector3(location.longitude, location.latitude, EARTH_SURFACE_RADIUS, markerPos);
    markerNormal = markerPos.clone().normalize();
    marker.hidden = false;
    if (regionView) {
      if (!regionFlight?.leaving) flyRegion(regionHomeOf(regionView), false);
      return;
    }
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
    if (regionView) {
      leaveRegion(next === 'wind' ? FOCUS_DIST : EARTH_VIEW_DIST); // 風速モードに地域ビューはない
      return;
    }
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
    projected.copy(markerPos).project(camera);
    // 斜めの視点では、地平線より手前でもカメラの後ろにあることがある (このとき z は 1 を超える)
    const visible = facing > GLOBE_RADIUS / camera.position.length() && projected.z < 1;
    marker.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) return;
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
  const cameraForward = new THREE.Vector3();
  function updateExposure(dt: number): void {
    toSun.copy(sky.sunPosition).sub(camera.position).normalize();
    const inFront = toSun.dot(camera.getWorldDirection(cameraForward)) > 0;
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
    hdr.setExposure(exposure, autoExposure ? visibility : 0, THREE.MathUtils.lerp(1, regionBloom, regionBlend));
  }

  let fpsLimit = 0;
  const fpsCounter = el('fps-counter');
  function applyGraphics(graphics: GraphicsSettings): void {
    fpsLimit = graphics.fps_limit;
    autoExposure = graphics.auto_exposure;
    hdr.setBloomEnabled(graphics.bloom);
    sky.setStarBrightness(graphics.star_brightness);
    earth.setCloudShadow(graphics.cloud_shadow);
    regionBloom = graphics.region_bloom;
    regionDetailEnabled = graphics.region_detail;
    if (!regionDetailEnabled) stopRegionDetail();
    else if (regionView && !regionFlight?.leaving) startRegionDetail();
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

    if (regionView) updateRegion(dt);
    else updateFlight(dt);
    updateNearPlane();
    updateRegionBlend(dt);
    updateRegionDetail(dt);
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
    earth,
    regionView: () => regionView,
    regionDetailProgress: () => regionDetail?.progress ?? null,
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
    setView(next: GlobeView): void {
      if (next === 'region') enterRegion();
      else leaveRegion(EARTH_VIEW_DIST);
    },
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
  name: 'earth-day' | 'earth-night' | 'earth-relief' | 'earth-water',
  renderer: THREE.WebGLRenderer,
): Promise<THREE.Texture> {
  const bytes = await window.weatherApi.getTexture(name);
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    imageOrientation: 'flipY',
  });
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false;
  if (name === 'earth-water') texture.format = THREE.RedFormat; // 1 色だけなので、メモリを 4 分の 1 にする
  if (name === 'earth-day' || name === 'earth-relief') texture.colorSpace = THREE.SRGBColorSpace;
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

// 予報の表は時刻や日付を横に並べる。行ごとに、各列のセルの中身を入れる
function fillRow<T>(
  id: string,
  items: T[],
  fill: (cell: HTMLTableCellElement, item: T, index: number) => void,
): void {
  const row = el<HTMLTableRowElement>(id);
  row.querySelectorAll('td').forEach((cell) => cell.remove());
  items.forEach((item, index) => fill(row.insertCell(), item, index));
}

function rainText(rain: number | null): string {
  return rain === null ? '–' : `${rain}%`;
}

function renderHourly(news: NewsReport): void {
  const textRow = (id: string, format: (h: NewsReport['hourly'][number]) => string): void =>
    fillRow(id, news.hourly, (cell, hour) => {
      cell.textContent = format(hour);
      cell.title = hour.weather;
    });
  textRow('hourly-time', (h) => h.time);
  textRow('hourly-temperature', (h) => `${h.temperature}°`);
  textRow('hourly-rain', (h) => rainText(h.rain));
  fillRow('hourly-icon', news.hourly, (cell, hour) => {
    cell.append(weatherIcon(hour.icon, hour.is_day, hour.weather, 24));
  });
}

function renderWeekly(news: NewsReport): void {
  const textRow = (id: string, format: (d: NewsReport['weekly'][number]) => string): void =>
    fillRow(id, news.weekly, (cell, day, index) => {
      cell.textContent = format(day);
      cell.title = day.weather;
      if (index === 0) cell.className = 'today';
    });
  textRow('weekly-day', (d) => d.label);
  textRow('weekly-high', (d) => `${d.high}°`);
  textRow('weekly-low', (d) => `${d.low}°`);
  textRow('weekly-rain', (d) => rainText(d.rain));
  fillRow('weekly-icon', news.weekly, (cell, day) => {
    cell.append(weatherIcon(day.icon, true, day.weather, 24));
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
  renderStat('stat-temperature', news.current.temperature.toFixed(1), '℃');
  renderStat('stat-apparent', news.current.apparent.toFixed(1), '℃');
  renderStat('stat-humidity', String(news.current.humidity), '%');
  renderStat('stat-wind', news.current.wind_speed.toFixed(1), 'm/s');
  renderStat('stat-gust', news.current.gust.toFixed(1), 'm/s');
  el('stat-wind').title = `${news.current.wind_direction}寄りの風`;
  renderHourly(news);
  renderWeekly(news);

  const { outlook } = news;
  el('outlook-text').hidden = !outlook;
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
  streamParagraphs([
    [el('current-text'), news.current_text],
    [el('day-text'), news.day_text],
    [el('outlook-text'), outlook?.text ?? ''],
  ]);
}

const RESET_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>';

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
  const shadowSlider = el<HTMLInputElement>('cloud-shadow');
  const regionBloomSlider = el<HTMLInputElement>('region-bloom');
  const regionDetailToggle = el<HTMLInputElement>('region-detail-toggle');

  function showCloudShadow(): void {
    el('cloud-shadow-value').textContent = `${shadowSlider.value}%`;
  }

  function showRegionBloom(): void {
    el('region-bloom-value').textContent = `${regionBloomSlider.value}%`;
  }

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
      cloud_shadow: Number(shadowSlider.value) / 100,
      region_bloom: Number(regionBloomSlider.value) / 100,
      region_detail: regionDetailToggle.checked,
    };
  }

  function showGraphics(graphics: GraphicsSettings): void {
    fpsSelect.value = String(graphics.fps_limit);
    scaleSelect.value = String(graphics.render_scale);
    bloomToggle.checked = graphics.bloom;
    exposureToggle.checked = graphics.auto_exposure;
    fpsToggle.checked = graphics.show_fps;
    mapLinesToggle.checked = graphics.show_map_lines;
    regionDetailToggle.checked = graphics.region_detail;
    starSlider.value = String(Math.log2(graphics.star_brightness));
    showStarBrightness();
    shadowSlider.value = String(Math.round(graphics.cloud_shadow * 100));
    showCloudShadow();
    regionBloomSlider.value = String(Math.round(graphics.region_bloom * 100));
    showRegionBloom();
  }

  // 変更はすぐ画面に反映し、そのあと保存する。保存は順番に行い、最後の操作が必ず残るようにする
  let graphicsSave: Promise<unknown> = Promise.resolve();
  function commitGraphics(): void {
    const graphics = readGraphics();
    onGraphicsChange(graphics);
    syncResetButtons();
    const status = el('graphics-status');
    graphicsSave = graphicsSave
      .then(() => window.weatherApi.setGraphics(graphics))
      .then((saved) => {
        settings = saved;
        setStatus(status, '');
      })
      .catch((err) => setStatus(status, errorMessage(err), true));
  }
  // スライダーは動かしている間も画面に反映し、離したときに保存する
  const sliders: Array<[HTMLInputElement, () => void]> = [
    [starSlider, showStarBrightness],
    [shadowSlider, showCloudShadow],
    [regionBloomSlider, showRegionBloom],
  ];
  for (const [slider, show] of sliders) {
    slider.addEventListener('input', () => {
      show();
      onGraphicsChange(readGraphics());
      syncResetButtons();
    });
  }
  for (const control of [fpsSelect, scaleSelect, bloomToggle, exposureToggle, mapLinesToggle, regionDetailToggle, fpsToggle, starSlider, shadowSlider, regionBloomSlider]) {
    control.addEventListener('change', commitGraphics);
  }

  // 既定値はサーバーの設定を元にする。取得できない間はボタンを押せないままにする
  let graphicsDefaults: GraphicsSettings | null = null;
  const resetButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[data-reset]'));
  const sectionResetButtons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[data-reset-section]'));

  const resetKey = (button: HTMLButtonElement): keyof GraphicsSettings =>
    button.dataset.reset as keyof GraphicsSettings;
  const rowsOfSection = (button: HTMLButtonElement): HTMLButtonElement[] =>
    resetButtons.filter((row) => row.closest('section') === button.closest('section'));

  function syncResetButtons(): void {
    const current = readGraphics();
    for (const button of resetButtons) {
      const key = resetKey(button);
      // スライダーは目盛りに丸められるので、わずかな差は同じ値として扱う
      button.disabled = !graphicsDefaults || Math.abs(Number(current[key]) - Number(graphicsDefaults[key])) < 1e-6;
    }
    for (const button of sectionResetButtons) {
      button.disabled = rowsOfSection(button).every((row) => row.disabled);
    }
  }

  function resetGraphics(rows: HTMLButtonElement[]): void {
    if (!graphicsDefaults) return;
    const defaults = graphicsDefaults;
    const entries = rows.map((row) => [resetKey(row), defaults[resetKey(row)]]);
    showGraphics({ ...readGraphics(), ...Object.fromEntries(entries) });
    commitGraphics();
  }

  for (const button of [...resetButtons, ...sectionResetButtons]) button.innerHTML = RESET_ICON;
  for (const button of resetButtons) button.addEventListener('click', () => resetGraphics([button]));
  for (const button of sectionResetButtons) {
    button.addEventListener('click', () => resetGraphics(rowsOfSection(button)));
  }

  async function open(): Promise<void> {
    settings = await window.weatherApi.getSettings();
    dirInput.value = settings.models_dir;
    showCurrentLocation();
    if (settings.graphics) showGraphics(settings.graphics);
    if (!graphicsDefaults) {
      graphicsDefaults = await window.weatherApi.getGraphicsDefaults().catch((err) => {
        console.error('graphics defaults load failed', err);
        return null;
      });
    }
    syncResetButtons();
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

async function init(): Promise<void> {
  initClock();
  initScreenshotToast();
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
  const viewButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('#view-switch button'),
  );

  function showView(view: GlobeView): void {
    for (const button of viewButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.view === view));
    }
    el('view-hint').hidden = view !== 'region';
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
