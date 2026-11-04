// 地域ビューのカメラの検証。実行: node --test tests/region-camera.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addRegionDrag,
  approachDistance,
  clampRegionView,
  cruiseRegionView,
  DRAG_FOLLOW_SECONDS,
  followRegionDrag,
  interpolateRegionView,
  lonLatOf,
  panRegionDelta,
  REGION_STILL,
  regionPose,
  type RegionView,
} from '../src/renderer/region-camera.ts';
import { DEG, wrapDegrees, type Vec3 } from '../src/renderer/math.ts';

const TOKYO: RegionView = { lat: 35.6, lon: 139.7, heading: 0, tilt: 0, distance: 0.3 };

function near(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} ${actual} != ${expected}`);
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

// globe.ts の lonLatToVector3 と同じ式
function expectedPoint(lon: number, lat: number): Vec3 {
  const phi = ((lon + 180) / 360) * Math.PI * 2;
  const theta = ((90 - lat) * Math.PI) / 180;
  return [-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)];
}

test('中心の地点は地球儀の座標と一致する', () => {
  const { target } = regionPose(TOKYO);
  expectedPoint(139.7, 35.6).forEach((value, i) => near(target[i], value));
});

test('緯度経度と座標は相互に変換できる', () => {
  for (const [lon, lat] of [[139.7, 35.6], [-122.4, 37.8], [2.35, 48.85], [-179.5, -20], [0, 0]]) {
    const result = lonLatOf(expectedPoint(lon, lat));
    near(result.lon, lon);
    near(result.lat, lat);
  }
});

test('傾き 0 は真上から見下ろし、北が画面の上', () => {
  const { position, target, up } = regionPose(TOKYO);
  const ground = lonLatOf(position);
  near(ground.lat, 35.6);
  near(ground.lon, 139.7);
  near(Math.hypot(...position), 1.3);
  const north = sub(expectedPoint(139.7, 35.7), target);
  assert.ok(dot(up, north) > 0);
});

test('どの向きでも、中心までの距離が保たれ、上方向は視線と直交する', () => {
  for (const heading of [-170, -45, 0, 90, 135]) {
    for (const tilt of [0, 30, 58, 72]) {
      const { position, target, up } = regionPose({ ...TOKYO, heading, tilt });
      const toTarget = sub(target, position);
      near(Math.hypot(...toTarget), 0.3, 'distance');
      near(Math.hypot(...up), 1, 'up length');
      near(dot(up, toTarget), 0, 'up');
    }
  }
});

test('北を向くとカメラは中心より南に、東を向くと西にある', () => {
  const facingNorth = lonLatOf(regionPose({ ...TOKYO, tilt: 60 }).position);
  assert.ok(facingNorth.lat < 35.6);
  near(facingNorth.lon, 139.7);
  const facingEast = lonLatOf(regionPose({ ...TOKYO, heading: 90, tilt: 60 }).position);
  assert.ok(facingEast.lon < 139.7);
});

test('移動の範囲を超えない', () => {
  const clamped = clampRegionView({ lat: 95, lon: 190, heading: 200, tilt: 90, distance: 0.01 });
  assert.deepEqual(clamped, { lat: 80, lon: -170, heading: -160, tilt: 72, distance: 0.1 });
  assert.equal(clampRegionView({ ...TOKYO, distance: 9 }).distance, 1);
});

test('移動のドラッグは、指の下の地面が指に付いてくる向きに中心を動かす', () => {
  const delta = panRegionDelta({ lat: 36, lon: 140 }, { lat: 35, lon: 139 });
  near(delta.lat, 1);
  near(delta.lon, 1);
  assert.equal(delta.heading, 0);
});

test('日付変更線をまたぐ移動は短い向きへ動く', () => {
  near(panRegionDelta({ lat: 35, lon: -179 }, { lat: 35, lon: 179 }).lon, 2);
});

test('地平線の近くで動かしても 1 回の移動量は抑えられる', () => {
  near(panRegionDelta({ lat: 80, lon: 0 }, { lat: 35, lon: 139 }).lat, 10);
});

test('緯度と傾きの上限を越える分は溜めない', () => {
  const view = { ...TOKYO, lat: 79, tilt: 70 };
  const pending = addRegionDrag(view, REGION_STILL, { lat: 5, lon: 3, heading: 20, tilt: 10 });
  near(pending.lat, 1);
  near(pending.tilt, 2);
  near(pending.lon, 3);
  near(pending.heading, 20);
  // 越えた分が溜まっていないので、逆へ動かせばすぐ戻る
  near(addRegionDrag(view, pending, { lat: -1, lon: 0, heading: 0, tilt: -2 }).tilt, 0);
});

test('補間は経度と方角の近い向きを通る', () => {
  const from = { ...TOKYO, lon: 170, heading: 170 };
  const to = { ...TOKYO, lon: -170, heading: -170 };
  const middle = interpolateRegionView(from, to, 0.5);
  assert.equal(Math.abs(middle.lon), 180);
  assert.equal(Math.abs(middle.heading), 180);
  assert.deepEqual(interpolateRegionView(TOKYO, { ...TOKYO, tilt: 60 }, 1).tilt, 60);
});

test('ドラッグにはカメラが遅れて付いてきて、FPS によらず同じ動きで追いつく', () => {
  const pending = { lat: 2, lon: -4, heading: 30, tilt: 0 };
  const run = (fps: number, seconds: number): RegionView => {
    let state = { view: { ...TOKYO, lat: 0, lon: 0 }, pending };
    for (let i = 0; i < fps * seconds; i++) state = followRegionDrag(state.view, state.pending, 1 / fps);
    return state.view;
  };
  // 時定数のあいだに約 63% だけ進む
  near(run(60, DRAG_FOLLOW_SECONDS * 3).lat, run(120, DRAG_FOLLOW_SECONDS * 3).lat);
  const early = run(120, DRAG_FOLLOW_SECONDS);
  assert.ok(Math.abs(early.heading - 30 * (1 - Math.exp(-1))) < 0.2, String(early.heading));
  // 十分に時間がたつと、動かした分ちょうどに着く
  const done = run(30, DRAG_FOLLOW_SECONDS * 30);
  assert.ok(Math.abs(done.lat - 2) < 1e-6 && Math.abs(done.lon + 4) < 1e-6 && Math.abs(done.heading - 30) < 1e-6);
});

test('距離は FPS によらず同じように目標へ近づく', () => {
  const run = (fps: number): number => {
    let distance = 0.5;
    for (let i = 0; i < fps * 0.2; i++) distance = approachDistance(distance, 0.1, 1 / fps);
    return distance;
  };
  assert.ok(Math.abs(run(30) - run(120)) < 1e-9);
  assert.ok(run(60) < 0.5 && run(60) > 0.1);
});

test('巡航は今の向きへ大円に沿って進む', () => {
  const east = cruiseRegionView({ lat: 0, lon: 10, heading: 90, tilt: 50, distance: 0.24 }, 0.1, 0);
  assert.ok(Math.abs(east.lat) < 1e-9);
  assert.ok(Math.abs(east.lon - (10 + 0.1 / DEG)) < 1e-9);
  assert.ok(Math.abs(east.heading - 90) < 1e-9);
  const north = cruiseRegionView({ lat: 20, lon: 10, heading: 0, tilt: 50, distance: 0.24 }, 10 * DEG, 0);
  assert.ok(Math.abs(north.lat - 30) < 1e-9 && Math.abs(north.lon - 10) < 1e-9);
  // 東へまっすぐ進むと、北半球では方角が南寄りへ変わる
  const curve = cruiseRegionView({ lat: 40, lon: 0, heading: 90, tilt: 50, distance: 0.24 }, 30 * DEG, 0);
  assert.ok(curve.heading > 100, `${curve.heading}`);
});

test('巡航で後退すると、向きを保ったまま後ろへ進み、前進と同じ道を戻る', () => {
  const west = cruiseRegionView({ lat: 0, lon: 10, heading: 90, tilt: 50, distance: 0.24 }, -0.1, 0);
  assert.ok(Math.abs(west.lat) < 1e-9);
  assert.ok(Math.abs(west.lon - (10 - 0.1 / DEG)) < 1e-9);
  assert.ok(Math.abs(west.heading - 90) < 1e-9);
  const start = { lat: 40, lon: 0, heading: 90, tilt: 50, distance: 0.24 };
  const back = cruiseRegionView(cruiseRegionView(start, 30 * DEG, 0), -30 * DEG, 0);
  assert.ok(Math.abs(back.lat - start.lat) < 1e-9 && Math.abs(back.lon - start.lon) < 1e-9);
  assert.ok(Math.abs(back.heading - start.heading) < 1e-9, `${back.heading}`);
});

test('巡航で進むと、カメラも同じ角度だけ進み、高さと傾きは変わらない', () => {
  const view = { lat: 35, lon: 139, heading: 30, tilt: 50, distance: 0.24 };
  const next = cruiseRegionView(view, 0.05, 0);
  const before = regionPose(view).position;
  const after = regionPose(next).position;
  const angle = Math.acos(dot(before, after) / (Math.hypot(...before) * Math.hypot(...after)));
  assert.ok(Math.abs(angle - 0.05) < 1e-6, `${angle}`);
  assert.equal(next.tilt, view.tilt);
  assert.equal(next.distance, view.distance);
});

test('巡航で向きを変えるときは、カメラの位置を軸にする', () => {
  const view = { lat: 35, lon: 139, heading: 30, tilt: 50, distance: 0.24 };
  const turned = cruiseRegionView(view, 0, 20);
  const before = regionPose(view).position;
  const after = regionPose(turned).position;
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(before[i] - after[i]) < 1e-9, `${i}: ${before[i]} と ${after[i]}`);
  // カメラの真上の向きを軸にして、視線が水平に 20° 回る。中心の地点の方角は子午線の収束の分だけ違う
  const vertical = before.map((v) => v / Math.hypot(...before)) as unknown as Vec3;
  const level = (target: Vec3): Vec3 => {
    const f = target.map((v, i) => v - before[i]) as unknown as Vec3;
    const along = dot(f, vertical);
    return f.map((v, i) => v - vertical[i] * along) as unknown as Vec3;
  };
  const [a, b] = [level(regionPose(view).target), level(regionPose(turned).target)];
  near(Math.acos(dot(a, b) / (Math.hypot(...a) * Math.hypot(...b))) / DEG, 20, 'turn');
  assert.ok(wrapDegrees(turned.heading - view.heading) > 0);
});

test('巡航でも緯度の上限を越えない', () => {
  const next = cruiseRegionView({ lat: 79.9, lon: 0, heading: 0, tilt: 50, distance: 0.24 }, 1 * DEG, 0);
  assert.ok(next.lat <= 80);
});
