// 地球儀のラベルの都市の検証。実行: node --test tests/cities.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAP_CITIES, tierAtAltitude } from '../src/renderer/cities.ts';
import { CITIES } from '../src/renderer/demo.ts';

test('寄るほど小さな都市の段まで出す', () => {
  assert.equal(tierAtAltitude(7), 0);
  assert.equal(tierAtAltitude(2.3), 0);
  assert.equal(tierAtAltitude(1.39), 1);
  assert.equal(tierAtAltitude(0.84), 2);
  assert.equal(tierAtAltitude(0.17), 3);
});

test('デモの行き先は常に出る段で、優先順位の先頭にある', () => {
  CITIES.forEach((place, index) => {
    assert.equal(MAP_CITIES[index].name, place.name);
    assert.equal(MAP_CITIES[index].tier, 0);
  });
});

test('段の小さい都市から順に並ぶ', () => {
  MAP_CITIES.forEach((city, index) => {
    if (index > 0) assert.ok(MAP_CITIES[index - 1].tier <= city.tier, city.name);
  });
});

test('名前が重ならない', () => {
  // マーカーと同じ名前のラベルを隠す判定に名前を使う
  assert.equal(new Set(MAP_CITIES.map((city) => city.name)).size, MAP_CITIES.length);
});

test('緯度と経度が範囲に収まる', () => {
  for (const city of MAP_CITIES) {
    assert.ok(Math.abs(city.lat) <= 90, city.name);
    assert.ok(Math.abs(city.lon) <= 180, city.name);
  }
});
