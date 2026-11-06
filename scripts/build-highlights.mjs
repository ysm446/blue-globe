// ツアーのハイライト (川をなぞる、山域を示す) 用に、Natural Earth の GeoJSON を小さな JSON に変換する。
// 実行: node scripts/build-highlights.mjs <ne_10m_rivers_lake_centerlines.geojson> <ne_10m_geography_regions_polys.geojson>
// 入力は https://github.com/nvkelso/natural-earth-vector の geojson/ から取る。出力は src/renderer/data/ の 2 つのファイル
import fs from 'node:fs';
import path from 'node:path';

const [riversFile, regionsFile] = process.argv.slice(2);
if (!riversFile || !regionsFile) {
  console.error('usage: node scripts/build-highlights.mjs <rivers.geojson> <regions.geojson>');
  process.exit(1);
}
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src', 'renderer', 'data');

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

const rivers = buildRivers(riversFile);
const regions = buildRegions(regionsFile);
for (const [name, data] of [
  ['rivers-10m.json', rivers],
  ['regions-10m.json', regions],
]) {
  const file = path.join(outDir, name);
  fs.writeFileSync(file, JSON.stringify(data));
  console.log(`${name}: ${data.length} 件、${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
