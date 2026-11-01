// デモの場面と行き先の検証。実行: node --test tests/demo.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DAY_PLACES, DEMO_SCENES, NIGHT_PLACES, pickDemoPlace, sunElevation } from '../src/renderer/demo.ts';

test('太陽の高度は真下で 90 度、裏側で -90 度', () => {
  assert.ok(Math.abs(sunElevation({ lat: 10, lon: 20 }, { lat: 10, lon: 20 }) - 90) < 1e-6);
  assert.ok(Math.abs(sunElevation({ lat: -10, lon: -160 }, { lat: 10, lon: 20 }) + 90) < 1e-6);
});

test('昼の場所は太陽が高い場所から選び、順番に進む', () => {
  const sun = { lat: 0, lon: 80 }; // ヒマラヤが昼で、アメリカ大陸は夜
  const first = pickDemoPlace('day', sun, 0);
  assert.equal(first.place.name, 'ヒマラヤ山脈');
  const second = pickDemoPlace('day', sun, first.next);
  assert.notEqual(second.place.name, first.place.name);
  assert.ok(sunElevation(second.place, sun) >= 15);
});

test('夜の場所は太陽が沈んだ場所から選ぶ', () => {
  const sun = { lat: 0, lon: -60 }; // アメリカ大陸が昼で、東京は夜
  const { place } = pickDemoPlace('night', sun, 0);
  assert.equal(place.name, '東京');
  assert.ok(sunElevation(place, sun) <= -6);
});

test('どの太陽の位置でも昼と夜の場所が見つかる', () => {
  for (let lon = -180; lon < 180; lon += 15) {
    for (const lat of [-23, 0, 23]) {
      const sun = { lat, lon };
      assert.ok(DAY_PLACES.some((place) => sunElevation(place, sun) >= 15), `昼 ${lat},${lon}`);
      assert.ok(NIGHT_PLACES.some((place) => sunElevation(place, sun) <= -6), `夜 ${lat},${lon}`);
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
