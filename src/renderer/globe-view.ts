// 地球儀の表示とカメラ操作。モード、地域ビュー、描画の設定をここで扱う
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { apparentScale, BASE_FOCAL_LENGTH, verticalFov } from './camera-lens';
import { CameraPanel } from './camera-panel';
import { EARTH_RADIUS_KM } from './camera-readout';
import { pickCityInDirection, type HopDirection } from './city-hop';
import { CityLabels } from './city-labels';
import { PlanetLabels } from './planet-labels';
import { SolarSystem } from './solar-system';
import { MAP_CITIES, tierAtAltitude, type MapCity } from './cities';
import type { DemoPlace } from './demo';
import { el } from './dom';
import { CLOUD_ALTITUDE, RealisticEarth } from './earth';
import { adaptExposure, earthClearance, horizonReddening, screenPresence, targetExposure } from './exposure';
import { formatFrameStats, GpuTimer } from './frame-timer';
import { createBorders, createCoastlines, Globe, lonLatToVector3 } from './globe';
import { GpuParticleSystem } from './gpu-particles';
import { HdrPipeline } from './hdr';
import { easeInOut, wrapDegrees, type LonLat } from './math';
import { SpeedOverlay } from './overlay';
import { ParticleSystem } from './particles';
import {
  approachDistance,
  clampRegionDistance,
  clampRegionView,
  coastRegionView,
  cruiseRegionView,
  interpolateRegionView,
  lonLatOf,
  panRegionView,
  REGION_DISTANCE,
  REGION_STILL,
  REGION_TILT,
  regionPose,
  type RegionVelocity,
  type RegionView,
} from './region-camera';
import { RegionDetail, type BaseTextures } from './region-detail';
import { Sky } from './sky';
import type { WindField } from './wind';
import { createWindUniforms, updateWindUniforms } from './wind-texture';

const COLORS = {
  ocean: '#0c1422',
  land: '#31445e',
  graticule: '#ffffff',
  coastline: '#e4eeff',
  halo: '#4a7fc9',
  background: '#0a0e14',
  stars: '#5a6a82',
};

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
const DAMPING_AT_REFERENCE = 0.035; // 指を離したあと約 0.25 秒の時定数で止まる

const MIN_DIST = 1.2;
const MAX_DIST = 8;
const FOCUS_DIST = 2.15; // 風速モードで地点に寄ったときのカメラ距離
const EARTH_VIEW_DIST = 3.3; // 通常・天気モードは地球全体が見える距離にする
const OVERVIEW_DIST = 4.6;
const FLY_SECONDS = 2.8;
const CLOUD_LOD_PIXELS = 150; // 太陽系へ引いていくとき、地球がこれより小さく写ると雲を描かない
const PANEL_OVERLAP_WIDTH = 900; // これより狭い画面ではパネルを下に置く (style.css と合わせる)

const EARTH_SURFACE_RADIUS = GLOBE_RADIUS * 1.0005;
const COASTLINE_RADIUS = GLOBE_RADIUS * 1.0015;
const BORDER_RADIUS = GLOBE_RADIUS * 1.0014;
const REGION_LINE_RADIUS = GLOBE_RADIUS * 1.0007; // 斜めに見ると線が地表からずれるので、地域ビューでは地表へ寄せる
const CAMERA_NEAR_MAX = 0.1;
const CAMERA_FAR = 100;
const CAMERA_NEAR_MIN = 0.005;
const REGION_BLEND_SECONDS = 0.5;
const DEMO_FLY_SECONDS = 6;
// マーカーの地名が占める範囲 (style.css の .marker-label と合わせる)
const MARKER_BOX_LEFT = 8;
const MARKER_BOX_HEIGHT = 24;
const MARKER_LABEL_OFFSET = 13;
const DEMO_ROTATE_SPEED = 0.42; // OrbitControls の単位。毎秒約 2.5 度で、地表は実際の自転と同じ東向きに動く
const DEMO_TURN_DEGREES_PER_SECOND = 1.2; // 地域ビューで中心のまわりを回る速さ
// 地域ビューの巡航。操作は設定で選ぶ。アナログ式は W を押している間は速くなり、S を押している間は遅くなって 0 で止まる。
// 段階式は W/S を 1 回押すごとに 1 段変える。どちらも手を離すとその速さで飛び続ける。A/D を押している間は旋回する
const CRUISE_LEVELS = 5; // 速さの上限 (段)
// 1 段目の速さ。高さ (距離) 1 あたり、1 秒に進む角度 (地球の中心から見た弧度)。
// 1 段ごとに 2 倍にし、遅い段で景色を眺められ、速い段で遠くへ移れるようにする
const CRUISE_RATE = 0.02;
const CRUISE_STEP_RATIO = 2;
// アナログ式で、押している間に段の値が変わる速さ (段/秒)。止めたいときにすぐ止まれるよう、減速を速くする
const CRUISE_ACCELERATION = 1;
const CRUISE_DECELERATION = 2;
const CRUISE_SECONDS = 0.8; // 段階式で、選んだ段の速さへ近づくときの時定数
const TURN_DEGREES_PER_SECOND = 20;
// 地球ビューの回転と移動。A/D は 1 回押すごとに 1 段 (地域ビューの Q/E と同じ段と速さ)、手を離しても回り続ける。
// W/S は押している間だけ南北へ動く。速さはどちらも、寄るほど地表が速く流れるので、ドラッグと同じくカメラの高さに比例させる
const GLOBE_SPIN_REFERENCE_ALTITUDE = 2.3; // 既定の地球ビューの高さ。この高さで段どおりの速さ
const GLOBE_SPIN_MIN_SCALE = 0.1;
const GLOBE_SLIDE_DEGREES_PER_SECOND = 6; // W/S の速さ (既定の高さ)
const GLOBE_MAX_LATITUDE = 85; // W/S で極に近づきすぎると、北が上の画面が不安定になる
const GLOBE_HINT = '左ドラッグで回転、ホイールで拡大縮小、A/D で回転、W/S で南北、矢印キーで次の都市へ';
const TURN_SECONDS = 0.35; // 旋回を始めるときと止めるときの時定数
const BANK_DEGREES = 6; // 旋回中に画面を傾ける角度
// 中心の地点のまわりを回る旋回。Q と E で速さの段を変え、手を離しても回り続ける。巡航とは同時にしない
const ORBIT_LEVELS = 5;
const ORBIT_DEGREES_PER_SECOND = 1.2; // 1 段目の速さ (デモと同じ。1 周約 5 分)。1 段ごとに 2 倍にする
const ORBIT_STEP_RATIO = 2;
const ORBIT_SECONDS = 0.8; // 速さを変えるときの時定数
const ORBIT_KEYS: Record<string, 1 | -1> = { KeyE: 1, KeyQ: -1 }; // 1 は右回り (カメラが右へ回り込む)
const CRUISE_KEYS: Record<string, 'faster' | 'slower' | 'left' | 'right'> = {
  KeyW: 'faster',
  KeyS: 'slower',
  KeyA: 'left',
  KeyD: 'right',
};
// 矢印キーは、その向きにある次の都市へ移る。ラベルの出ていない都市は、カメラの距離のこの倍 (弧度) まで
const CITY_HOP_REACH = 2;
const CITY_HOP_KEYS: Record<string, HopDirection> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};
const DEMO_TILT = 62;
const DEMO_DISTANCE = 0.22;
const DEMO_DAYSIDE_OFFSET = 30; // 太陽の真下より東から始め、回転で真下を通る
const REGION_RELEASE_BLEND = 0.01; // 地球ビューへ戻って、高解像度の画像が見えなくなったら解放する
const WHEEL_ZOOM_RATE = 0.0012;
const ROTATE_DEGREES_PER_HEIGHT = 180; // 右ドラッグで画面の高さぶん動かしたときの回転
const TILT_DEGREES_PER_HEIGHT = 90;
const VELOCITY_SMOOTHING = 0.5;
const VELOCITY_MIN_INTERVAL_MS = 16; // 間隔の詰まったイベントで速さを過大に見積もらない
const FLING_MAX_IDLE_MS = 80; // 止まってから指を離したら慣性を付けない

export type GlobeController = ReturnType<typeof initGlobe>;

export function initGlobe(onSelectCity: (place: DemoPlace) => void) {
  const container = el('app');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  const cameraAspect = window.innerWidth / window.innerHeight;
  const camera = new THREE.PerspectiveCamera(verticalFov(BASE_FOCAL_LENGTH, cameraAspect), cameraAspect, 0.1, CAMERA_FAR);
  camera.position.set(0, 1, 3.6);
  let focalLength = BASE_FOCAL_LENGTH;
  let lensScale = apparentScale(camera.fov);

  function applyLens(): void {
    camera.fov = verticalFov(focalLength, camera.aspect);
    lensScale = apparentScale(camera.fov);
    camera.updateProjectionMatrix();
  }

  // 広い画面では地球儀を中央に置く。狭い画面ではパネルが下に並ぶので、残りの領域の中央に寄せる
  function applyViewOffset(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w > PANEL_OVERLAP_WIDTH) camera.clearViewOffset();
    else camera.setViewOffset(w, h, 0, el('panels').offsetHeight / 2, w, h);
  }
  applyViewOffset();
  new ResizeObserver(applyViewOffset).observe(el('panels'));

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
  let baseTextures: BaseTextures | null = null; // 地域ビューの高解像度の画像が届くまで代わりに写す

  const hdr = new HdrPipeline(renderer, scene, camera, EARTH_SURFACE_RADIUS);
  const flatBackground = new THREE.Color(COLORS.background);
  const spaceCanvas = document.createElement('canvas');
  const spaceBackground = createSpaceBackground(spaceCanvas);

  // ベクター海岸線・国境線 (LOD 付き)。地表より少し浮かせて Z ファイティングを避ける
  const coastlines = createCoastlines(COASTLINE_RADIUS);
  coastlines.setColor(COLORS.coastline);
  coastlines.setOpacity(COASTLINE_OPACITY);
  const borders = createBorders(BORDER_RADIUS);
  scene.add(coastlines.group, borders.group);

  const windUniforms = createWindUniforms();
  const overlay = new SpeedOverlay(GLOBE_RADIUS * 1.0008, windUniforms);
  overlay.setOpacity(OVERLAY_OPACITY);
  scene.add(overlay.mesh);

  // 実際の星、太陽、月 (通常・天気モード)
  const sky = new Sky(renderer.getPixelRatio());
  scene.add(sky.group);

  // 太陽系。地球の場面とは別に描き、引いている間と見ている間は地球の場面をその上に重ねる
  const solar = new SolarSystem(sky, spaceBackground, renderer.domElement, el('solar-labels'), renderer.getPixelRatio());

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

  // 風速モードは線がないと風の場所が分からないので、設定にかかわらず描く。太陽系では描かない
  function syncMapLines(): void {
    const visible = (mode === 'wind' || showMapLines) && !solar.active;
    coastlines.group.visible = visible;
    borders.group.visible = visible;
  }

  let viewTime: Date | null = null; // 過去の時刻を見ている間は、その時刻の太陽と星にする

  function updateSky(): void {
    const date = viewTime ?? new Date();
    sky.setTime(date);
    solar.setTime(date);
    earth.setSunDirection(sky.sunDir);
    earth.setMoonDirection(sky.moonDir);
  }

  function sunLonLat(): LonLat {
    return lonLatOf(sky.sunDir.toArray());
  }

  function cameraAltitude(): number {
    return camera.position.length() - GLOBE_RADIUS;
  }

  // 写り方で決めるものに使う高さ。望遠では、同じ高さでも地表が大きく写るので低いものとして扱う
  function apparentAltitude(): number {
    return cameraAltitude() * lensScale;
  }

  // 風速モードは粒子が見やすい距離、他のモードは地球全体が見える距離
  function viewDistance(target: MapMode): number {
    return target === 'wind' ? FOCUS_DIST : EARTH_VIEW_DIST;
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
    scene.background = solar.active ? null : wind ? flatBackground : spaceBackground;
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
      earth.setTextures(day, night, water, renderer);
      baseTextures = { day, night, water };
      regionDetail?.setBase(baseTextures);
      earthReady = true;
      setMode(mode);
    })
    .catch((err) => console.error('earth texture load failed', err));

  function setWind(field: WindField): void {
    updateWindUniforms(windUniforms, field);
    overlay.setEnabled(mode === 'wind');
    if (gpuParticles) return; // 粒子は共有の uniform から新しい風を読む
    if (cpuParticles) {
      cpuParticles.setWind(field);
    } else if (GpuParticleSystem.isSupported(renderer)) {
      gpuParticles = new GpuParticleSystem(
        renderer,
        windUniforms,
        PARTICLE_TEX_SIZE,
        PARTICLE_RADIUS,
        GLOBE_RADIUS,
      );
      gpuParticles.speedFactor = PARTICLE_SPEED;
      gpuParticles.trailFade = TRAIL_FADE;
      gpuParticles.brightness = PARTICLE_BRIGHTNESS;
    } else {
      // GPU 非対応環境では CPU 移流にフォールバック
      cpuParticles = new ParticleSystem(6000, PARTICLE_RADIUS, field, 32);
      cpuParticles.speedFactor = PARTICLE_SPEED;
      cpuParticles.brightness = PARTICLE_BRIGHTNESS;
      cpuParticles.object3d.visible = mode === 'wind';
      scene.add(cpuParticles.object3d);
    }
  }

  updateSky();
  window.setInterval(updateSky, SKY_UPDATE_MS);

  // 地点へのカメラ移動。移動中は OrbitControls を止め、操作されたら打ち切る
  let flight: { from: THREE.Vector3; to: THREE.Vector3; elapsed: number } | null = null;

  function flyTo(to: THREE.Vector3): void {
    flight = { from: camera.position.clone(), to, elapsed: 0 };
    // 回り続けていると、着いた場所からすぐ離れてしまう。着いてから減速が始まると少しずれるので、すぐ止める
    globeSpinLevel = 0;
    globeSpinThrottle = 0;
    controls.autoRotate = false;
  }

  const marker = el('marker');
  const markerPos = new THREE.Vector3();
  const projected = new THREE.Vector3();
  let markerShown = false;
  let markerLabelWidth = 0;
  let focused: WeatherLocation | null = null;
  let selectedCity: DemoPlace | null = null; // ラベルで選んだ都市。地域ビューの行き先になる
  const cityLabels = new CityLabels(el('city-labels'), MAP_CITIES, EARTH_SURFACE_RADIUS, onSelectCity);
  let cityLabelsEnabled = false;
  const cameraPanel = new CameraPanel(camera, GLOBE_RADIUS);
  const planetLabels = new PlanetLabels(el('planet-labels'), sky.planets.map((planet) => planet.name), GLOBE_RADIUS);
  let planetLabelsEnabled = false;

  // 地域ビュー。null の間は地球ビューで、OrbitControls がカメラを動かす
  let regionView: RegionView | null = null;
  let regionFlight: { from: RegionView; to: RegionView; elapsed: number; seconds: number; leaving: boolean } | null = null;
  let demoMotion = false;
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
    return hit ? lonLatOf(hit.toArray()) : null;
  }

  // 地域ビューの中で別の場所へ移るときは、中心のまわりの旋回を続ける (飛んでいる間は回さず、着いたら同じ速さで回る)
  function flyRegion(to: RegionView, leaving: boolean, seconds = FLY_SECONDS): void {
    if (!regionView) return;
    if (leaving) stopCruise();
    else stopForwardCruise();
    regionFlight = { from: regionView, to, elapsed: 0, seconds, leaving };
    regionVelocity = REGION_STILL;
    regionDrag = null;
  }

  function homeLonLat(fallback: LonLat): LonLat {
    return focused ? { lat: focused.latitude, lon: focused.longitude } : fallback;
  }

  // 真上から見た地球ビューの姿勢から続けて、傾きながら地点へ寄る
  function regionHomeOf(from: LonLat): RegionView {
    const { lat, lon } = selectedCity ?? homeLonLat(from);
    return {
      lat,
      lon,
      heading: 0,
      tilt: REGION_TILT,
      distance: REGION_DISTANCE,
    };
  }

  // 高解像度の画像は VRAM を多く使うので、地域ビューの間だけ持つ
  let regionDetail: RegionDetail | null = null;
  let regionDetailEnabled = true;
  let regionBloom = 1;
  const viewStatus = el('view-status');

  function startRegionDetail(): void {
    if (!regionDetailEnabled) return;
    if (!regionDetail && RegionDetail.isSupported(renderer)) {
      regionDetail = new RegionDetail(renderer, (layer, col, row) => window.weatherApi.getEarthTile(layer, col, row));
      if (baseTextures) regionDetail.setBase(baseTextures);
      earth.setRegionDetail(regionDetail);
    }
  }

  function stopRegionDetail(): void {
    earth.setRegionDetail(null);
    regionDetail?.dispose();
    regionDetail = null;
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

  function beginRegion(): RegionView {
    flight = null;
    controls.enabled = false;
    startRegionDetail();
    regionView ??= {
      ...lonLatOf(camera.position.toArray()),
      heading: 0,
      tilt: 0,
      distance: cameraAltitude(),
    };
    return regionView;
  }

  function enterRegion(): void {
    if (mode === 'wind' || (regionView && !regionFlight?.leaving)) return;
    flyRegion(regionHomeOf(beginRegion()), false);
  }

  // 真上から見た姿勢まで戻してから、地球ビューの操作へ引き渡す
  function leaveRegion(distance: number, seconds = FLY_SECONDS): void {
    if (!regionView) return;
    flyRegion({ ...regionView, heading: 0, tilt: 0, distance: distance - GLOBE_RADIUS }, true, seconds);
  }

  // 巡航の速さの段 (0〜CRUISE_LEVELS。小数になる)。旋回は度/秒。
  // cruiseLevel は段階式で選んでいる段。アナログ式から切り替えた直後は、その速さを保つため小数のこともある。
  // cruiseBraking は、中心のまわりの旋回を始めたときに巡航をなめらかに止める間 true
  let cruiseMode: CruiseMode = 'analog';
  let cruiseBank = true; // 旋回中に画面を傾ける
  let cruiseLevel = 0;
  let cruiseThrottle = 0;
  let cruiseBraking = false;
  let turnRate = 0;
  const throttleKeys = new Set<'faster' | 'slower'>();
  const turnKeys = new Set<'left' | 'right'>();
  // 旋回の段 (-ORBIT_LEVELS〜ORBIT_LEVELS。正が右回り) と、なめらかにしたあとの値
  let orbitLevel = 0;
  let orbitThrottle = 0;
  const viewHint = el('view-hint');
  const viewHintText = viewHint.textContent ?? '';
  // 地球ビューの回転の段 (-ORBIT_LEVELS〜ORBIT_LEVELS。正が東向き) と、なめらかにしたあとの値
  let globeSpinLevel = 0;
  let globeSpinThrottle = 0;
  let globeSlide = 0; // W/S の南北の動き。-1〜1 で、押している間に向きの値へなめらかに近づける
  const slideKeys = new Set<'faster' | 'slower'>(); // W が faster (北へ)、S が slower (南へ)

  // 巡航と、中心のまわりの旋回、地球ビューの回転をすべて止める
  function stopCruise(): void {
    orbitLevel = 0;
    orbitThrottle = 0;
    globeSpinLevel = 0;
    slideKeys.clear();
    stopForwardCruise();
  }

  // 巡航だけを止める
  function stopForwardCruise(): void {
    cruiseLevel = 0;
    cruiseThrottle = 0;
    cruiseBraking = false;
    turnRate = 0;
    throttleKeys.clear();
    turnKeys.clear();
    showCruise();
  }

  // 巡航の速さは押している間に変わり続けるので、毎フレーム呼ぶ。文が変わったときだけ書き換える
  function showCruise(): void {
    let text = regionView ? viewHintText : GLOBE_HINT;
    const cruising = cruiseMode === 'stepped' ? cruiseLevel > 0 : cruiseThrottle > 0;
    if (cruising && orbitLevel === 0 && regionView) {
      const speed = cruiseRate(cruiseThrottle) * regionView.distance * EARTH_RADIUS_KM;
      const shownSpeed = `${speed.toFixed(speed < 10 ? 1 : 0)} km/秒`;
      if (cruiseMode === 'stepped') {
        const level = Number.isInteger(cruiseLevel) ? String(cruiseLevel) : cruiseLevel.toFixed(1);
        text = `巡航中 速さ ${level} / ${CRUISE_LEVELS}、${shownSpeed}(W/S で速さ、A/D で向き、Q/E で旋回)`;
      } else {
        text = `巡航中 ${shownSpeed}(W で加速、S で減速、A/D で向き、Q/E で旋回)`;
      }
    } else if (orbitLevel !== 0) {
      const direction = orbitLevel > 0 ? '右回り' : '左回り';
      text = `旋回中 ${direction} 速さ ${Math.abs(orbitLevel)} / ${ORBIT_LEVELS}(Q/E で速さと向き、W で巡航)`;
    } else if (!regionView && globeSpinLevel !== 0) {
      const direction = globeSpinLevel > 0 ? '東へ' : '西へ';
      text = `回転中 ${direction} 速さ ${Math.abs(globeSpinLevel)} / ${ORBIT_LEVELS}(A/D で速さと向き、W/S で南北)`;
    }
    if (viewHint.textContent !== text) viewHint.textContent = text;
  }

  // 入力欄や設定画面を操作していないときだけ受け付ける
  function acceptsKey(event: KeyboardEvent): boolean {
    if (demoMotion || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (document.querySelector('dialog[open]')) return false;
    const target = event.target instanceof Element ? event.target : null;
    return !target?.closest('input, select, textarea, [contenteditable="true"]');
  }

  // 地域ビューにいて、飛んでいる途中でないときだけ受け付ける
  function acceptsCruiseKey(event: KeyboardEvent): boolean {
    return !!regionView && !regionFlight && acceptsKey(event);
  }

  // 地球ビュー (太陽系の場面でなく、地点へ飛んでいる途中でもない) で受け付ける
  function acceptsGlobeKey(event: KeyboardEvent): boolean {
    return !regionView && !solar.active && !flight && acceptsKey(event);
  }

  // クリックしたボタンにフォーカスが残っていると、キーを押したときにフォーカスの枠が出る。
  // 巡航のキーはボタンには働かないので、フォーカスを外す (設定画面の中は除く)
  function releaseButtonFocus(event: KeyboardEvent): void {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('button, summary') && !target.closest('dialog')) target.blur();
  }

  window.addEventListener('keydown', (event) => {
    const action = CRUISE_KEYS[event.code];
    const orbitStep = ORBIT_KEYS[event.code];
    if (!action && !orbitStep) return;
    releaseButtonFocus(event);
    // 地球ビューでは A/D で地球を回し (D で東、地表は左へ流れる。1 回押すごとに 1 段)、W/S で押している間だけ南北へ動く
    if (action && acceptsGlobeKey(event)) {
      event.preventDefault();
      if (action === 'faster' || action === 'slower') {
        slideKeys.add(action);
        return;
      }
      if (event.repeat) return; // 押し続けても 1 段ずつ変える
      globeSpinLevel = THREE.MathUtils.clamp(globeSpinLevel + (action === 'right' ? 1 : -1), -ORBIT_LEVELS, ORBIT_LEVELS);
      showCruise();
      return;
    }
    if (!acceptsCruiseKey(event)) return;
    event.preventDefault();
    if (action === 'left' || action === 'right') {
      turnKeys.add(action);
      return;
    }
    // 巡航は中心を動かし、旋回は中心を固定するので、片方を始めたらもう片方は止める (速さはなめらかに落ちる)
    if (action) {
      if (action === 'faster') {
        orbitLevel = 0;
        cruiseBraking = false;
      }
      if (cruiseMode === 'analog') {
        throttleKeys.add(action);
        return;
      }
      if (event.repeat) return; // 段階式は押し続けても 1 段ずつ変える
      // 小数の段からは、押した向きの次の整数の段へ移る
      cruiseLevel =
        action === 'faster'
          ? Math.min(CRUISE_LEVELS, Math.floor(cruiseLevel) + 1)
          : Math.max(0, Math.ceil(cruiseLevel) - 1);
      return;
    }
    if (event.repeat) return; // 旋回は押し続けても 1 段ずつ変える
    orbitLevel = THREE.MathUtils.clamp(orbitLevel + orbitStep, -ORBIT_LEVELS, ORBIT_LEVELS);
    cruiseLevel = 0;
    if (cruiseThrottle > 0) cruiseBraking = true;
    throttleKeys.clear();
    showCruise();
  });
  // 矢印キーで次の都市へ。都市へ向かっている途中なら、行き先から次を選ぶ。
  // 画面に出ているラベルの都市から選び、その向きになければ今の段の都市、すべての都市の順に広げる。
  // ラベルの出ていない都市は、海を越えて遠くへ飛ばないよう、画面に見える程度の範囲に限る
  window.addEventListener('keydown', (event) => {
    const direction = CITY_HOP_KEYS[event.code];
    if (!direction) return;
    releaseButtonFocus(event);
    if (regionFlight?.leaving || solar.active || !acceptsKey(event)) return;
    event.preventDefault();
    if (event.repeat) return; // 押し続けても 1 都市ずつ移る
    // 地球ビューでは、カメラの真下 (飛んでいる途中なら行き先) を出発点にし、北が上なので方角は 0
    const from: LonLat & { heading: number; distance: number } = regionView
      ? (regionFlight?.to ?? regionView)
      : { ...lonLatOf((flight?.to ?? camera.position).toArray()), heading: 0, distance: cameraAltitude() };
    const tier = tierAtAltitude(apparentAltitude());
    const reach = from.distance * CITY_HOP_REACH * THREE.MathUtils.RAD2DEG;
    const groups: Array<[MapCity[], number]> = [
      [cityLabels.shownPlaces(), 180],
      [MAP_CITIES.filter((city) => city.tier <= tier), reach],
      [MAP_CITIES, reach],
    ];
    for (const [group, maxDistance] of groups) {
      const city = pickCityInDirection(from, from.heading, direction, group, maxDistance);
      if (city) {
        onSelectCity(city);
        return;
      }
    }
  });

  window.addEventListener('keyup', (event) => {
    const action = CRUISE_KEYS[event.code];
    if (action === 'left' || action === 'right') turnKeys.delete(action);
    else if (action) {
      throttleKeys.delete(action);
      slideKeys.delete(action);
    }
  });
  // 窓を離れたら、押していたキーは離したことにする。巡航と地球の回転はその速さで続ける
  window.addEventListener('blur', () => {
    turnKeys.clear();
    throttleKeys.clear();
    slideKeys.clear();
  });

  // 巡航で進め、旋回の分だけ画面を傾ける。ドラッグしている間は進めない
  // 段の値から速さを求める。0〜1 段の間は 1 段目の速さへ比例させ、止まるところでも途切れないようにする
  function cruiseRate(throttle: number): number {
    if (throttle < 1) return CRUISE_RATE * throttle;
    return CRUISE_RATE * CRUISE_STEP_RATIO ** (throttle - 1);
  }

  // 旋回の段の値 (符号つき) から、方角の変わる速さ (度/秒) を求める。巡航と同じく 0〜1 段の間は比例させる。
  // 右回りでカメラが右へ回り込むと、カメラの向く方角は左へ回る
  function orbitDegreesPerSecond(throttle: number): number {
    const size = Math.abs(throttle);
    const rate = size < 1 ? ORBIT_DEGREES_PER_SECOND * size : ORBIT_DEGREES_PER_SECOND * ORBIT_STEP_RATIO ** (size - 1);
    return -Math.sign(throttle) * rate;
  }

  function updateCruise(dt: number): void {
    if (!regionView) return;
    orbitThrottle += (orbitLevel - orbitThrottle) * (1 - Math.exp(-dt / ORBIT_SECONDS));
    if (!regionDrag && Math.abs(orbitThrottle) > 1e-4) {
      regionView = { ...regionView, heading: wrapDegrees(regionView.heading + orbitDegreesPerSecond(orbitThrottle) * dt) };
    }
    // 両方を押しているときは減速を優先する
    if (throttleKeys.has('slower') || cruiseBraking) {
      cruiseThrottle = Math.max(0, cruiseThrottle - CRUISE_DECELERATION * dt);
      if (cruiseThrottle === 0) cruiseBraking = false;
    } else if (cruiseMode === 'stepped') {
      cruiseThrottle += (cruiseLevel - cruiseThrottle) * (1 - Math.exp(-dt / CRUISE_SECONDS));
    } else if (throttleKeys.has('faster')) {
      cruiseThrottle = Math.min(CRUISE_LEVELS, cruiseThrottle + CRUISE_ACCELERATION * dt);
    }
    showCruise();
    const turnGoal = ((turnKeys.has('right') ? 1 : 0) - (turnKeys.has('left') ? 1 : 0)) * TURN_DEGREES_PER_SECOND;
    turnRate += (turnGoal - turnRate) * (1 - Math.exp(-dt / TURN_SECONDS));
    if (regionDrag || (cruiseThrottle < 1e-4 && Math.abs(turnRate) < 1e-3)) return;
    regionView = cruiseRegionView(regionView, cruiseRate(cruiseThrottle) * regionView.distance * dt, turnRate * dt);
  }

  function updateRegion(dt: number): void {
    if (!regionView) return;
    if (regionFlight) {
      regionFlight.elapsed = Math.min(regionFlight.seconds, regionFlight.elapsed + dt);
      const t = regionFlight.elapsed / regionFlight.seconds;
      regionView = interpolateRegionView(regionFlight.from, regionFlight.to, easeInOut(t));
      regionDistanceGoal = clampRegionDistance(regionView.distance);
      if (regionFlight.elapsed >= regionFlight.seconds) {
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
        heading: regionView.heading + (demoMotion ? DEMO_TURN_DEGREES_PER_SECOND * dt : 0),
        distance: approachDistance(regionView.distance, regionDistanceGoal, dt),
      });
      updateCruise(dt);
    }
    applyRegionPose(regionView);
    // 旋回する向きへ傾ける (右へ曲がるときは右の翼を下げる)
    if (cruiseBank && turnRate !== 0) camera.rotateZ((-turnRate / TURN_DEGREES_PER_SECOND) * BANK_DEGREES * THREE.MathUtils.DEG2RAD);
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
    regionVelocity = {
      lat: carried(regionVelocity.lat, after.lat - before.lat),
      lon: carried(regionVelocity.lon, wrapDegrees(after.lon - before.lon)),
      heading: carried(regionVelocity.heading, wrapDegrees(after.heading - before.heading)),
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

  // 地表へ近づいても欠けないよう、カメラの手前の描画範囲は高度に合わせる。
  // 太陽系へ引いている間は、遠くの地球と月まで描けるよう奥の範囲も広げる
  function updateNearPlane(): void {
    let near = THREE.MathUtils.clamp((cameraAltitude() - CLOUD_ALTITUDE) * 0.5, CAMERA_NEAR_MIN, CAMERA_NEAR_MAX);
    let far = CAMERA_FAR;
    if (solar.active) {
      near = Math.max(near, camera.position.length() * 0.02);
      far = Math.max(CAMERA_FAR, camera.position.length() + CAMERA_FAR);
    }
    if (near === camera.near && far === camera.far) return;
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }

  const shadowFocus = new THREE.Vector3();
  function updateRegionBlend(dt: number): void {
    const goal = regionView && !regionFlight?.leaving ? 1 : 0;
    regionBlend += (goal - regionBlend) * (1 - Math.exp(-dt / REGION_BLEND_SECONDS));
    earth.setRegionBlend(regionBlend, apparentAltitude());
    if (regionView) {
      lonLatToVector3(regionView.lon, regionView.lat, EARTH_SURFACE_RADIUS, shadowFocus);
      earth.setVolumeShadowFocus(shadowFocus, regionView.distance * lensScale);
    } else {
      shadowFocus.copy(camera.position).setLength(EARTH_SURFACE_RADIUS);
      earth.setVolumeShadowFocus(shadowFocus, apparentAltitude());
    }
    // 風速モードでは粒子の面より上に線を置く必要があるので、元の高さのまま
    const lineRadius = (radius: number): number =>
      THREE.MathUtils.lerp(radius, mode === 'wind' ? radius : REGION_LINE_RADIUS, regionBlend) / radius;
    coastlines.group.scale.setScalar(lineRadius(COASTLINE_RADIUS));
    borders.group.scale.setScalar(lineRadius(BORDER_RADIUS));
  }

  function placeMarker(name: string, lat: number, lon: number): void {
    const label = el('marker-label');
    label.textContent = name;
    lonLatToVector3(lon, lat, EARTH_SURFACE_RADIUS, markerPos);
    marker.hidden = false;
    markerShown = true;
    markerLabelWidth = label.offsetWidth;
    cityLabels.setExcluded(name);
  }

  function hideMarker(): void {
    marker.hidden = true;
    markerShown = false;
    cityLabels.setExcluded(null);
  }

  // 地球の裏側やカメラの後ろにあるときは null を返す
  function toScreen(world: THREE.Vector3): { x: number; y: number } | null {
    const distance = camera.position.length();
    const facing = world.dot(camera.position) / (world.length() * distance);
    projected.copy(world).project(camera);
    // 斜めの視点では、地平線より手前でもカメラの後ろにあることがある (このとき z は 1 を超える)
    if (facing <= GLOBE_RADIUS / distance || projected.z >= 1) return null;
    return { x: ((projected.x + 1) / 2) * window.innerWidth, y: ((1 - projected.y) / 2) * window.innerHeight };
  }

  // デモの間は出さない。デモは行き先の都市だけをマーカーで見せる
  function syncCityLabels(): void {
    cityLabels.setVisible(cityLabelsEnabled && !demoMotion && !solar.active);
  }

  function focusLocation(location: WeatherLocation): void {
    focused = location;
    selectedCity = null;
    placeMarker(location.name, location.latitude, location.longitude);
    if (solar.active) {
      exitSolar(); // 太陽系からは、新しい地点の上へ戻る
      return;
    }
    if (regionView) {
      if (!regionFlight?.leaving) flyRegion(regionHomeOf(regionView), false);
      return;
    }
    flyTo(markerPos.clone().normalize().multiplyScalar(viewDistance(mode)));
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
    else if (solar.active) exitSolar();
  }

  // 太陽系へ引く。地域ビューからも、その姿勢のまま引き始める
  function enterSolar(): void {
    if (mode === 'wind' || solar.entered) return;
    stopCruise();
    flight = null;
    regionView = null;
    regionFlight = null;
    regionDrag = null;
    regionVelocity = REGION_STILL;
    controls.enabled = false;
    controls.autoRotate = false;
    solar.enter(camera, sky.siderealRotation);
    syncSolarScene();
  }

  // 地点の上 (地点がなければ今の向き) の地球ビューへ戻る。done は戻り終えたときに呼ぶ
  function exitSolar(done?: () => void): void {
    if (!solar.active) {
      done?.();
      return;
    }
    const home = markerShown ? markerPos.clone().normalize() : camera.position.clone().normalize();
    solar.leave(home, viewDistance(mode), sky.siderealRotation, () => {
      // 戻り終えた姿勢は地球の中心を向いているので、そのまま地球ビューの操作へ引き渡す
      camera.up.set(0, 1, 0);
      controls.target.set(0, 0, 0);
      controls.enabled = true;
      controls.autoRotate = demoMotion;
      controls.update();
      syncSolarScene();
      done?.();
    });
  }

  // 太陽系の場面を使う間は、星と太陽はそちらで描き、地球の場面は地球と月だけを重ねる
  function syncSolarScene(): void {
    sky.setBackdropVisible(!solar.active);
    setMode(mode);
    syncCityLabels();
    hdr.setBackdrop(solar.active ? solar.scene : null, solar.active ? solar.camera : null);
  }

  // 風速モードと他のモードでは見やすい距離が違うので、向きは保ったまま距離だけ変える
  function changeMode(next: MapMode): void {
    const crossesWind = (mode === 'wind') !== (next === 'wind');
    setMode(next);
    if (!crossesWind) return;
    if (regionView) {
      leaveRegion(viewDistance(next)); // 風速モードに地域ビューはない
      return;
    }
    flyTo(camera.position.clone().setLength(viewDistance(next)));
  }

  // A/D の段に合わせて地球を回し、W/S を押している間は南北へ動かす。デモの自動回転とは同時にしない。
  // 回転は OrbitControls の自動回転を借りる (ドラッグしている間は回らない)。
  // 東向きは地表が左へ流れる向きで、自動回転の正の向き (地表が東へ動く) とは逆
  function updateGlobeMotion(dt: number): void {
    globeSpinThrottle += (globeSpinLevel - globeSpinThrottle) * (1 - Math.exp(-dt / ORBIT_SECONDS));
    if (Math.abs(globeSpinThrottle) < 1e-3) globeSpinThrottle = 0;
    const slideGoal = (slideKeys.has('faster') ? 1 : 0) - (slideKeys.has('slower') ? 1 : 0);
    globeSlide += (slideGoal - globeSlide) * (1 - Math.exp(-dt / TURN_SECONDS));
    if (Math.abs(globeSlide) < 1e-3) globeSlide = 0;
    if (demoMotion) return;
    const scale = Math.max(GLOBE_SPIN_MIN_SCALE, apparentAltitude() / GLOBE_SPIN_REFERENCE_ALTITUDE);
    // 度/秒を OrbitControls の単位 (2 で 30 秒に 1 周) にする
    const degreesPerSecond = -orbitDegreesPerSecond(globeSpinThrottle) * scale;
    controls.autoRotate = globeSpinThrottle !== 0;
    controls.autoRotateSpeed = -degreesPerSecond / 6;
    if (globeSlide !== 0) {
      const { lat, lon } = lonLatOf(camera.position.toArray());
      const next = THREE.MathUtils.clamp(
        lat + globeSlide * GLOBE_SLIDE_DEGREES_PER_SECOND * scale * dt,
        -GLOBE_MAX_LATITUDE,
        GLOBE_MAX_LATITUDE,
      );
      lonLatToVector3(lon, next, camera.position.length(), camera.position);
    }
  }

  function updateFlight(dt: number): void {
    showCruise();
    if (!flight) {
      updateGlobeMotion(dt);
      // 寄るほどゆっくり回し、触ったときに地表が指に付いてくる感覚に近づける
      controls.rotateSpeed = THREE.MathUtils.clamp(apparentAltitude() * 0.32, 0.05, 0.6);
      // 慣性はフレームごとに減衰するので、FPS によらず同じ時間で止まるように換算する
      controls.dampingFactor = 1 - Math.pow(1 - DAMPING_AT_REFERENCE, dt * REFERENCE_HZ);
      controls.update(dt); // 自動回転の速さを FPS によらず同じにする
      return;
    }
    flight.elapsed = Math.min(FLY_SECONDS, flight.elapsed + dt);
    const eased = easeInOut(flight.elapsed / FLY_SECONDS);
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
    const point = markerShown && !solar.active ? toScreen(markerPos) : null;
    if (markerShown) {
      marker.style.visibility = point ? 'visible' : 'hidden';
      if (point) marker.style.transform = `translate(${point.x}px, ${point.y}px)`;
    }
    // 都市のラベルをマーカーの地名に重ねない
    const markerBox = point
      ? [{ x: point.x - MARKER_BOX_LEFT, y: point.y - MARKER_BOX_HEIGHT / 2, width: MARKER_BOX_LEFT + MARKER_LABEL_OFFSET + markerLabelWidth, height: MARKER_BOX_HEIGHT }]
      : [];
    cityLabels.update(toScreen, markerBox, apparentAltitude());
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    applyViewOffset();
    applyLens();
    renderer.setSize(window.innerWidth, window.innerHeight);
    hdr.setSize(window.innerWidth, window.innerHeight);
    gpuParticles?.resize();
  });

  // 太陽の見え方から露出を決める。風速モードでは使わない
  let exposure = 1;
  let autoExposure = true;
  let exposureCompensation = 0; // EV。1 で明るさが 2 倍
  const toSun = new THREE.Vector3();
  const sunNdc = new THREE.Vector3();
  const cameraForward = new THREE.Vector3();
  let lensFlare = true;
  let depthOfField: { fNumber: number; globeSize: number } | null = null;
  const sunTint = new THREE.Vector3(1, 1, 1);
  const glareTint = new THREE.Vector3();
  function updateExposure(dt: number): void {
    toSun.copy(sky.sunPosition).sub(camera.position).normalize();
    let inFront: boolean;
    if (solar.active) {
      // 地球から離れると、太陽の向きは地球から見た向きと違うので、太陽系の場面で求める
      inFront = solar.projectSun(sunNdc);
    } else {
      inFront = toSun.dot(camera.getWorldDirection(cameraForward)) > 0;
      sunNdc.copy(sky.sunPosition).project(camera);
    }
    const visibility =
      screenPresence(sunNdc.x, sunNdc.y, inFront) *
      earthClearance(camera.position.toArray(), toSun.toArray(), GLOBE_RADIUS);
    const facing = camera.position.dot(sky.sunDir) / camera.position.length();
    exposure = adaptExposure(exposure, autoExposure ? targetExposure(facing, visibility) : 1, dt);
    hdr.setExposure(exposure * 2 ** exposureCompensation, autoExposure ? visibility : 0, THREE.MathUtils.lerp(1, regionBloom, regionBlend));
    // 地平線の近くの太陽は赤く、レンズの光の筋とかぶりもその色にする。
    // 縁から少しだけ顔を出した太陽でも十分にまぶしいので、見えている割合の平方根で強さを決める。
    // 画面全体のかぶりは日の出や日の入りの間だけ強くし、普段の太陽では弱くする
    const redden = horizonReddening(camera.position.toArray(), toSun.toArray(), GLOBE_RADIUS);
    sunTint.set(1, 1 - 0.4 * redden, 1 - 0.7 * redden);
    sky.setSunTint(sunTint);
    glareTint.set(1, 0.75, 0.5).multiply(sunTint);
    const glare = lensFlare && !solar.active ? Math.sqrt(visibility) : 0;
    hdr.setSunGlare((sunNdc.x + 1) / 2, (sunNdc.y + 1) / 2, glare, glareTint, 0.15 + 0.85 * redden);
  }

  let fpsLimit = 0;
  const fpsCounter = el('fps-counter');
  function applyGraphics(graphics: GraphicsSettings): void {
    fpsLimit = graphics.fps_limit;
    lensFlare = graphics.lens_flare;
    cruiseBank = graphics.cruise_bank;
    if (graphics.cruise_mode !== cruiseMode) {
      // 巡航中に切り替えても、今の速さのまま続ける。段階式では、次に W/S を押したときに整数の段へ移る
      cruiseMode = graphics.cruise_mode;
      cruiseLevel = cruiseMode === 'stepped' && !cruiseBraking ? cruiseThrottle : 0;
      throttleKeys.clear();
    }
    autoExposure = graphics.auto_exposure;
    exposureCompensation = graphics.exposure_compensation;
    focalLength = graphics.focal_length;
    applyLens();
    depthOfField = graphics.depth_of_field ? { fNumber: graphics.f_number, globeSize: graphics.globe_size } : null;
    hdr.setBloomEnabled(graphics.bloom);
    sky.setStarBrightness(graphics.star_brightness);
    sky.setConstellationsVisible(graphics.show_constellations, camera);
    sky.setTwinkle(graphics.star_twinkle);
    paintSpaceBackground(spaceCanvas, graphics.space_tint);
    spaceBackground.needsUpdate = true;
    earth.setCloudShadow(graphics.cloud_shadow);
    earth.setGlintStrength(graphics.glint_strength);
    earth.setCityGlow(graphics.city_glow);
    earth.setMoonlightEnabled(graphics.moonlight);
    earth.setVolumeCloudsEnabled(graphics.volume_clouds);
    earth.setVolumeCloudStyle({
      resolution: graphics.cloud_resolution / 100,
      edgeDetail: graphics.cloud_edge_detail,
      edgeSharpness: graphics.cloud_edge_sharpness,
      puffiness: graphics.cloud_puffiness,
      height: graphics.cloud_height,
    });
    regionBloom = graphics.region_bloom;
    regionDetailEnabled = graphics.region_detail;
    if (!regionDetailEnabled) stopRegionDetail();
    else if (regionView && !regionFlight?.leaving) startRegionDetail();
    showMapLines = graphics.show_map_lines;
    syncMapLines();
    cityLabelsEnabled = graphics.show_city_labels;
    planetLabelsEnabled = graphics.show_planet_labels;
    syncCityLabels();
    fpsCounter.hidden = !graphics.show_fps;
    const ratio = (Math.min(window.devicePixelRatio, 2) * graphics.render_scale) / 100;
    if (ratio !== renderer.getPixelRatio()) {
      renderer.setPixelRatio(ratio);
      hdr.setPixelRatio(ratio);
      sky.setPixelRatio(ratio);
      solar.setPixelRatio(ratio);
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
  let fpsWindowCpuMs = 0;
  let fpsWindowGpuMs = 0;
  let fpsWindowGpuFrames = 0;
  const gpuTimer = new GpuTimer(renderer.getContext() as WebGL2RenderingContext);
  renderer.setAnimationLoop((time: number) => {
    if (time < nextFrameTime - FRAME_TOLERANCE_MS) return;
    // 余りを持ち越し、リフレッシュレートが上限の整数倍でなくても平均を上限に合わせる
    const interval = fpsLimit > 0 ? 1000 / fpsLimit : 0;
    nextFrameTime = interval > 0 ? Math.max(nextFrameTime + interval, time + interval / 2) : 0;
    const dt = lastFrameTime === 0 ? 0.016 : Math.min(0.1, (time - lastFrameTime) / 1000);
    lastFrameTime = time;

    const frameStart = performance.now();
    renderedFrames++;
    fpsWindowFrames++;
    if (time - fpsWindowStart >= 1000) {
      fpsCounter.textContent = formatFrameStats(
        (fpsWindowFrames * 1000) / (time - fpsWindowStart),
        fpsWindowCpuMs / fpsWindowFrames,
        fpsWindowGpuFrames > 0 ? fpsWindowGpuMs / fpsWindowGpuFrames : null,
      );
      fpsWindowStart = time;
      fpsWindowFrames = 0;
      fpsWindowCpuMs = 0;
      fpsWindowGpuMs = 0;
      fpsWindowGpuFrames = 0;
    }
    // GPU のタイマーは表示しているときだけ使う
    const measureGpu = !fpsCounter.hidden;
    if (measureGpu) gpuTimer.begin();

    if (solar.active) {
      solar.update(dt, camera);
      solar.applyToEarth(camera, sky.siderealRotation);
      hdr.setBackdrop(solar.scene, solar.camera, solar.showsEarthScene);
    } else if (regionView) updateRegion(dt);
    else updateFlight(dt);
    updateNearPlane();
    sky.follow(camera.position);
    sky.advance(dt);
    // 太陽系へ引いて地球が小さく写るようになったら、雲は描かない
    earth.setCloudsEnabled(mode === 'weather' && (!solar.active || solar.earthPixels() >= CLOUD_LOD_PIXELS));
    updateRegionBlend(dt);
    updateRegionDetail(dt);
    // 線を描かない間は、詳しい線のデータを読み込まない
    if (coastlines.group.visible) {
      const distance = camera.position.length();
      coastlines.update(distance);
      borders.update(distance);
    }
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
      earth.renderCloudBlend(renderer);
      earth.renderVolumeClouds(renderer, camera);
      // 太陽系の場面は地球の球で奥行きを求められないので、ぼかさない
      hdr.setDepthOfField(solar.active ? null : depthOfField);
      hdr.render();
    } else {
      renderer.render(scene, camera);
    }
    if (mode === 'wind') gpuParticles?.composite();
    updateMarker();
    // 星を描かない風速モードとデモの間は出さない
    planetLabels.update(sky.planets, camera, planetLabelsEnabled && sky.group.visible && !demoMotion && !solar.active);
    solar.updateLabels(!demoMotion);
    cameraPanel.update(dt, {
      focalLength,
      exposure: mode !== 'wind' && earthReady ? exposure * 2 ** exposureCompensation : null,
    });
    if (measureGpu) {
      gpuTimer.end();
      for (const ms of gpuTimer.collect()) {
        fpsWindowGpuMs += ms;
        fpsWindowGpuFrames++;
      }
    }
    fpsWindowCpuMs += performance.now() - frameStart;
  });

  // 動作検証用: 太陽や月が地球の横に見える位置へカメラを動かす
  window.__weatherNewsDebug = {
    exposure: () => exposure,
    cloudProgress: () => earth.cloudProgress,
    camera,
    sky,
    earth,
    regionView: () => regionView,
    solar,
    cruise: () => ({ mode: cruiseMode, level: cruiseLevel, throttle: cruiseThrottle, braking: cruiseBraking, turnRate }),
    setRegionView(next: Partial<RegionView>): void {
      if (!regionView) return;
      regionFlight = null;
      regionView = clampRegionView({ ...regionView, ...next });
      regionDistanceGoal = regionView.distance;
    },
    regionDetailProgress: () => regionDetail?.progress ?? null,
    regionDetail: () => regionDetail,
    renderer,
    demoTimeScale: 1,
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
    setViewTime(at: Date | null): void {
      viewTime = at;
      updateSky();
    },
    setWind,
    setClouds: earth.setCloudData.bind(earth),
    focusLocation,
    startFromOverview,
    returnToLocation,
    setView(next: GlobeView): void {
      if (next === 'solar') enterSolar();
      else if (solar.active) exitSolar(next === 'region' ? enterRegion : undefined);
      else if (next === 'region') enterRegion();
      else leaveRegion(EARTH_VIEW_DIST);
    },
    sunLonLat,
    setDemoMotion(on: boolean): void {
      demoMotion = on;
      if (on) stopCruise();
      syncCityLabels();
      controls.autoRotate = on;
      controls.autoRotateSpeed = DEMO_ROTATE_SPEED;
    },
    // place を省くと設定地点に戻す
    setMarker(place?: DemoPlace): void {
      if (!place) selectedCity = null;
      if (place) placeMarker(place.name, place.lat, place.lon);
      else if (focused) placeMarker(focused.name, focused.latitude, focused.longitude);
      else hideMarker();
    },
    // 設定地点は変えずに、都市へカメラとマーカーを移す。向きと高さは今のまま
    showPlace(place: DemoPlace): void {
      selectedCity = place;
      placeMarker(place.name, place.lat, place.lon);
      if (regionView) {
        if (!regionFlight?.leaving) flyRegion({ ...regionView, lat: place.lat, lon: place.lon }, false);
        return;
      }
      flyTo(markerPos.clone().normalize().multiplyScalar(camera.position.length()));
    },
    // place を省くと設定地点へ向かう
    demoRegion(place?: LonLat): void {
      if (mode === 'wind') return;
      if (solar.active) {
        exitSolar(() => this.demoRegion(place));
        return;
      }
      const from = beginRegion();
      const { lat, lon } = place ?? homeLonLat(from);
      flyRegion({ lat, lon, heading: 0, tilt: DEMO_TILT, distance: DEMO_DISTANCE }, false, DEMO_FLY_SECONDS);
    },
    // 風速モードへの切り替えで既に離れ始めていたら、その動きに任せる
    demoGlobe(dayside = false): void {
      if (solar.active) {
        exitSolar(() => this.demoGlobe(dayside));
        return;
      }
      if (!regionView || regionFlight?.leaving) return;
      const distance = viewDistance(mode) - GLOBE_RADIUS;
      const sun = sunLonLat();
      const place = dayside ? { lat: sun.lat, lon: sun.lon + DEMO_DAYSIDE_OFFSET } : regionView;
      flyRegion({ ...regionView, ...place, heading: 0, tilt: 0, distance }, true, DEMO_FLY_SECONDS);
    },
  };
}

// 背景の宇宙。実際の宇宙は空気がなく光を散らさないので、地球に合わせた露出では真っ黒に写る。
// 青みは見た目のためのもので、設定の「宇宙の青み」で濃さを変える (0 で真っ黒)
const SPACE_GRADIENT: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
  [0, [0x0f, 0x24, 0x48]],
  [0.45, [0x07, 0x12, 0x2b]],
  [1, [0x02, 0x04, 0x0b]],
];

function paintSpaceBackground(canvas: HTMLCanvasElement, tint: number): void {
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(440, 512, 60, 440, 512, 800);
  for (const [stop, [r, g, b]] of SPACE_GRADIENT) {
    gradient.addColorStop(stop, `rgb(${Math.round(r * tint)}, ${Math.round(g * tint)}, ${Math.round(b * tint)})`);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function createSpaceBackground(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  canvas.width = 1024;
  canvas.height = 1024;
  paintSpaceBackground(canvas, 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// file:// の画像は WebGL で使えないので、メインプロセスから受け取ったバイト列を読み込む
async function loadEarthTexture(
  name: EarthTextureName,
  renderer: THREE.WebGLRenderer,
): Promise<THREE.Texture> {
  const bytes = await window.weatherApi.getTexture(name);
  const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    imageOrientation: 'flipY',
  });
  const texture = new THREE.Texture(bitmap);
  texture.flipY = false;
  if (name === 'earth-water') texture.format = THREE.RedFormat; // 1 色だけなので、メモリを 4 分の 1 にする
  if (name === 'earth-day') texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.needsUpdate = true;
  return texture;
}
