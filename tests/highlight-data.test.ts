// ハイライトのデータの検索と範囲の計算の検証。実行: node --test tests/highlight-data.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  boundsOf,
  findByName,
  normalizeName,
  regionNames,
  riverNames,
  unwrapLongitudes,
  type RegionRecord,
  type RiverRecord,
} from '../src/renderer/highlight-data.ts';

const rivers = JSON.parse(fs.readFileSync('src/renderer/data/rivers-10m.json', 'utf8')) as RiverRecord[];
const regions = JSON.parse(fs.readFileSync('src/renderer/data/regions-10m.json', 'utf8')) as RegionRecord[];

test('名前のそろえ方は大文字小文字とアクセント記号を無視する', () => {
  assert.equal(normalizeName('  São   Francisco '), 'sao francisco');
});

test('川を英語名、別名、付け足し付きの名前で探せる', () => {
  assert.equal(findByName(rivers, 'Danube', riverNames)?.n, 'Danube');
  assert.equal(findByName(rivers, 'donau', riverNames)?.n, 'Danube'); // 別名
  assert.equal(findByName(rivers, 'Danube River', riverNames)?.n, 'Danube');
  assert.equal(findByName(rivers, 'Amazon', riverNames)?.n, 'Amazonas');
  assert.equal(findByName(rivers, 'Mississippi', riverNames)?.n, 'Mississippi');
  assert.equal(findByName(rivers, 'no such river', riverNames), null);
});

test('山脈や砂漠を英語名と日本語名で探せる', () => {
  assert.equal(findByName(regions, 'Alps', regionNames)?.ja, 'アルプス山脈');
  assert.equal(findByName(regions, 'アルプス山脈', regionNames)?.n, 'Alps');
  assert.equal(findByName(regions, 'ヒマラヤ山脈', regionNames)?.c, 'Range/mtn');
  assert.equal(findByName(regions, 'サハラ砂漠', regionNames)?.c, 'Desert');
  assert.equal(findByName(regions, 'Sahara', regionNames)?.c, 'Desert');
});

test('川の線は源流から河口へ向いている', () => {
  const sourceOf = (name: string): [number, number] => {
    const river = findByName(rivers, name, riverNames)!;
    const first = river.l.reduce((best, line) => (line[0] < best[0] ? line : best));
    return [first[1], first[2]];
  };
  // 源流の経度で確かめる。ドナウ川は西のシュヴァルツヴァルト、アマゾン川は西のペルー側、ミシシッピ川は北
  assert.ok(sourceOf('Danube')[0] < 10);
  assert.ok(sourceOf('Amazonas')[0] < -70);
  assert.ok(sourceOf('Mississippi')[1] > 45);
});

test('ドナウ川が通る国は源流から順に並ぶ', () => {
  const danube = findByName(rivers, 'Danube', riverNames)!;
  const order = danube.c.map(([code]) => code);
  // 国境になっている区間は両岸の国が入る。モルドバは接する区間が短く (1km 未満)、除かれる
  assert.deepEqual(order, ['DEU', 'AUT', 'SVK', 'HUN', 'HRV', 'SRB', 'ROU', 'BGR', 'UKR']);
  const firsts = danube.c.map(([, first]) => first);
  assert.deepEqual(firsts, [...firsts].sort((a, b) => a - b));
});

test('アルプス山脈に重なる国', () => {
  const alps = findByName(regions, 'Alps', regionNames)!;
  assert.deepEqual([...alps.k].sort(), ['AUT', 'CHE', 'DEU', 'FRA', 'ITA']);
});

test('範囲は日付変更線をまたいでも狭い側を返す', () => {
  const b = boundsOf([[170, 10, 179, 12, -175, 11]]);
  assert.equal(b.west, 170);
  assert.equal(b.east, -175);
  assert.equal(b.south, 10);
  assert.equal(b.north, 12);
  const alps = findByName(regions, 'Alps', regionNames)!;
  const ab = boundsOf(alps.p.flat());
  assert.ok(ab.west > 4 && ab.east < 17 && ab.south > 43 && ab.north < 49, JSON.stringify(ab));
});

test('経度は前の点から 180 度より離れないように続ける', () => {
  assert.deepEqual(unwrapLongitudes([179, 0, -179, 1, -178, 2]), [179, 0, 181, 1, 182, 2]);
});
