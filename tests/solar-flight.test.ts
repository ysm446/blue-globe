// 地球ビューと太陽系の間のカメラの動きの検証。実行: node --test tests/solar-flight.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subsolarPoint, siderealDegrees } from '../src/renderer/astro.ts';
import { DEG, dot, type Vec3 } from '../src/renderer/math.ts';
import { heliocentricPositions } from '../src/renderer/planets.ts';
import {
  AU_IN_EARTH_RADII,
  ECLIPTIC_NORTH,
  equatorialToScene,
  overviewPose,
  solarFlightPose,
  type SolarPose,
} from '../src/renderer/solar-flight.ts';

const date = new Date('2026-11-03T03:00Z');
const earth = equatorialToScene(heliocentricPositions(date).earth);
const sun: Vec3 = [0, 0, 0];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a);
  return [a[0] / length, a[1] / length, a[2] / length];
};
const angle = (a: Vec3, b: Vec3): number => Math.acos(Math.min(1, dot(unit(a), unit(b)))) / DEG;

// 地球ビューの既定の姿勢 (地球から 3.3 倍の距離。画面の上は天の北極)
const globePose: SolarPose = {
  sunWeight: 0,
  distance: 3.3 / AU_IN_EARTH_RADII,
  direction: unit([0.3, 0.4, 0.86]),
  up: [0, 1, 0],
};
const overview = overviewPose(earth, 5, 35);

test('地球から見た太陽の向きが、太陽直下点の向きと合う', () => {
  // 惑星の計算 (J2000) と太陽の計算 (その日の座標) は別の式なので、歳差の分 (約 0.36°) までずれてよい
  const { lon, lat } = subsolarPoint(date);
  const ra = (lon + siderealDegrees(date)) * DEG;
  const expected = equatorialToScene([Math.cos(lat * DEG) * Math.cos(ra), Math.cos(lat * DEG) * Math.sin(ra), Math.sin(lat * DEG)]);
  assert.ok(angle(sub(sun, earth), expected) < 0.5, `${angle(sub(sun, earth), expected)}`);
});

test('始めと終わりは指定した姿勢になる', () => {
  for (const [t, pose, center] of [[0, globePose, earth], [1, overview, sun]] as const) {
    const result = solarFlightPose(globePose, overview, t, earth, sun);
    const expected: Vec3 = [
      center[0] + pose.direction[0] * pose.distance,
      center[1] + pose.direction[1] * pose.distance,
      center[2] + pose.direction[2] * pose.distance,
    ];
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(result.position[i] - expected[i]) < 1e-9, `t=${t}`);
  }
});

test('引いていく間も戻る間も、地球は画面の中心から 20° 以内にある', () => {
  for (const [from, to] of [[globePose, overview], [overview, globePose]]) {
    for (let i = 0; i <= 200; i++) {
      const { position, target } = solarFlightPose(from, to, i / 200, earth, sun);
      const offset = angle(sub(target, position), sub(earth, position));
      assert.ok(offset < 20, `t=${i / 200}: ${offset.toFixed(1)}°`);
    }
  }
});

test('距離は途中で行ったり来たりしない', () => {
  let previous = 0;
  for (let i = 0; i <= 100; i++) {
    const { position, target } = solarFlightPose(globePose, overview, i / 100, earth, sun);
    const distance = Math.hypot(...sub(position, target));
    assert.ok(distance >= previous);
    previous = distance;
  }
});

test('見下ろす姿勢は黄道の上にあり、画面の上は黄道の北', () => {
  const elevation = 90 - angle(overview.direction, ECLIPTIC_NORTH);
  assert.ok(Math.abs(elevation - 35) < 1e-6);
  assert.deepEqual(overview.up, ECLIPTIC_NORTH);
});
