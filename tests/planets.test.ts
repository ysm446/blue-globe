// 惑星の方向と明るさの検証。実行: node --test tests/planets.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { separationDegrees } from '../src/renderer/math.ts';
import { planetSky } from '../src/renderer/planets.ts';

// JPL Horizons の値 (2026-11-03 取得)。地球の中心から見た J2000 の赤経、赤緯 (度) と等級
const REFERENCE: Record<string, Record<string, [number, number, number]>> = {
  '2026-11-03T00:00Z': {
    水星: [221.14503, -16.88128, 5.097],
    金星: [201.46312, -13.72526, -4.311],
    火星: [142.20193, 16.60884, 0.786],
    木星: [146.73088, 14.11556, -2.014],
    土星: [9.12156, 1.01662, 0.471],
    天王星: [62.26702, 20.83716, 5.609],
    海王星: [2.08632, -0.63678, 7.696],
  },
  // 火星が地球に近づいたとき。近いほど位置の誤差が大きく出る
  '2025-01-16T00:00Z': {
    水星: [281.74147, -23.80186, -0.461],
    金星: [344.17966, -6.8364, -4.582],
    火星: [118.76772, 25.17325, -1.417],
    木星: [70.11112, 21.62246, -2.643],
    土星: [347.3679, -7.52902, 1.092],
    天王星: [50.67224, 18.28099, 5.693],
    海王星: [357.95414, -2.27848, 7.789],
  },
};

for (const [time, expected] of Object.entries(REFERENCE)) {
  test(`${time} の惑星の方向は 0.1° 以内`, () => {
    for (const planet of planetSky(new Date(time))) {
      const [ra, dec] = expected[planet.name];
      const error = separationDegrees({ lon: planet.ra, lat: planet.dec }, { lon: ra, lat: dec });
      assert.ok(error < 0.1, `${planet.name}: ${error.toFixed(3)}°`);
    }
  });

  test(`${time} の惑星の等級は 0.3 等以内`, () => {
    for (const planet of planetSky(new Date(time))) {
      const magnitude = expected[planet.name][2];
      assert.ok(Math.abs(planet.magnitude - magnitude) < 0.3, `${planet.name}: ${planet.magnitude.toFixed(2)} と ${magnitude}`);
    }
  });
}
