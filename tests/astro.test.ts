// 太陽と月の位置の検証。実行: node --test tests/astro.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { siderealDegrees, starIntensity, sublunarPoint, subsolarPoint } from '../src/renderer/astro.ts';
import { separationDegrees } from '../src/renderer/math.ts';

// 地点から見た太陽の高度 (度)。大気差は含まない
function sunElevation(date: Date, lon: number, lat: number): number {
  return 90 - separationDegrees({ lon, lat }, subsolarPoint(date));
}

test('分点と至点で太陽直下点の緯度が合う', () => {
  assert.ok(Math.abs(subsolarPoint(new Date('2026-03-20T14:46Z')).lat) < 0.02);
  assert.ok(Math.abs(subsolarPoint(new Date('2026-09-23T00:05Z')).lat) < 0.02);
  assert.ok(Math.abs(subsolarPoint(new Date('2026-06-21T08:24Z')).lat - 23.436) < 0.02);
  assert.ok(Math.abs(subsolarPoint(new Date('2026-12-21T20:50Z')).lat + 23.436) < 0.02);
});

test('太陽直下点の経度は UTC 正午におよそ 0 度になる', () => {
  // 11 月初めは均時差が約 +16 分で、グリニッジの南中は 11:44 頃。正午には太陽は約 4 度西へ過ぎている
  const { lon } = subsolarPoint(new Date('2026-11-03T12:00Z'));
  assert.ok(Math.abs(lon + 4.1) < 0.2, `lon=${lon}`);
});

// Open-Meteo が返した日の出・日の入りの時刻 (2026-11-01 取得、分単位)。
// 日の出・日の入りの太陽の中心は、大気差と視半径の分だけ地平線の下 (約 -0.83°) にある
const REFERENCE = [
  ['東京', 139.7, 35.66, '2026-10-31T21:02Z', '2026-11-01T07:46Z'],
  ['パリ', 2.35, 48.85, '2026-11-01T06:37Z', '2026-11-01T16:30Z'],
  ['シドニー', 151.21, -33.87, '2026-10-31T18:55Z', '2026-11-01T08:22Z'],
] as const;

for (const [name, lon, lat, sunrise, sunset] of REFERENCE) {
  test(`${name}の日の出と日の入りの太陽高度`, () => {
    for (const time of [sunrise, sunset]) {
      const elevation = sunElevation(new Date(time), lon, lat);
      // 1 分で太陽高度は最大 0.25° 変わるので、丸めの分だけ許容する
      assert.ok(Math.abs(elevation + 0.83) < 0.3, `${time}: ${elevation.toFixed(3)}°`);
    }
  });
}

test('昼と夜の地点が正しい', () => {
  const noonInTokyo = new Date('2026-11-01T03:00Z');
  assert.ok(sunElevation(noonInTokyo, 139.7, 35.66) > 35);
  assert.ok(sunElevation(noonInTokyo, 2.35, 48.85) < -10); // パリは未明
});

function sunMoonSeparation(iso: string): number {
  const date = new Date(iso);
  return separationDegrees(sublunarPoint(date), subsolarPoint(date));
}

test('日食のとき月は太陽とほぼ同じ方向にある', () => {
  assert.ok(sunMoonSeparation('2026-08-12T17:46Z') < 1.5); // 皆既日食
  assert.ok(sunMoonSeparation('2026-02-17T12:12Z') < 1.5); // 金環日食
});

test('月食のとき月は太陽のほぼ反対側にある', () => {
  assert.ok(sunMoonSeparation('2026-03-03T11:33Z') > 178.5); // 皆既月食
  assert.ok(sunMoonSeparation('2026-08-28T04:13Z') > 178.5); // 部分月食
});

test('星の明るさは 5 等級差で 100 倍になる', () => {
  assert.ok(Math.abs(starIntensity(1) / starIntensity(6) - 100) < 1e-9);
  assert.ok(Math.abs(starIntensity(0) / starIntensity(1) - 2.512) < 0.001);
});

test('シリウス (-1.44 等) はベガ (0.03 等) の約 3.9 倍明るい', () => {
  assert.ok(Math.abs(starIntensity(-1.44) / starIntensity(0.03) - 3.87) < 0.02);
});

test('明るい星同士がごく近くに重ならない', () => {
  // 重なると光が足されてブルームのしきい値を超え、四角くにじむ
  const stars = JSON.parse(readFileSync('src/renderer/data/stars.json', 'utf8')) as number[][];
  const bright = stars.filter((s) => s[2] < 5);
  assert.ok(bright.length > 1000);
  for (let i = 0; i < bright.length; i++) {
    for (let j = i + 1; j < bright.length; j++) {
      const a = { lon: bright[i][0], lat: bright[i][1] };
      const b = { lon: bright[j][0], lat: bright[j][1] };
      assert.ok(separationDegrees(a, b) >= 0.2, `${bright[i]} / ${bright[j]}`);
    }
  }
});

test('星の座標変換は太陽と同じ座標系になる', () => {
  // 春分の太陽は赤経 0°、赤緯 0° にある
  const date = new Date('2026-03-20T14:46Z');
  const lon = ((((0 - siderealDegrees(date) + 180) % 360) + 360) % 360) - 180;
  assert.ok(separationDegrees({ lon, lat: 0 }, subsolarPoint(date)) < 0.02);
});
