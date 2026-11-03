// 矢印キーで次の都市を選ぶ計算の検証。実行: node --test tests/city-hop.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearingDegrees, pickCityInDirection } from '../src/renderer/city-hop.ts';

const tokyo = { name: '東京', lat: 35.68, lon: 139.69 };
const sendai = { name: '仙台', lat: 38.27, lon: 140.87 };
const osaka = { name: '大阪', lat: 34.69, lon: 135.5 };
const chiba = { name: '千葉', lat: 35.61, lon: 140.12 };
const niigata = { name: '新潟', lat: 37.92, lon: 139.04 };
const cities = [tokyo, sendai, osaka, chiba, niigata];

test('方位は北が 0、東が 90', () => {
  assert.ok(Math.abs(bearingDegrees({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })) < 1e-9);
  assert.ok(Math.abs(bearingDegrees({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 90) < 1e-9);
  assert.ok(Math.abs(Math.abs(bearingDegrees({ lat: 0, lon: 0 }, { lat: -1, lon: 0 })) - 180) < 1e-9);
});

test('北を向いていれば、↑ で北、← で西、→ で東の都市を選ぶ', () => {
  assert.equal(pickCityInDirection(tokyo, 0, 'up', cities), niigata); // 仙台より近い
  assert.equal(pickCityInDirection(tokyo, 0, 'left', cities), osaka);
  assert.equal(pickCityInDirection(tokyo, 0, 'right', cities), chiba);
  assert.equal(pickCityInDirection(tokyo, 0, 'down', cities), null);
});

test('画面の向きに合わせて回す。西を向いていれば ↑ で西の都市', () => {
  assert.equal(pickCityInDirection(tokyo, -90, 'up', cities), osaka);
  assert.equal(pickCityInDirection(tokyo, 90, 'up', cities), chiba);
  assert.equal(pickCityInDirection(tokyo, 180, 'down', cities), niigata);
});

test('向きのずれが小さい都市を、少し遠くても選ぶ', () => {
  const ahead = { name: '正面', lat: 2, lon: 0 };
  const aside = { name: '斜め', lat: 0.9, lon: 0.9 }; // 45° ずれて距離は約 0.64 倍
  assert.equal(pickCityInDirection({ lat: 0, lon: 0 }, 0, 'up', [ahead, aside]), ahead);
});

test('今いる都市と、向きから大きく外れた都市は選ばない', () => {
  assert.equal(pickCityInDirection(tokyo, 0, 'up', [tokyo]), null);
  const wide = { name: '外れ', lat: 36, lon: 141.5 }; // 北東 (約 75°)
  assert.equal(pickCityInDirection(tokyo, 0, 'up', [wide]), null);
});

test('日付変更線をまたいでも方位を正しく扱う', () => {
  const fiji = { lat: -18, lon: 178.4 };
  const samoa = { name: 'アピア', lat: -13.8, lon: -171.8 };
  assert.equal(pickCityInDirection(fiji, 90, 'up', [samoa]), samoa);
});

test('上限より遠い都市は選ばない', () => {
  const honolulu = { name: 'ホノルル', lat: 21.31, lon: -157.86 };
  assert.equal(pickCityInDirection(tokyo, 90, 'up', [honolulu]), honolulu);
  assert.equal(pickCityInDirection(tokyo, 90, 'up', [honolulu], 27), null);
});
