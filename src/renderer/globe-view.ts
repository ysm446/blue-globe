// 地球儀の表示とカメラ操作。モード、地域ビュー、描画の設定をここで扱う
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { DemoPlace } from './demo';
import { el } from './dom';
import { CLOUD_ALTITUDE, RealisticEarth } from './earth';
import { adaptExposure, earthClearance, screenPresence, targetExposure } from './exposure';
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
import { RegionDetail } from './region-detail';
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
const DAMPING_AT_REFERENCE = 0.08;

const MIN_DIST = 1.2;
const MAX_DIST = 8;
const FOCUS_DIST = 2.15; // 風速モードで地点に寄ったときのカメラ距離
const EARTH_VIEW_DIST = 3.3; // 通常・天気モードは地球全体が見える距離にする
const OVERVIEW_DIST = 4.6;
const FLY_SECONDS = 2.8;
const PANEL_OVERLAP_WIDTH = 900; // これより狭い画面ではパネルを下に置く (style.css と合わせる)

const EARTH_SURFACE_RADIUS = GLOBE_RADIUS * 1.0005;
const COASTLINE_RADIUS = GLOBE_RADIUS * 1.0015;
const BORDER_RADIUS = GLOBE_RADIUS * 1.0014;
const REGION_LINE_RADIUS = GLOBE_RADIUS * 1.0007; // 斜めに見ると線が地表からずれるので、地域ビューでは地表へ寄せる
const CAMERA_NEAR_MAX = 0.1;
const CAMERA_NEAR_MIN = 0.005;
const REGION_BLEND_SECONDS = 0.5;
const DEMO_FLY_SECONDS = 6;
const DEMO_ROTATE_SPEED = 0.42; // OrbitControls の単位。毎秒約 2.5 度で、地表は実際の自転と同じ東向きに動く
const DEMO_TURN_DEGREES_PER_SECOND = 1.2; // 地域ビューで中心のまわりを回る速さ
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

export function initGlobe() {
  const container = el('app');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1, 3.6);

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

  const hdr = new HdrPipeline(renderer, scene, camera);
  const flatBackground = new THREE.Color(COLORS.background);
  const spaceBackground = createSpaceBackground();

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

  function sunLonLat(): LonLat {
    return lonLatOf(sky.sunDir.toArray());
  }

  function cameraAltitude(): number {
    return camera.position.length() - GLOBE_RADIUS;
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
  }

  const marker = el('marker');
  const markerPos = new THREE.Vector3();
  const projected = new THREE.Vector3();
  let markerNormal: THREE.Vector3 | null = null;
  let focused: WeatherLocation | null = null;

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

  function flyRegion(to: RegionView, leaving: boolean, seconds = FLY_SECONDS): void {
    if (!regionView) return;
    regionFlight = { from: regionView, to, elapsed: 0, seconds, leaving };
    regionVelocity = REGION_STILL;
    regionDrag = null;
  }

  function homeLonLat(fallback: LonLat): LonLat {
    return focused ? { lat: focused.latitude, lon: focused.longitude } : fallback;
  }

  // 真上から見た地球ビューの姿勢から続けて、傾きながら地点へ寄る
  function regionHomeOf(from: LonLat): RegionView {
    const { lat, lon } = homeLonLat(from);
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

  // 地表へ近づいても欠けないよう、カメラの手前の描画範囲は高度に合わせる
  function updateNearPlane(): void {
    const near = THREE.MathUtils.clamp((cameraAltitude() - CLOUD_ALTITUDE) * 0.5, CAMERA_NEAR_MIN, CAMERA_NEAR_MAX);
    if (near === camera.near) return;
    camera.near = near;
    camera.updateProjectionMatrix();
  }

  const shadowFocus = new THREE.Vector3();
  function updateRegionBlend(dt: number): void {
    const goal = regionView && !regionFlight?.leaving ? 1 : 0;
    regionBlend += (goal - regionBlend) * (1 - Math.exp(-dt / REGION_BLEND_SECONDS));
    earth.setRegionBlend(regionBlend, cameraAltitude());
    if (regionView) {
      lonLatToVector3(regionView.lon, regionView.lat, EARTH_SURFACE_RADIUS, shadowFocus);
      earth.setVolumeShadowFocus(shadowFocus, regionView.distance);
    }
    // 風速モードでは粒子の面より上に線を置く必要があるので、元の高さのまま
    const lineRadius = (radius: number): number =>
      THREE.MathUtils.lerp(radius, mode === 'wind' ? radius : REGION_LINE_RADIUS, regionBlend) / radius;
    coastlines.group.scale.setScalar(lineRadius(COASTLINE_RADIUS));
    borders.group.scale.setScalar(lineRadius(BORDER_RADIUS));
  }

  function placeMarker(name: string, lat: number, lon: number): void {
    el('marker-label').textContent = name;
    lonLatToVector3(lon, lat, EARTH_SURFACE_RADIUS, markerPos);
    markerNormal = markerPos.clone().normalize();
    marker.hidden = false;
  }

  function focusLocation(location: WeatherLocation): void {
    focused = location;
    placeMarker(location.name, location.latitude, location.longitude);
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

  function updateFlight(dt: number): void {
    if (!flight) {
      // 寄るほどゆっくり回し、触ったときに地表が指に付いてくる感覚に近づける
      controls.rotateSpeed = THREE.MathUtils.clamp(cameraAltitude() * 0.32, 0.05, 0.6);
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
    if (!markerNormal) return;
    // 地球の裏側にあるときは隠す
    const distance = camera.position.length();
    const facing = markerNormal.dot(camera.position) / distance;
    projected.copy(markerPos).project(camera);
    // 斜めの視点では、地平線より手前でもカメラの後ろにあることがある (このとき z は 1 を超える)
    const visible = facing > GLOBE_RADIUS / distance && projected.z < 1;
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
      earthClearance(camera.position.toArray(), toSun.toArray(), GLOBE_RADIUS);
    const facing = camera.position.dot(sky.sunDir) / camera.position.length();
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
    earth.setGlintStrength(graphics.glint_strength);
    earth.setVolumeCloudsEnabled(graphics.volume_clouds);
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

    if (regionView) updateRegion(dt);
    else updateFlight(dt);
    updateNearPlane();
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
      earth.renderVolumeClouds(renderer, camera);
      hdr.render();
    } else {
      renderer.render(scene, camera);
    }
    if (mode === 'wind') gpuParticles?.composite();
    updateMarker();
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
    setRegionView(next: Partial<RegionView>): void {
      if (!regionView) return;
      regionFlight = null;
      regionView = clampRegionView({ ...regionView, ...next });
      regionDistanceGoal = regionView.distance;
    },
    regionDetailProgress: () => regionDetail?.progress ?? null,
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
    setWind,
    setClouds: earth.setCloudData.bind(earth),
    focusLocation,
    startFromOverview,
    returnToLocation,
    setView(next: GlobeView): void {
      if (next === 'region') enterRegion();
      else leaveRegion(EARTH_VIEW_DIST);
    },
    sunLonLat,
    setDemoMotion(on: boolean): void {
      demoMotion = on;
      controls.autoRotate = on;
      controls.autoRotateSpeed = DEMO_ROTATE_SPEED;
    },
    // place を省くと設定地点に戻す
    demoMarker(place?: DemoPlace): void {
      if (place) placeMarker(place.name, place.lat, place.lon);
      else if (focused) placeMarker(focused.name, focused.latitude, focused.longitude);
      else marker.hidden = true;
    },
    // place を省くと設定地点へ向かう
    demoRegion(place?: LonLat): void {
      if (mode === 'wind') return;
      const from = beginRegion();
      const { lat, lon } = place ?? homeLonLat(from);
      flyRegion({ lat, lon, heading: 0, tilt: DEMO_TILT, distance: DEMO_DISTANCE }, false, DEMO_FLY_SECONDS);
    },
    // 風速モードへの切り替えで既に離れ始めていたら、その動きに任せる
    demoGlobe(dayside = false): void {
      if (!regionView || regionFlight?.leaving) return;
      const distance = viewDistance(mode) - GLOBE_RADIUS;
      const sun = sunLonLat();
      const place = dayside ? { lat: sun.lat, lon: sun.lon + DEMO_DAYSIDE_OFFSET } : regionView;
      flyRegion({ ...regionView, ...place, heading: 0, tilt: 0, distance }, true, DEMO_FLY_SECONDS);
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
