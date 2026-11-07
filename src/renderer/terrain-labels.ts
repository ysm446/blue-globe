// 地球儀の上に出す地形の名前 (山脈、砂漠、高原、平野、盆地など)、川、湖と山の頂。設定の「地形の名前を表示」で出す。
// データはツアーのハイライトと同じ Natural Earth (highlight-data.ts)。引いているときは大きな地形だけ、寄るほど小さな地形まで出す。
// 川は日本語名の対応表 (data/river-names-ja.json。アプリで追加した名前) にあるものだけを出し、名前は線の上で画面の中心に近い所に置く。
// 湖は Natural Earth の日本語名 (scripts/build-lakes.mjs で絞ったもの) を、湖の内側の奥まった点に置く。
// 山の頂は寄ったときだけ、印と標高を付けて出す。都市名、国名、地点のマーカーには重ねない
import * as THREE from 'three';
import type { WorldToScreen } from './city-labels';
import { lonLatToVector3 } from './globe';
import { unwrapLongitudes, type PointRecord, type RegionRecord, type RiverRecord } from './highlight-data';
import { placeLabels, type LabelBox } from './label-layout';
import { labelPoint } from './label-point';

// 出す範囲の種類と、色分けの組。島、半島、海岸などは数が多く混むので出さない
const REGION_GROUPS: Record<string, 'desert' | 'mountain' | 'plateau' | 'lowland' | 'cold'> = {
  Desert: 'desert',
  'Range/mtn': 'mountain',
  Foothills: 'mountain',
  Gorge: 'mountain',
  Valley: 'mountain',
  Plateau: 'plateau',
  Plain: 'lowland',
  Basin: 'lowland',
  Lowland: 'lowland',
  Delta: 'lowland',
  Wetlands: 'lowland',
  Depression: 'lowland',
  Tundra: 'cold',
};

// カメラの高さ (レンズの分を換算、地球の半径が 1) ごとの、出す地形の重要度 (scalerank) の上限。上から順に、この高さ以上なら
const REGION_RANK_BY_ALTITUDE: [number, number][] = [
  [1.4, 1],
  [0.7, 2],
  [0.35, 3],
  [0.18, 4],
  [0.09, 5],
  [0, 6],
];
// 川と湖。上と同じく、カメラの高さごとの重要度 (scalerank) の上限
const RIVER_RANK_BY_ALTITUDE: [number, number][] = [
  [1.4, 2],
  [0.7, 3],
  [0.35, 5],
  [0.18, 6],
  [0.09, 8],
  [0, 10],
];
const LAKE_RANK_BY_ALTITUDE: [number, number][] = [
  [1.4, 1],
  [0.7, 3],
  [0.35, 5],
  [0.18, 7],
  [0.09, 8],
  [0, 9],
];
const RIVER_CANDIDATES = 80; // 川の名前を置く候補の点の数 (同じ名前の線をまとめて)
const RIVER_KEEP_RATIO = 0.6; // 今の点より画面の中心にこれだけ近い点が見つかったときだけ、名前を動かす (ちらつかないように)
const SCREEN_MARGIN_X = 0.06; // 川の名前を置く点は、画面の端からこの割合より内側にする
const SCREEN_MARGIN_Y = 0.1;

interface LakeRecord {
  n: string;
  ja: string;
  r: number;
  x: number;
  y: number;
  a: number; // 面積 (km²。おおよそ)
}

// 山の頂。-1 は出さない
const PEAK_RANK_BY_ALTITUDE: [number, number][] = [
  [0.35, -1],
  [0.18, 3],
  [0.09, 5],
  [0.04, 7],
  [0, 9],
];
const PEAK_MARK_HALF = 5; // 山の頂の印 (▲) の幅の半分 (px)。印の中心を頂の位置に合わせる

type TerrainKind = 'region' | 'peak' | 'river' | 'lake';

interface TerrainLabel {
  rank: number;
  kind: TerrainKind;
  peak: boolean;
  candidates: THREE.Vector3[] | null; // 川の名前を置く候補の点。範囲、湖、山の頂は null
  current: number; // 川の名前を今置いている候補 (-1 は置いていない)
  element: HTMLElement;
  world: THREE.Vector3;
  width: number; // 文字の幅は変わらないので、最初に測って使い回す
  height: number;
  box: LabelBox | null;
  transform: string;
  shown: boolean;
}

function rankAt(table: [number, number][], altitude: number): number {
  return (table.find(([min]) => altitude >= min) ?? table[table.length - 1])[1];
}

export class TerrainLabels {
  private labels: TerrainLabel[] = [];
  private loading: Promise<void> | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly radius: number,
  ) {
    container.hidden = true;
  }

  // 初めて出すときにデータを読み込む
  setVisible(visible: boolean): void {
    this.container.hidden = !visible;
    if (visible) this.loading ??= this.load();
  }

  private async load(): Promise<void> {
    const [regionModule, pointModule, riverModule, riverNameModule, lakeModule] = await Promise.all([
      import('./data/regions-10m.json'),
      import('./data/points-10m.json'),
      import('./data/rivers-10m.json'),
      import('./data/river-names-ja.json'),
      import('./data/lakes-10m.json'),
    ]);
    const regions = (regionModule.default as unknown as RegionRecord[]).filter((region) => REGION_GROUPS[region.c]);
    const peaks = (pointModule.default as unknown as PointRecord[]).filter((point) => point.c === 'mountain');
    const labels: TerrainLabel[] = [];
    for (const region of regions) {
      const element = document.createElement('span');
      element.className = `terrain-label ${REGION_GROUPS[region.c]} rank-${Math.min(region.r, 4)} off`;
      element.textContent = region.ja || region.n;
      const { lon, lat } = labelPoint(region.p);
      labels.push(this.makeLabel(element, lon, lat, region.r, 'region'));
    }
    // 川。区間ごとに英語名が分かれている川 (Rhine と Rhein など) は、同じ日本語名で 1 つにまとめる
    const riverNames = riverNameModule.default as unknown as Record<string, string>;
    const riverGroups = new Map<string, { rank: number; lines: number[][] }>();
    for (const river of riverModule.default as unknown as RiverRecord[]) {
      const ja = riverNames[river.n];
      if (!ja) continue;
      const group = riverGroups.get(ja) ?? { rank: river.r, lines: [] };
      group.rank = Math.min(group.rank, river.r);
      for (const line of river.l) group.lines.push(unwrapLongitudes(line.slice(1)));
      riverGroups.set(ja, group);
    }
    for (const [ja, group] of riverGroups) {
      const total = group.lines.reduce((sum, line) => sum + line.length / 2, 0);
      const stride = Math.max(1, Math.floor(total / RIVER_CANDIDATES));
      const candidates: THREE.Vector3[] = [];
      for (const line of group.lines) {
        for (let i = 0; i + 1 < line.length; i += stride * 2) candidates.push(lonLatToVector3(line[i], line[i + 1], this.radius));
      }
      if (candidates.length === 0) continue;
      const element = document.createElement('span');
      element.className = 'terrain-label river off';
      element.textContent = ja;
      const label = this.makeLabel(element, 0, 0, group.rank, 'river');
      label.candidates = candidates;
      labels.push(label);
    }
    for (const lake of lakeModule.default as unknown as LakeRecord[]) {
      const element = document.createElement('span');
      element.className = `terrain-label lake ${lake.r <= 1 ? 'rank-2' : lake.r <= 4 ? 'rank-3' : ''} off`;
      element.textContent = lake.ja;
      labels.push(this.makeLabel(element, lake.x, lake.y, lake.r, 'lake'));
    }
    for (const peak of peaks) {
      const element = document.createElement('span');
      element.className = 'terrain-label peak off';
      const mark = document.createElement('span');
      mark.className = 'peak-mark';
      mark.textContent = '▲';
      element.append(mark, peak.ja || peak.n);
      if (peak.e) {
        const elevation = document.createElement('span');
        elevation.className = 'peak-elevation';
        elevation.textContent = `${peak.e.toLocaleString('ja-JP')}m`;
        element.append(elevation);
      }
      labels.push(this.makeLabel(element, peak.x, peak.y, peak.r, 'peak'));
    }
    // 重要な地形を先に置く。同じ重要度なら範囲を山の頂より先に
    labels.sort((a, b) => a.rank - b.rank || Number(a.peak) - Number(b.peak));
    this.container.append(...labels.map((label) => label.element));
    this.labels = labels;
  }

  private makeLabel(element: HTMLElement, lon: number, lat: number, rank: number, kind: TerrainKind): TerrainLabel {
    return {
      rank,
      kind,
      peak: kind === 'peak',
      candidates: null,
      current: -1,
      element,
      world: lonLatToVector3(lon, lat, this.radius),
      width: 0,
      height: 0,
      box: null,
      transform: '',
      shown: false,
    };
  }

  // 川の名前を置く点。画面に入っている候補のうち、画面の中心に一番近い点。ちらつかないよう、今の点がまだ使えて、
  // はっきり中心に近い点がなければ動かさない
  private riverPoint(label: TerrainLabel, toScreen: WorldToScreen): { x: number; y: number } | null {
    const candidates = label.candidates!;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const usable = (index: number): { x: number; y: number; distance: number } | null => {
      const point = toScreen(candidates[index]);
      if (!point) return null;
      if (point.x < width * SCREEN_MARGIN_X || point.x > width * (1 - SCREEN_MARGIN_X)) return null;
      if (point.y < height * SCREEN_MARGIN_Y || point.y > height * (1 - SCREEN_MARGIN_Y)) return null;
      return { x: point.x, y: point.y, distance: Math.hypot(point.x - width / 2, point.y - height / 2) };
    };
    let best: { x: number; y: number; distance: number } | null = null;
    let chosen = -1;
    for (let index = 0; index < candidates.length; index++) {
      const point = usable(index);
      if (point && (!best || point.distance < best.distance)) {
        best = point;
        chosen = index;
      }
    }
    const current = label.current >= 0 && label.current !== chosen ? usable(label.current) : null;
    if (current && (!best || best.distance > current.distance * RIVER_KEEP_RATIO)) return current;
    label.current = chosen;
    return best;
  }

  shownBoxes(): LabelBox[] {
    if (this.container.hidden) return [];
    return this.labels.filter((label) => label.shown && label.box).map((label) => label.box as LabelBox);
  }

  // 毎フレーム呼ぶ。blocked は重ねない範囲 (都市のラベル、国名など)、altitude はレンズの分を換算したカメラの高さ
  update(toScreen: WorldToScreen, blocked: LabelBox[], altitude: number): void {
    if (this.container.hidden || this.labels.length === 0) return;
    const maxRank: Record<TerrainKind, number> = {
      region: rankAt(REGION_RANK_BY_ALTITUDE, altitude),
      peak: rankAt(PEAK_RANK_BY_ALTITUDE, altitude),
      river: rankAt(RIVER_RANK_BY_ALTITUDE, altitude),
      lake: rankAt(LAKE_RANK_BY_ALTITUDE, altitude),
    };
    const boxes = this.labels.map((label): LabelBox | null => {
      if (label.rank > maxRank[label.kind]) {
        label.current = -1;
        return null;
      }
      const point = label.candidates ? this.riverPoint(label, toScreen) : toScreen(label.world);
      if (!point) return null;
      if (label.width === 0) {
        label.width = label.element.offsetWidth;
        label.height = label.element.offsetHeight;
      }
      // 範囲の名前は点を中心に、山の頂は印の中心を頂に合わせる
      const x = label.peak ? point.x - PEAK_MARK_HALF : point.x - label.width / 2;
      return { x, y: point.y - label.height / 2, width: label.width, height: label.height };
    });
    const shown = placeLabels(boxes, blocked);
    this.labels.forEach((label, index) => {
      const box = boxes[index];
      label.box = box;
      if (box) {
        const transform = `translate(${box.x.toFixed(1)}px, ${box.y.toFixed(1)}px)`;
        if (transform !== label.transform) {
          label.transform = transform;
          label.element.style.transform = transform;
        }
      }
      if (shown[index] !== label.shown) {
        label.shown = shown[index];
        label.element.classList.toggle('off', !label.shown);
      }
    });
  }
}
