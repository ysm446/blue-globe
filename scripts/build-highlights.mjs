// ツアーのハイライト (川をなぞる、山域を示す) 用に、Natural Earth の GeoJSON を小さな JSON に変換する。
// 実行: node scripts/build-highlights.mjs <ne_10m_rivers_lake_centerlines.geojson> <ne_10m_geography_regions_polys.geojson>
//       <ne_10m_admin_0_countries.geojson> <ne_10m_geography_regions_elevation_points.geojson>
//       <ne_10m_geography_regions_points.geojson> [flag-icons の flags/4x3 フォルダ]
// 入力は https://github.com/nvkelso/natural-earth-vector の geojson/ から取る。出力は src/renderer/data/ の 4 つのファイル。
// 国旗のフォルダ (npm の flag-icons。MIT) を渡すと、使う国の国旗を src/renderer/public/flags/ に写す
import fs from 'node:fs';
import path from 'node:path';

const [riversFile, regionsFile, countriesFile, elevationPointsFile, regionPointsFile, flagsDir] = process.argv.slice(2);
if (!riversFile || !regionsFile || !countriesFile || !elevationPointsFile || !regionPointsFile) {
  console.error(
    'usage: node scripts/build-highlights.mjs <rivers.geojson> <regions.geojson> <countries.geojson> <elevation-points.geojson> <region-points.geojson> [flagsDir]',
  );
  process.exit(1);
}
const repoRoot = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const outDir = path.join(repoRoot, 'src', 'renderer', 'data');

const TOLERANCE_DEG = 0.004; // 点を間引くときの許容のずれ (約 400m)。地域ビューで寄っても形が崩れない程度
const round = (value) => Math.round(value * 1000) / 1000; // 約 100m

// Douglas-Peucker 法で点を間引く。points は [lon, lat] の並び
function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    let farthest = -1;
    let distance = tolerance;
    for (let i = first + 1; i < last; i++) {
      // 閉じた輪では始点と終点が同じで基準の線がないので、始点からの距離で測る
      const d =
        length < 1e-9
          ? Math.hypot(points[i][0] - ax, points[i][1] - ay)
          : Math.abs(dy * (points[i][0] - ax) - dx * (points[i][1] - ay)) / length;
      if (d > distance) {
        distance = d;
        farthest = i;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

// [lon, lat] の並びを、平らな数の配列 [lon, lat, lon, lat, ...] にする
const flatten = (points) => points.flatMap(([lon, lat]) => [round(lon), round(lat)]);

// 2 点間の距離 (km)
function distanceKm([lon0, lat0], [lon1, lat1]) {
  const rad = Math.PI / 180;
  const x = (lon1 - lon0) * rad * Math.cos(((lat0 + lat1) / 2) * rad);
  const y = (lat1 - lat0) * rad;
  return Math.hypot(x, y) * 6371;
}

// 河口の判定に使う海岸線。同梱の 50m の海岸線の点を 1 度ごとの区画に分けておき、近くの区画だけ調べる
const SNAP_DEG = 0.03; // 川の線の端点をつなぐ距離 (約 3km)
const MOUTH_NEAR_KM = 40;
const MOUTH_FAR_KM = 150;
const coastGrid = new Map();
for (const feature of JSON.parse(fs.readFileSync(path.join(outDir, 'coastline-50m.json'), 'utf8')).features) {
  const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  for (const line of lines) {
    for (const point of line) {
      const key = `${Math.floor(point[0])},${Math.floor(point[1])}`;
      if (!coastGrid.has(key)) coastGrid.set(key, []);
      coastGrid.get(key).push(point);
    }
  }
}
function coastDistanceKm(point) {
  let best = Infinity;
  const cx = Math.floor(point[0]);
  const cy = Math.floor(point[1]);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (const coast of coastGrid.get(`${cx + dx},${cy + dy}`) ?? []) best = Math.min(best, distanceKm(point, coast));
    }
  }
  return best; // 2 度より遠いときは Infinity
}

function lineLength(line) {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += distanceKm(line[i - 1], line[i]);
  return total;
}

// 線の向きを源流から河口へそろえ、各線の始点の「源流からの距離」(km) を求める。
// Natural Earth の川は線の向きがまちまちなので、端点でつないだ網の中で最も長い道筋を本流とみなし、
// 本流の上で多くの線 (長さで重み付け) の向きと合う側を源流にする。本流から離れた支流や、つながっていない線も、
// 近い点の距離を引き継いで、本流と同じように源流側から伸びるようにする
function orientRiver(lines) {
  // 端点は、つながっている所でもわずかにずれていることがあるので、近いものを同じ点にする
  const nodes = [];
  const nodeOf = (point) => {
    let node = nodes.find((n) => Math.abs(n.point[0] - point[0]) < SNAP_DEG && Math.abs(n.point[1] - point[1]) < SNAP_DEG);
    if (!node) nodes.push((node = { point, edges: [] }));
    return node;
  };
  const edges = lines.map((line, index) => {
    const edge = { index, line, length: lineLength(line), a: nodeOf(line[0]), b: nodeOf(line[line.length - 1]) };
    edge.a.edges.push(edge);
    edge.b.edges.push(edge);
    return edge;
  });

  // 端点の網の上の最短距離 (Dijkstra。点の数が少ないので単純な選び方で足りる)
  const shortest = (start) => {
    const dist = new Map([[start, 0]]);
    const via = new Map();
    const done = new Set();
    for (;;) {
      let node = null;
      for (const [candidate, d] of dist) if (!done.has(candidate) && (node === null || d < dist.get(node))) node = candidate;
      if (node === null) return { dist, via };
      done.add(node);
      for (const edge of node.edges) {
        const other = edge.a === node ? edge.b : edge.a;
        const d = dist.get(node) + edge.length;
        if (!dist.has(other) || d < dist.get(other)) {
          dist.set(other, d);
          via.set(other, edge);
        }
      }
    }
  };
  const farthest = (dist) => [...dist].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];

  // 一番大きなつながりの、最も離れた 2 点を本流の両端とする
  const longest = edges.reduce((best, edge) => (edge.length > best.length ? edge : best));
  let end0 = farthest(shortest(longest.a).dist);
  const fromEnd0 = shortest(end0);
  let end1 = farthest(fromEnd0.dist);
  // 本流の上の線が end0 → end1 の向きに描かれている長さと、逆向きの長さを比べる
  let along = 0;
  let against = 0;
  for (let node = end1; node !== end0; ) {
    const edge = fromEnd0.via.get(node);
    const previous = edge.a === node ? edge.b : edge.a;
    if (edge.b === node) along += edge.length;
    else against += edge.length;
    node = previous;
  }
  // 片方の端だけが海岸 (カスピ海などの湖岸を含む) に近ければ、そちらを河口とする。アマゾン川のように本流の線が
  // 河口から上流へ描かれている川があるので、線の向きより優先する。どちらとも言えないとき (別の川に合流する支流など) は線の向きで決める
  const coast0 = coastDistanceKm(end0.point);
  const coast1 = coastDistanceKm(end1.point);
  if (Math.min(coast0, coast1) < MOUTH_NEAR_KM && Math.max(coast0, coast1) > MOUTH_FAR_KM) {
    if (coast0 < coast1) [end0, end1] = [end1, end0];
  } else if (against > along) [end0, end1] = [end1, end0];
  const { dist } = shortest(end0);
  const total = Math.max(...dist.values());

  // つながっていない線は、一番近いつながった点の距離から始める
  const connected = [...dist.keys()];
  const nearestDistance = (point) => {
    let best = connected[0];
    for (const node of connected) if (distanceKm(node.point, point) < distanceKm(best.point, point)) best = node;
    return dist.get(best);
  };
  return {
    total,
    lines: edges.map((edge) => {
      const da = dist.has(edge.a) ? dist.get(edge.a) : nearestDistance(edge.a.point);
      const db = dist.has(edge.b) ? dist.get(edge.b) : nearestDistance(edge.b.point);
      return da <= db ? { offset: da, line: edge.line } : { offset: db, line: [...edge.line].reverse() };
    }),
  };
}

// 川。name_en が同じものを 1 つにまとめる (ドナウ川は Danube と Donau に分かれている)。湖の中を通る中心線も含める。
// l は線ごとの [始点の源流からの距離 (km), lon, lat, lon, lat, ...]、L は源流から河口までの長さ (km)
function buildRivers(file) {
  const features = JSON.parse(fs.readFileSync(file, 'utf8')).features;
  const byName = new Map();
  for (const feature of features) {
    const p = feature.properties;
    const name = (p.name_en || p.name || '').trim();
    if (!name || !feature.geometry) continue;
    const entry = byName.get(name) ?? { n: name, a: new Set(), r: p.scalerank, l: [] };
    for (const alias of [p.name, p.name_alt]) if (alias && alias !== name) entry.a.add(alias.trim());
    entry.r = Math.min(entry.r, p.scalerank);
    const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const line of lines) {
      const simplified = simplify(line, TOLERANCE_DEG);
      if (simplified.length >= 2) entry.l.push(simplified);
    }
    byName.set(name, entry);
  }
  return [...byName.values()]
    .filter((entry) => entry.l.length > 0)
    .map((entry) => {
      const oriented = orientRiver(entry.l);
      return {
        n: entry.n,
        a: [...entry.a],
        r: entry.r,
        L: Math.round(oriented.total),
        l: oriented.lines.map(({ offset, line }) => [Math.round(offset), ...flatten(line)]),
      };
    })
    .sort((a, b) => a.r - b.r);
}

// 山脈、砂漠、高原などの範囲。日本語名を持つ。架空の地名 (Dragons-be-here) は除く
function buildRegions(file) {
  const features = JSON.parse(fs.readFileSync(file, 'utf8')).features;
  const regions = [];
  for (const feature of features) {
    const p = feature.properties;
    if (!feature.geometry || p.FEATURECLA === 'Dragons-be-here') continue;
    const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const p2 = polygons
      .map((rings) => rings.map((ring) => flatten(simplify(ring, TOLERANCE_DEG))).filter((ring) => ring.length >= 8))
      .filter((rings) => rings.length > 0);
    if (p2.length === 0) continue;
    // 英語名は大文字のものがあるので、NAME_EN を優先する
    regions.push({ n: (p.NAME_EN || p.NAME).trim(), ja: (p.NAME_JA || '').trim(), c: p.FEATURECLA, r: p.SCALERANK, p: p2 });
  }
  return regions.sort((a, b) => a.r - b.r);
}

// 国。判定には点を間引いた範囲を使う (10m のままでは遅い)。日本語名は、日本の地図で一般的な呼び方に一部直す
const COUNTRY_TOLERANCE_DEG = 0.005;
const RIVER_SAMPLE_KM = 5; // 川の上で国を調べる間隔
const RIVER_MIN_KM = 1; // 通った長さがこれより短い国は、国境の線との誤差として除く
const REGION_MIN_SHARE = 0.03; // 範囲の中で占める割合がこれより小さい国は除く
const JA_OVERRIDES = {
  TWN: '台湾',
  KOS: 'コソボ',
  CHN: '中国',
  PRK: '北朝鮮',
  KOR: '韓国',
  USA: 'アメリカ',
  THA: 'タイ',
  MLI: 'マリ',
  ZAF: '南アフリカ',
  CAF: '中央アフリカ',
  CYN: '北キプロス',
};

function loadCountries(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).features.map((feature) => {
    const p = feature.properties;
    const polygons = (feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates).map(
      (rings) => rings.map((ring) => simplify(ring, COUNTRY_TOLERANCE_DEG)),
    );
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const rings of polygons) {
      for (const [lon, lat] of rings[0]) {
        bbox[0] = Math.min(bbox[0], lon);
        bbox[1] = Math.min(bbox[1], lat);
        bbox[2] = Math.max(bbox[2], lon);
        bbox[3] = Math.max(bbox[3], lat);
      }
    }
    const iso2 = p.ISO_A2_EH && p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH.toLowerCase() : '';
    return {
      a3: p.ADM0_A3,
      n: (p.NAME_EN || p.NAME).trim(),
      ja: JA_OVERRIDES[p.ADM0_A3] ?? (p.NAME_JA || '').trim(),
      f: iso2,
      x: round(p.LABEL_X),
      y: round(p.LABEL_Y),
      r: p.LABELRANK,
      polygons,
      bbox,
    };
  });
}

function insideRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function insideCountry(lon, lat, country) {
  const [w, s, e, n] = country.bbox;
  if (lon < w || lon > e || lat < s || lat > n) return false;
  return country.polygons.some((rings) => insideRing(lon, lat, rings[0]) && !rings.slice(1).some((hole) => insideRing(lon, lat, hole)));
}

const countries = loadCountries(countriesFile);
let lastCountry = null;
function countryAt(lon, lat) {
  // 続けて調べる点はたいてい同じ国にあるので、直前の国を先に調べる
  if (lastCountry && insideCountry(lon, lat, lastCountry)) return lastCountry;
  lastCountry = countries.find((country) => country !== lastCountry && insideCountry(lon, lat, country)) ?? null;
  return lastCountry;
}

// 川が通る国を、源流に近い順に並べる。値は [国 (ADM0_A3), その国に初めて入る所の源流からの距離 (0〜1)]
function riverCountries(river) {
  const found = new Map(); // a3 → { first, km }
  for (const line of river.l) {
    let along = line[0];
    for (let i = 3; i + 1 < line.length; i += 2) {
      const a = [line[i - 2], line[i - 1]];
      const b = [line[i], line[i + 1]];
      const segment = distanceKm(a, b);
      const steps = Math.max(1, Math.ceil(segment / RIVER_SAMPLE_KM));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const country = countryAt(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
        if (!country) continue;
        const entry = found.get(country.a3) ?? { first: Infinity, km: 0 };
        entry.first = Math.min(entry.first, (along + segment * t) / Math.max(river.L, 1));
        entry.km += segment / steps;
        found.set(country.a3, entry);
      }
      along += segment;
    }
  }
  return [...found]
    .filter(([, entry]) => entry.km >= RIVER_MIN_KM)
    .sort((x, y) => x[1].first - y[1].first)
    .map(([a3, entry]) => [a3, Math.round(Math.min(1, entry.first) * 1000) / 1000]);
}

// 範囲に重なる国を、重なりの大きい順に並べる。範囲の中に格子状に点を打って数える
function regionCountries(region) {
  const counts = new Map();
  let total = 0;
  for (const rings of region.p) {
    const toPoints = (ring) => {
      const points = [];
      for (let i = 0; i + 1 < ring.length; i += 2) points.push([ring[i], ring[i + 1]]);
      return points;
    };
    const outer = toPoints(rings[0]);
    const holes = rings.slice(1).map(toPoints);
    const lons = outer.map((p) => p[0]);
    const lats = outer.map((p) => p[1]);
    const [w, e, s, n] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
    if (e - w > 180) continue; // 日付変更線をまたぐ範囲は数えない (まれ)
    const step = Math.max(0.05, Math.sqrt((e - w) * (n - s)) / 40);
    for (let lat = s + step / 2; lat < n; lat += step) {
      for (let lon = w + step / 2; lon < e; lon += step) {
        if (!insideRing(lon, lat, outer) || holes.some((hole) => insideRing(lon, lat, hole))) continue;
        total++;
        const country = countryAt(lon, lat);
        if (country) counts.set(country.a3, (counts.get(country.a3) ?? 0) + 1);
      }
    }
  }
  return [...counts]
    .filter(([, count]) => count / Math.max(total, 1) >= REGION_MIN_SHARE)
    .sort((x, y) => y[1] - x[1])
    .map(([a3]) => a3);
}

const rivers = buildRivers(riversFile).map((river) => ({ ...river, c: riverCountries(river) }));
const regions = buildRegions(regionsFile).map((region) => ({ ...region, k: regionCountries(region) }));
const countryTable = countries.map(({ a3, n, ja, f, x, y, r }) => ({ a3, n, ja, f, x, y, r }));

// 点。山頂など (標高点) と、滝・岬・島などの代表点。e は標高 (m。ないときは null)、k はその点がある国 (海の上なら空)
function buildPoints(files) {
  const points = [];
  for (const file of files) {
    for (const feature of JSON.parse(fs.readFileSync(file, 'utf8')).features) {
      const p = feature.properties;
      const [lon, lat] = feature.geometry.coordinates;
      const name = (p.name_en || p.name || '').trim();
      if (!name) continue;
      const country = countryAt(lon, lat);
      const alias = (p.name || '').trim();
      points.push({
        n: name,
        a: alias && alias !== name ? [alias] : [], // 別名 (英語名の欄と名前の欄が違うもの。Iguaçu Falls と Iguazu Falls など)
        ja: (p.name_ja || '').trim(),
        c: p.featurecla,
        e: typeof p.elevation === 'number' && p.elevation !== 0 ? p.elevation : null,
        x: round(lon),
        y: round(lat),
        r: p.scalerank,
        k: country ? [country.a3] : [],
      });
    }
  }
  return points.sort((a, b) => a.r - b.r);
}
const points = buildPoints([elevationPointsFile, regionPointsFile]);

// 使う国の国旗を写す。flag-icons にない国 (国コードのない地域など) は国旗を出さない
if (flagsDir) {
  const target = path.join(repoRoot, 'src', 'renderer', 'public', 'flags');
  fs.mkdirSync(target, { recursive: true });
  let copied = 0;
  for (const country of countryTable) {
    const source = path.join(flagsDir, `${country.f}.svg`);
    if (!country.f || !fs.existsSync(source)) {
      country.f = '';
      continue;
    }
    fs.copyFileSync(source, path.join(target, `${country.f}.svg`));
    copied++;
  }
  console.log(`国旗: ${copied} 枚`);
}

for (const [name, data] of [
  ['rivers-10m.json', rivers],
  ['regions-10m.json', regions],
  ['countries-10m.json', countryTable],
  ['points-10m.json', points],
]) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(`${name}: ${data.length} 件、${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
