// ツアーのハイライト。川を源流から河口へなぞる光る線と、山脈・砂漠などの範囲 (半透明の塗りと縁取り) を地球に重ねる。
// データ (highlight-data.ts) は初めて使うときに読み込む。線は WebGL の普通の線だと 1 画素の太さにしかならないので、
// 線分ごとに画面上で幅を持たせた帯として描き、源流からの距離 (0〜1) が uReveal を超えた部分は描かない
import * as THREE from 'three';
import { lonLatToVector3 } from './globe';
import {
  boundsOf,
  findByName,
  regionNames,
  riverNames,
  unwrapLongitudes,
  type Bounds,
  type CountryRecord,
  type RegionRecord,
  type RiverRecord,
} from './highlight-data';

// 地表からの高さ。海岸線 (地域ビューで 1.0007) と同じくらいにし、塗りは線より下に置く
const LINE_RADIUS = 1.0009;
const FILL_RADIUS = 1.0006;
const MAX_SEGMENT_DEG = 0.5; // 長い線分は地表に沿うように分ける
const MAX_TRIANGLE_DEG = 0.6; // 塗りの三角形も地表に沿うように分ける
const RIVER_WIDTH_PX = 5; // 描画の画素 (高 DPI ではそのぶん細く見える)
const OUTLINE_WIDTH_PX = 3.5;
const RIVER_COLOR = new THREE.Color(0.45, 0.85, 1.0).multiplyScalar(1.8); // HDR。白飛びしない程度に光らせる
const AREA_COLOR = new THREE.Color(1.0, 0.72, 0.32);
const AREA_LINE_COLOR = AREA_COLOR.clone().multiplyScalar(1.6);
const AREA_FILL_OPACITY = 0.16;
const RIVER_REVEAL_SECONDS = 4;
const OUTLINE_REVEAL_SECONDS = 1.6;
const FADE_IN_SECONDS = 0.5;
const FADE_OUT_SECONDS = 0.7;
const LABEL_CANDIDATES = 200; // 川のラベルを置く候補の点の数
const LABEL_KEEP_RATIO = 0.6; // 今の点より画面の中心にこれだけ近い点が見つかったときだけ、ラベルを動かす (ちらつかないように)

// label は画面に出す名前。省くと、範囲は日本語名、川は英語名 (データに日本語名がない) を出す
export type HighlightSpec =
  | { type: 'river'; name: string; label?: string }
  | { type: 'area'; name: string; label?: string }
  | { type: 'line'; points: [number, number][]; name?: string; label?: string } // [lat, lon] の並び
  | { type: 'polygon'; points: [number, number][]; name?: string; label?: string };

export interface HighlightInfo {
  name: string;
  nameJa?: string;
  kind: string; // river, line, polygon、または範囲の種類 (Range/mtn, Desert など)
  lengthKm?: number;
  bounds: Bounds;
  countries?: { code: string; name: string; nameJa: string }[]; // 川は源流に近い順、範囲は重なりの大きい順
}

const RIBBON_VS = /* glsl */ `
attribute vec2 corner; // x: 線分の始点 0 / 終点 1、y: 帯の左右 -1 / 1
attribute vec3 aStart;
attribute vec3 aEnd;
attribute vec2 aProgress; // 線分の始点と終点の、源流からの距離 (0〜1)
uniform vec2 uResolution;
uniform float uWidth;
varying float vProgress;
varying float vSide;
void main() {
  vec4 a = projectionMatrix * modelViewMatrix * vec4(aStart, 1.0);
  vec4 b = projectionMatrix * modelViewMatrix * vec4(aEnd, 1.0);
  vec2 dir = (b.xy / b.w - a.xy / a.w) * uResolution;
  dir = length(dir) > 1e-6 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec4 p = mix(a, b, corner.x);
  // 帯の幅と、つなぎ目が欠けないよう線分の両端を半分の幅だけ伸ばす分 (画素から NDC へ)
  vec2 offset = normal * corner.y * uWidth * 0.5 + dir * (corner.x * 2.0 - 1.0) * uWidth * 0.5;
  p.xy += offset / uResolution * 2.0 * p.w;
  gl_Position = p;
  vProgress = mix(aProgress.x, aProgress.y, corner.x);
  vSide = corner.y;
}
`;

const RIBBON_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uReveal;
uniform float uHead; // なぞっている先端を明るくする強さ
varying float vProgress;
varying float vSide;
void main() {
  if (vProgress > uReveal) discard;
  float edge = 1.0 - smoothstep(0.3, 1.0, abs(vSide));
  float head = uHead * exp(-(uReveal - vProgress) * 40.0) * (1.0 - step(0.999, uReveal));
  gl_FragColor = vec4(uColor * (1.0 + head * 2.5), edge * uOpacity);
}
`;

const FILL_VS = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FILL_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
}
`;

// 線の集まり (平らな [lon, lat, ...] と、各点の進み具合 0〜1) から帯の形を作る
function buildRibbon(lines: { coords: number[]; progress: number[] }[]): THREE.InstancedBufferGeometry {
  const starts: number[] = [];
  const ends: number[] = [];
  const progress: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (const { coords, progress: p } of lines) {
    for (let i = 0; i + 3 < coords.length; i += 2) {
      const [lon0, lat0, lon1, lat1] = [coords[i], coords[i + 1], coords[i + 2], coords[i + 3]];
      const p0 = p[i / 2];
      const p1 = p[i / 2 + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(lon1 - lon0, lat1 - lat0) / MAX_SEGMENT_DEG));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps;
        const t1 = (s + 1) / steps;
        lonLatToVector3(lon0 + (lon1 - lon0) * t0, lat0 + (lat1 - lat0) * t0, LINE_RADIUS, a);
        lonLatToVector3(lon0 + (lon1 - lon0) * t1, lat0 + (lat1 - lat0) * t1, LINE_RADIUS, b);
        starts.push(a.x, a.y, a.z);
        ends.push(b.x, b.y, b.z);
        progress.push(p0 + (p1 - p0) * t0, p0 + (p1 - p0) * t1);
      }
    }
  }
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('corner', new THREE.Float32BufferAttribute([0, -1, 1, -1, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute('aStart', new THREE.InstancedBufferAttribute(new Float32Array(starts), 3));
  geometry.setAttribute('aEnd', new THREE.InstancedBufferAttribute(new Float32Array(ends), 3));
  geometry.setAttribute('aProgress', new THREE.InstancedBufferAttribute(new Float32Array(progress), 2));
  geometry.instanceCount = starts.length / 3;
  // 頂点の位置は描画のときに求めるので、視錐台で切り捨てられないよう囲む球を地球全体にする
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1.01);
  return geometry;
}

function ribbonMaterial(color: THREE.Color, width: number, head: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uOpacity: { value: 0 },
      uReveal: { value: 0 },
      uHead: { value: head },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uWidth: { value: width },
    },
    vertexShader: RIBBON_VS,
    fragmentShader: RIBBON_FS,
    transparent: true,
    depthWrite: false,
  });
}

// 線に沿った距離を 0〜1 にする (outline の輪や、座標で渡された線用)
function progressAlong(coords: number[]): number[] {
  const out = [0];
  let total = 0;
  for (let i = 2; i + 1 < coords.length; i += 2) {
    const midLat = ((coords[i + 1] + coords[i - 1]) / 2) * (Math.PI / 180);
    total += Math.hypot((coords[i] - coords[i - 2]) * Math.cos(midLat), coords[i + 1] - coords[i - 1]);
    out.push(total);
  }
  return out.map((d) => (total > 0 ? d / total : 0));
}

// 多角形 (輪の並び。1 つ目が外周) を三角形に分け、地表に沿うように細かくして球に貼る
function buildFill(polygons: number[][][]): THREE.BufferGeometry {
  const positions: number[] = [];
  const v = new THREE.Vector3();
  const push = (lon: number, lat: number): void => {
    lonLatToVector3(lon, lat, FILL_RADIUS, v);
    positions.push(v.x, v.y, v.z);
  };
  const subdivide = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, depth: number): void => {
    const longest = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    if (longest <= MAX_TRIANGLE_DEG || depth > 8) {
      push(a.x, a.y);
      push(b.x, b.y);
      push(c.x, c.y);
      return;
    }
    const ab = a.clone().add(b).multiplyScalar(0.5);
    const bc = b.clone().add(c).multiplyScalar(0.5);
    const ca = c.clone().add(a).multiplyScalar(0.5);
    subdivide(a, ab, ca, depth + 1);
    subdivide(ab, b, bc, depth + 1);
    subdivide(ca, bc, c, depth + 1);
    subdivide(ab, bc, ca, depth + 1);
  };
  for (const rings of polygons) {
    // 外周の最初の点を基準に経度を続け、穴も同じ基準にそろえる
    const reference = rings[0][0];
    const toPoints = (ring: number[]): THREE.Vector2[] => {
      const unwrapped = unwrapLongitudes([reference, ring[1], ...ring], 0).slice(2);
      const points: THREE.Vector2[] = [];
      for (let i = 0; i + 1 < unwrapped.length; i += 2) points.push(new THREE.Vector2(unwrapped[i], unwrapped[i + 1]));
      if (points.length > 1 && points[0].equals(points[points.length - 1])) points.pop(); // 閉じる点は除く
      return points;
    };
    const contour = toPoints(rings[0]);
    const holes = rings.slice(1).map(toPoints);
    const all = [contour, ...holes].flat();
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holes)) subdivide(all[i], all[j], all[k], 0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

// ラベル。画面に入っていて地球の手前にある候補の点のうち、画面の中心に一番近い点に置く。
// 範囲は 1 つ目の点 (重心) が見えていればそこを使う。川は、なぞり終えた所の点だけを使う
interface Label {
  element: HTMLElement;
  points: THREE.Vector3[];
  progress: number[]; // 川の候補の点の、源流からの距離 (0〜1)。範囲は 0
  preferFirst: boolean;
  current: number; // 今置いている候補 (-1 は置いていない)
  transform: string;
}

interface Item {
  group: THREE.Group;
  ribbons: { material: THREE.ShaderMaterial; seconds: number }[];
  fill: THREE.ShaderMaterial | null;
  labels: Label[];
  countryCodes: string[]; // 国名を出している国 (ADM0_A3)
  revealSeconds: number;
  clock: number;
  fade: number;
  leaving: boolean;
}

const easeInOut = (t: number): number => t * t * (3 - 2 * t);

export class Highlights {
  readonly group = new THREE.Group();
  private items: Item[] = [];
  private rivers: Promise<RiverRecord[]> | null = null;
  private regions: Promise<RegionRecord[]> | null = null;
  private countries: Promise<Map<string, CountryRecord>> | null = null;
  private readonly resolution = new THREE.Vector2(1, 1);
  private readonly projected = new THREE.Vector3();
  private readonly toCamera = new THREE.Vector3();

  constructor(private readonly labelContainer: HTMLElement) {}

  private loadRivers(): Promise<RiverRecord[]> {
    this.rivers ??= import('./data/rivers-10m.json').then((mod) => mod.default as unknown as RiverRecord[]);
    return this.rivers;
  }

  private loadCountries(): Promise<Map<string, CountryRecord>> {
    this.countries ??= import('./data/countries-10m.json').then(
      (mod) => new Map((mod.default as unknown as CountryRecord[]).map((country) => [country.a3, country])),
    );
    return this.countries;
  }

  private loadRegions(): Promise<RegionRecord[]> {
    this.regions ??= import('./data/regions-10m.json').then((mod) => mod.default as unknown as RegionRecord[]);
    return this.regions;
  }

  // 1 つの対象を示す。append でなければ、今示しているものは消える。見つからなければ null
  async show(spec: HighlightSpec, append = false): Promise<HighlightInfo | null> {
    const built = await this.build(spec);
    if (!built) return null;
    if (!append) this.clear();
    this.items.push(built.item);
    this.group.add(built.item.group);
    return built.info;
  }

  // 国名を出している国。設定の「国名を表示」の国名と二重にしないために使う
  activeCountries(): Set<string> {
    return new Set(this.items.filter((item) => !item.leaving).flatMap((item) => item.countryCodes));
  }

  // 示しているものをすべて、ふわっと消す
  clear(): void {
    for (const item of this.items) item.leaving = true;
  }

  private async build(spec: HighlightSpec): Promise<{ item: Item; info: HighlightInfo } | null> {
    const item: Item = { group: new THREE.Group(), ribbons: [], fill: null, labels: [], countryCodes: [], revealSeconds: 1, clock: 0, fade: 0, leaving: false };
    const addLabel = (text: string, kind: 'river' | 'area', points: THREE.Vector3[], progress: number[], preferFirst: boolean): void => {
      if (!text || points.length === 0) return;
      const element = document.createElement('span');
      element.className = `highlight-label ${kind}`;
      element.textContent = text;
      element.style.opacity = '0';
      this.labelContainer.append(element);
      item.labels.push({ element, points, progress, preferFirst, current: -1, transform: '' });
    };
    // 通る国、重なる国の名前と国旗。国の中央付近の点に置き、川は光る線がその国に差しかかってから出す
    const countryList = await this.loadCountries();
    const addCountries = (entries: [string, number][]): HighlightInfo['countries'] => {
      const listed: NonNullable<HighlightInfo['countries']> = [];
      for (const [code, first] of entries) {
        const country = countryList.get(code);
        if (!country) continue;
        listed.push({ code, name: country.n, nameJa: country.ja });
        item.countryCodes.push(code);
        const element = document.createElement('span');
        element.className = 'highlight-label country';
        if (country.f) {
          const flag = document.createElement('img');
          flag.src = `./flags/${country.f}.svg`;
          flag.alt = '';
          element.append(flag);
        }
        element.append(country.ja || country.n);
        element.style.opacity = '0';
        this.labelContainer.append(element);
        const point = lonLatToVector3(country.x, country.y, LINE_RADIUS);
        item.labels.push({ element, points: [point], progress: [first], preferFirst: true, current: -1, transform: '' });
      }
      return listed;
    };
    const lineCandidates = (lines: { coords: number[]; progress: number[] }[]): { points: THREE.Vector3[]; progress: number[] } => {
      const total = lines.reduce((sum, line) => sum + line.progress.length, 0);
      const stride = Math.max(1, Math.floor(total / LABEL_CANDIDATES));
      const points: THREE.Vector3[] = [];
      const progress: number[] = [];
      for (const line of lines) {
        for (let i = 0; i < line.progress.length; i += stride) {
          points.push(lonLatToVector3(line.coords[i * 2], line.coords[i * 2 + 1], LINE_RADIUS));
          progress.push(line.progress[i]);
        }
      }
      return { points, progress };
    };
    // 範囲のラベルの候補。1 つ目は一番大きな多角形の外周の点の平均 (おおよその重心)、残りは縁の点
    const areaCandidates = (polygons: number[][][]): THREE.Vector3[] => {
      const outer = polygons.map((rings) => unwrapLongitudes(rings[0])).reduce((a, b) => (b.length > a.length ? b : a));
      let lon = 0;
      let lat = 0;
      for (let i = 0; i + 1 < outer.length; i += 2) {
        lon += outer[i];
        lat += outer[i + 1];
      }
      const count = outer.length / 2;
      const points = [lonLatToVector3(lon / count, lat / count, LINE_RADIUS)];
      const stride = Math.max(1, Math.floor(count / 60));
      for (let i = 0; i < count; i += stride) points.push(lonLatToVector3(outer[i * 2], outer[i * 2 + 1], LINE_RADIUS));
      return points;
    };
    const addRibbon = (lines: { coords: number[]; progress: number[] }[], color: THREE.Color, width: number, seconds: number, head: number): void => {
      const material = ribbonMaterial(color, width, head);
      item.group.add(new THREE.Mesh(buildRibbon(lines), material));
      item.ribbons.push({ material, seconds });
    };
    const addArea = (polygons: number[][][]): void => {
      const fill = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: AREA_COLOR }, uOpacity: { value: 0 } },
        vertexShader: FILL_VS,
        fragmentShader: FILL_FS,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      item.group.add(new THREE.Mesh(buildFill(polygons), fill));
      item.fill = fill;
      const rings = polygons.flat().map((ring) => {
        const coords = unwrapLongitudes(ring);
        return { coords, progress: progressAlong(coords) };
      });
      addRibbon(rings, AREA_LINE_COLOR, OUTLINE_WIDTH_PX, OUTLINE_REVEAL_SECONDS, 0.6);
    };
    const flatOf = (points: [number, number][]): number[] => points.flatMap(([lat, lon]) => [lon, lat]);

    if (spec.type === 'river') {
      const river = findByName(await this.loadRivers(), spec.name, riverNames);
      if (!river) return null;
      const lines = river.l.map((line) => {
        const coords = unwrapLongitudes(line.slice(1));
        // 各点の源流からの距離を、線の始点の距離に線に沿った長さを足して求める
        const along = progressAlong(coords);
        let length = 0;
        for (let i = 2; i + 1 < coords.length; i += 2) {
          const midLat = ((coords[i + 1] + coords[i - 1]) / 2) * (Math.PI / 180);
          length += Math.hypot((coords[i] - coords[i - 2]) * Math.cos(midLat), coords[i + 1] - coords[i - 1]) * 111.2;
        }
        const progress = along.map((t) => Math.min(1, (line[0] + t * length) / Math.max(river.L, 1)));
        return { coords, progress };
      });
      addRibbon(lines, RIVER_COLOR, RIVER_WIDTH_PX, RIVER_REVEAL_SECONDS, 1);
      const candidates = lineCandidates(lines);
      addLabel(spec.label ?? river.n, 'river', candidates.points, candidates.progress, false);
      item.revealSeconds = RIVER_REVEAL_SECONDS;
      const countries = addCountries(river.c);
      return { item, info: { name: river.n, kind: 'river', lengthKm: river.L, bounds: boundsOf(river.l, 1), countries } };
    }
    if (spec.type === 'area') {
      const region = findByName(await this.loadRegions(), spec.name, regionNames);
      if (!region) return null;
      addArea(region.p);
      const points = areaCandidates(region.p);
      addLabel(spec.label ?? (region.ja || region.n), 'area', points, points.map(() => 0), true);
      const countries = addCountries(region.k.map((code) => [code, 0]));
      return { item, info: { name: region.n, nameJa: region.ja, kind: region.c, bounds: boundsOf(region.p.flat()), countries } };
    }
    if (spec.points.length < 2) return null;
    const coords = unwrapLongitudes(flatOf(spec.points));
    const text = spec.label ?? spec.name ?? '';
    if (spec.type === 'line') {
      const line = { coords, progress: progressAlong(coords) };
      addRibbon([line], RIVER_COLOR, RIVER_WIDTH_PX, RIVER_REVEAL_SECONDS, 1);
      const candidates = lineCandidates([line]);
      addLabel(text, 'river', candidates.points, candidates.progress, false);
      item.revealSeconds = RIVER_REVEAL_SECONDS;
    } else {
      const closed = [...coords, coords[0], coords[1]];
      addArea([[closed]]);
      const points = areaCandidates([[closed]]);
      addLabel(text, 'area', points, points.map(() => 0), true);
    }
    return { item, info: { name: spec.name ?? '', kind: spec.type, bounds: boundsOf([coords]) } };
  }

  // 毎フレーム呼ぶ。width と height は描画の画素数
  update(dt: number, width: number, height: number, camera: THREE.Camera, visible: boolean): void {
    this.resolution.set(width, height);
    this.group.visible = visible;
    for (const item of this.items) {
      item.clock += dt;
      item.fade = item.leaving ? Math.max(0, item.fade - dt / FADE_OUT_SECONDS) : Math.min(1, item.fade + dt / FADE_IN_SECONDS);
      const opacity = easeInOut(item.fade);
      for (const { material, seconds } of item.ribbons) {
        const u = material.uniforms;
        u.uReveal.value = easeInOut(Math.min(1, item.clock / seconds)) * 1.0001;
        u.uOpacity.value = opacity;
        u.uResolution.value.copy(this.resolution);
      }
      if (item.fill) item.fill.uniforms.uOpacity.value = opacity * AREA_FILL_OPACITY;
      const reveal = easeInOut(Math.min(1, item.clock / item.revealSeconds));
      for (const label of item.labels) this.placeLabel(label, camera, visible ? opacity : 0, reveal);
    }
    // 消えきったものを片付ける
    for (const item of this.items.filter((i) => i.leaving && i.fade <= 0)) {
      this.group.remove(item.group);
      for (const label of item.labels) label.element.remove();
      item.group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
    }
    this.items = this.items.filter((i) => !(i.leaving && i.fade <= 0));
  }

  private placeLabel(label: Label, camera: THREE.Camera, opacity: number, reveal: number): void {
    const usable = (index: number): number => {
      // 画面の中心からの距離 (NDC)。使えない点は Infinity
      if (label.progress[index] > reveal + 1e-4) return Infinity;
      const point = label.points[index];
      if (point.dot(this.toCamera.copy(camera.position).sub(point)) <= 0) return Infinity; // 地球の裏側
      this.projected.copy(point).project(camera);
      if (this.projected.z >= 1 || Math.abs(this.projected.x) > 0.9 || Math.abs(this.projected.y) > 0.85) return Infinity;
      return Math.hypot(this.projected.x, this.projected.y);
    };
    let chosen = -1;
    if (label.preferFirst && usable(0) < Infinity) chosen = 0;
    else {
      let best = Infinity;
      for (let i = 0; i < label.points.length; i++) {
        const d = usable(i);
        if (d < best) {
          best = d;
          chosen = i;
        }
      }
      const current = label.current >= 0 ? usable(label.current) : Infinity;
      if (current < Infinity && best > current * LABEL_KEEP_RATIO) chosen = label.current;
    }
    label.current = chosen;
    if (chosen >= 0) {
      this.projected.copy(label.points[chosen]).project(camera);
      const x = ((this.projected.x + 1) / 2) * window.innerWidth;
      const y = ((1 - this.projected.y) / 2) * window.innerHeight;
      // 川は線の少し上、範囲は重心に中央そろえで置く
      const lift = label.preferFirst ? '-50%' : '-190%';
      const transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, ${lift})`;
      if (transform !== label.transform) {
        label.transform = transform;
        label.element.style.transform = transform;
      }
    }
    label.element.style.opacity = chosen >= 0 ? opacity.toFixed(3) : '0';
  }
}
