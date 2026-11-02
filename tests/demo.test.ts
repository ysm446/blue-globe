// デモの場面と行き先の検証。実行: node --test tests/demo.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CITIES, DEMO_SCENES, pickDemoPlace, sunElevation } from '../src/renderer/demo.ts';

test('太陽の高度は真下で 90 度、裏側で -90 度', () => {
  assert.ok(Math.abs(sunElevation({ lat: 10, lon: 20 }, { lat: 10, lon: 20 }) - 90) < 1e-6);
  assert.ok(Math.abs(sunElevation({ lat: -10, lon: -160 }, { lat: 10, lon: 20 }) + 90) < 1e-6);
});

test('昼の都市は太陽が高い場所から、夜の都市は太陽が沈んだ場所から選ぶ', () => {
  const sun = { lat: 0, lon: 80 };
  for (let i = 0; i < 50; i++) {
    assert.ok(sunElevation(pickDemoPlace('day', sun, []), sun) >= 15);
    assert.ok(sunElevation(pickDemoPlace('night', sun, []), sun) <= -6);
  }
});

test('都市は昼夜を問わず選ばれる', () => {
  const sun = { lat: 0, lon: 80 };
  const picked = new Set(Array.from({ length: 300 }, () => pickDemoPlace('city', sun, []).name));
  assert.equal(picked.size, CITIES.length);
});

test('最近行った場所を避ける', () => {
  const sun = { lat: 0, lon: 0 };
  const recent: string[] = [];
  const names: string[] = [];
  for (let i = 0; i < 40; i++) names.push(pickDemoPlace('city', sun, recent).name);
  names.forEach((name, index) => {
    assert.ok(!names.slice(Math.max(0, index - 5), index).includes(name), `${index}: ${name}`);
  });
  assert.equal(recent.length, 5);
});

test('風の場面のほかは雲を出す', () => {
  for (const scene of DEMO_SCENES) assert.notEqual(scene.mode, 'normal');
  assert.equal(DEMO_SCENES.filter((scene) => scene.mode === 'wind').length, 1);
});

test('どの太陽の位置でも昼と夜の都市が見つかる', () => {
  for (let lon = -180; lon < 180; lon += 15) {
    for (const lat of [-23, 0, 23]) {
      const sun = { lat, lon };
      assert.ok(CITIES.some((place) => sunElevation(place, sun) >= 15), `昼 ${lat},${lon}`);
      assert.ok(CITIES.some((place) => sunElevation(place, sun) <= -6), `夜 ${lat},${lon}`);
    }
  }
});

test('風速モードに地域ビューがなく、地域ビューの場面が続かない', () => {
  assert.ok(DEMO_SCENES.every((scene) => !(scene.mode === 'wind' && scene.view === 'region')));
  DEMO_SCENES.forEach((scene, index) => {
    const next = DEMO_SCENES[(index + 1) % DEMO_SCENES.length];
    assert.ok(!(scene.view === 'region' && next.view === 'region'));
  });
});
