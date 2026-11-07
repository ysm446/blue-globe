// 地球儀の上に出す地形の名前 (山脈、砂漠、高原、平野、盆地など) と山の頂。設定の「地形の名前を表示」で出す。
// データはツアーのハイライトと同じ Natural Earth (highlight-data.ts)。引いているときは大きな地形だけ、寄るほど小さな地形まで出す。
// 山の頂は寄ったときだけ、印と標高を付けて出す。都市名、国名、地点のマーカーには重ねない
import * as THREE from 'three';
import type { WorldToScreen } from './city-labels';
import { lonLatToVector3 } from './globe';
import type { PointRecord, RegionRecord } from './highlight-data';
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
// 山の頂。-1 は出さない
const PEAK_RANK_BY_ALTITUDE: [number, number][] = [
  [0.35, -1],
  [0.18, 3],
  [0.09, 5],
  [0.04, 7],
  [0, 9],
];
const PEAK_MARK_HALF = 5; // 山の頂の印 (▲) の幅の半分 (px)。印の中心を頂の位置に合わせる

interface TerrainLabel {
  rank: number;
  peak: boolean;
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
    const [regionModule, pointModule] = await Promise.all([
      import('./data/regions-10m.json'),
      import('./data/points-10m.json'),
    ]);
    const regions = (regionModule.default as unknown as RegionRecord[]).filter((region) => REGION_GROUPS[region.c]);
    const peaks = (pointModule.default as unknown as PointRecord[]).filter((point) => point.c === 'mountain');
    const labels: TerrainLabel[] = [];
    for (const region of regions) {
      const element = document.createElement('span');
      element.className = `terrain-label ${REGION_GROUPS[region.c]} rank-${Math.min(region.r, 4)} off`;
      element.textContent = region.ja || region.n;
      const { lon, lat } = labelPoint(region.p);
      labels.push(this.makeLabel(element, lon, lat, region.r, false));
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
      labels.push(this.makeLabel(element, peak.x, peak.y, peak.r, true));
    }
    // 重要な地形を先に置く。同じ重要度なら範囲を山の頂より先に
    labels.sort((a, b) => a.rank - b.rank || Number(a.peak) - Number(b.peak));
    this.container.append(...labels.map((label) => label.element));
    this.labels = labels;
  }

  private makeLabel(element: HTMLElement, lon: number, lat: number, rank: number, peak: boolean): TerrainLabel {
    return {
      rank,
      peak,
      element,
      world: lonLatToVector3(lon, lat, this.radius),
      width: 0,
      height: 0,
      box: null,
      transform: '',
      shown: false,
    };
  }

  shownBoxes(): LabelBox[] {
    if (this.container.hidden) return [];
    return this.labels.filter((label) => label.shown && label.box).map((label) => label.box as LabelBox);
  }

  // 毎フレーム呼ぶ。blocked は重ねない範囲 (都市のラベル、国名など)、altitude はレンズの分を換算したカメラの高さ
  update(toScreen: WorldToScreen, blocked: LabelBox[], altitude: number): void {
    if (this.container.hidden || this.labels.length === 0) return;
    const regionRank = rankAt(REGION_RANK_BY_ALTITUDE, altitude);
    const peakRank = rankAt(PEAK_RANK_BY_ALTITUDE, altitude);
    const boxes = this.labels.map((label): LabelBox | null => {
      if (label.rank > (label.peak ? peakRank : regionRank)) return null;
      const point = toScreen(label.world);
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
