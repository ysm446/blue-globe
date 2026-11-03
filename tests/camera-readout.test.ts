// カメラのパネルの値の検証。実行: node --test tests/camera-readout.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EARTH_RADIUS_KM,
  formatAltitude,
  formatExposure,
  formatHeading,
  formatLatitude,
  formatLongitude,
  formatSpeed,
  groundDistanceKm,
  viewReadout,
} from '../src/renderer/camera-readout.ts';
import { DEG, type Vec3 } from '../src/renderer/math.ts';
import { regionPose } from '../src/renderer/region-camera.ts';

const near = (actual: number, expected: number, tolerance = 1e-6): void => {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} と ${expected}`);
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a);
  return [a[0] / length, a[1] / length, a[2] / length];
};

test('地域ビューの姿勢から、中心の地点と方位と傾きを読み取れる', () => {
  for (const view of [
    { lat: 35.5, lon: 139.7, heading: 0, tilt: 50, distance: 0.24 },
    { lat: -33.9, lon: 18.4, heading: 135, tilt: 30, distance: 0.5 },
    { lat: 60, lon: -150, heading: 270, tilt: 72, distance: 0.1 },
    { lat: 10, lon: 179.9, heading: 45, tilt: 0, distance: 0.3 },
  ]) {
    const { position, target, up } = regionPose(view);
    const readout = viewReadout(position, unit(sub(target, position)), up, 1);
    near(readout.lat, view.lat);
    near(readout.lon, view.lon);
    near(readout.heading, view.heading, 1e-3);
    near(readout.tilt, view.tilt, 1e-6);
  }
});

test('地球ビューは真下を見ていて、北が上なら方位は 0', () => {
  // 北緯 35 度、東経 0 度の上空から中心を見る。画面の上は北 (座標は globe.ts の lonLatToVector3 と同じ)
  const lat = 35 * DEG;
  const position: Vec3 = [Math.cos(lat) * 3.3, Math.sin(lat) * 3.3, 0];
  const forward = unit(sub([0, 0, 0], position));
  const up: Vec3 = [-Math.sin(lat), Math.cos(lat), 0];
  const readout = viewReadout(position, forward, up, 1);
  near(readout.lat, 35);
  near(readout.lon, 0);
  near(readout.tilt, 0);
  near(readout.heading, 0, 1e-3);
});

test('視線が地表に当たらなければ、カメラの真下の地点を出す', () => {
  const position: Vec3 = [0, 0, 2];
  const readout = viewReadout(position, [1, 0, 0], [0, 1, 0], 1);
  near(readout.lat, 0);
  near(readout.tilt, 90);
});

test('地表に沿った距離は、真下の地点の間の弧の長さ', () => {
  near(groundDistanceKm([1, 0, 0], [0, 3, 0]), (Math.PI / 2) * EARTH_RADIUS_KM);
  near(groundDistanceKm([2, 0, 0], [2, 1e-7, 0]), 0.5e-7 * EARTH_RADIUS_KM, 1e-9);
  near(groundDistanceKm([1, 0, 0], [2, 0, 0]), 0);
});

test('数字の書式', () => {
  assert.equal(formatAltitude(14653.4), '14,653 km');
  assert.equal(formatAltitude(637.1), '637 km');
  assert.equal(formatAltitude(42.25), '42.3 km');
  assert.equal(formatSpeed(7.66), '7.66 km/s');
  assert.equal(formatSpeed(42.25), '42.3 km/s');
  assert.equal(formatSpeed(1234.5), '1,235 km/s');
  assert.equal(formatLatitude(35.531), '北緯 35.53°');
  assert.equal(formatLatitude(-33.9), '南緯 33.90°');
  assert.equal(formatLongitude(139.703), '東経 139.70°');
  assert.equal(formatLongitude(-0.1), '西経 0.10°');
  assert.equal(formatHeading(0), '0°(北)');
  assert.equal(formatHeading(359.7), '0°(北)');
  assert.equal(formatHeading(135), '135°(南東)');
  assert.equal(formatHeading(292), '292°(西)');
  assert.equal(formatExposure(1), '0.0 EV');
  assert.equal(formatExposure(2), '+1.0 EV');
  assert.equal(formatExposure(0.3), '-1.7 EV');
  assert.equal(formatExposure(0.99), '0.0 EV');
  assert.equal(formatExposure(null), '—');
});
