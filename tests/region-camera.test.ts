// 地域ビューのカメラの検証。実行: node --test tests/region-camera.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approachDistance,
  clampRegionView,
  coastRegionView,
  interpolateRegionView,
  lonLatOf,
  panRegionView,
  regionPose,
  type RegionView,
  type Vec3,
} from '../src/renderer/region-camera.ts';

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

test('つかんだ地点が指の下へ来るように中心が動く', () => {
  const moved = panRegionView(TOKYO, { lat: 36, lon: 140 }, { lat: 35, lon: 139 });
  near(moved.lat, 36.6);
  near(moved.lon, 140.7);
});

test('日付変更線をまたぐつかみ移動は短い向きへ動く', () => {
  const view = { ...TOKYO, lon: 179.5 };
  const moved = panRegionView(view, { lat: 35, lon: -179 }, { lat: 35, lon: 179 });
  near(moved.lon, -178.5);
});

test('地平線の近くをつかんでも 1 回の移動量は抑えられる', () => {
  const moved = panRegionView(TOKYO, { lat: 80, lon: 0 }, { lat: 35, lon: 139 });
  near(moved.lat, 45.6);
});

test('補間は経度と方角の近い向きを通る', () => {
  const from = { ...TOKYO, lon: 170, heading: 170 };
  const to = { ...TOKYO, lon: -170, heading: -170 };
  const middle = interpolateRegionView(from, to, 0.5);
  assert.equal(Math.abs(middle.lon), 180);
  assert.equal(Math.abs(middle.heading), 180);
  assert.deepEqual(interpolateRegionView(TOKYO, { ...TOKYO, tilt: 60 }, 1).tilt, 60);
});

test('慣性は FPS によらず同じ距離で止まる', () => {
  const speed = { lat: 10, lon: -20, heading: 30, tilt: 0 };
  const run = (fps: number): RegionView => {
    let state = { view: { ...TOKYO, lat: 0, lon: 0 }, velocity: speed };
    for (let i = 0; i < fps * 3; i++) state = coastRegionView(state.view, state.velocity, 1 / fps);
    return state.view;
  };
  const at30 = run(30);
  const at120 = run(120);
  assert.ok(Math.abs(at30.lat - at120.lat) < 1e-6);
  assert.ok(Math.abs(at30.lat - 1) < 1e-4); // 速さ × 0.1 秒で止まる
  assert.ok(Math.abs(at30.lon + 2) < 1e-4);
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
