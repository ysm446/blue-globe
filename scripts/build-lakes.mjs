// 地形の名前のラベルに出す湖を、Natural Earth の湖 (ne_10m_lakes.geojson) から小さな JSON に変換する。
// 実行: node scripts/build-lakes.mjs <ne_10m_lakes.geojson>
// 入力は https://github.com/nvkelso/natural-earth-vector の geojson/ から取る。出力は src/renderer/data/lakes-10m.json。
// 日本語名は元データの name_ja (Wikidata 由来) を使う。音写や湾・海峡・ダムの名前が混ざっているので、
// 「湖・海・池・沼・潟」で終わるものだけを残す。元データで「湖」が抜けているだけの主な湖は NAME_OVERRIDES で補う
import fs from 'node:fs';
import path from 'node:path';
import { labelPoint } from '../src/renderer/label-point.ts';

const [lakesFile] = process.argv.slice(2);
if (!lakesFile) {
  console.error('usage: node scripts/build-lakes.mjs <ne_10m_lakes.geojson>');
  process.exit(1);
}
const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const outFile = path.join(repoRoot, 'src', 'renderer', 'data', 'lakes-10m.json');

// 元データの英語名 (name) → 日本語名。アプリで補った名前
const NAME_OVERRIDES = {
  'Tonlé Sap': 'トンレサップ湖',
  'Issyk-Kul': 'イシク・クル湖',
};
const JA_SUFFIX = /(湖|海|池|沼|潟)$/;

const round = (value) => Math.round(value * 1000) / 1000;

// 輪の面積 (km²)。経度を緯度で縮めた平面で求める
function ringAreaKm2(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const k = Math.cos((((ring[i][1] + ring[j][1]) / 2) * Math.PI) / 180);
    sum += (ring[j][0] - ring[i][0]) * k * (ring[j][1] + ring[i][1]);
  }
  return (Math.abs(sum) / 2) * 111.2 * 111.2;
}

const geo = JSON.parse(fs.readFileSync(lakesFile, 'utf8'));
const byName = new Map();
for (const feature of geo.features) {
  const p = feature.properties;
  const ja = (NAME_OVERRIDES[p.name] ?? (p.name_ja || '')).trim();
  if (!ja || !JA_SUFFIX.test(ja)) continue;
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const area = polygons.reduce((sum, rings) => sum + ringAreaKm2(rings[0]), 0);
  const flat = polygons.map((rings) => rings.map((ring) => ring.flat()));
  const { lon, lat } = labelPoint(flat);
  const record = { n: (p.name_en || p.name || '').trim(), ja, r: p.scalerank, x: round(lon), y: round(lat), a: Math.round(area) };
  // 同じ日本語名 (死海の北と南など) は、一番大きいものを残す
  const existing = byName.get(ja);
  if (!existing || record.a > existing.a) byName.set(ja, { ...record, r: Math.min(record.r, existing?.r ?? record.r) });
}
const lakes = [...byName.values()].sort((a, b) => a.r - b.r || b.a - a.a);
fs.writeFileSync(outFile, JSON.stringify(lakes));
console.log(`wrote ${lakes.length} lakes to ${path.relative(repoRoot, outFile)}`);
