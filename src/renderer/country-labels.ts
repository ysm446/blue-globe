// 地球儀の上に出す国名と国旗。設定の「国名を表示」で出す。データはツアーのハイライトと同じ (highlight-data.ts)。
// 引いているときは大きな国だけ、寄るほど小さな国まで出す。都市のラベルと地点のマーカーには重ねない
import * as THREE from 'three';
import type { WorldToScreen } from './city-labels';
import { lonLatToVector3 } from './globe';
import type { CountryRecord } from './highlight-data';
import { placeLabels, type LabelBox } from './label-layout';

// カメラの高さ (レンズの分を換算、地球の半径が 1) ごとの、出す国の LABELRANK の上限。上から順に、この高さ以上なら
const RANK_BY_ALTITUDE: [number, number][] = [
  [1.4, 3],
  [0.6, 4],
  [0.3, 5],
  [0.15, 6],
  [0, 8],
];

interface CountryLabel {
  country: CountryRecord;
  element: HTMLElement;
  world: THREE.Vector3;
  width: number; // 文字の幅は変わらないので、最初に測って使い回す
  height: number;
  transform: string;
  shown: boolean;
}

export function rankAtAltitude(altitude: number): number {
  return (RANK_BY_ALTITUDE.find(([min]) => altitude >= min) ?? RANK_BY_ALTITUDE[RANK_BY_ALTITUDE.length - 1])[1];
}

export class CountryLabels {
  private labels: CountryLabel[] = [];
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
    const mod = await import('./data/countries-10m.json');
    const countries = (mod.default as unknown as CountryRecord[]).filter((country) => country.ja || country.n);
    // 大きな国 (LABELRANK の小さい国) を先に置く
    countries.sort((a, b) => a.r - b.r);
    this.labels = countries.map((country) => {
      const element = document.createElement('span');
      element.className = 'country-label off';
      if (country.f) {
        const flag = document.createElement('img');
        flag.src = `./flags/${country.f}.svg`;
        flag.alt = '';
        element.append(flag);
      }
      element.append(country.ja || country.n);
      this.container.append(element);
      return {
        country,
        element,
        world: lonLatToVector3(country.x, country.y, this.radius),
        width: 0,
        height: 0,
        transform: '',
        shown: false,
      };
    });
  }

  // 毎フレーム呼ぶ。blocked は重ねない範囲 (都市のラベルなど)、excluded はハイライトがすでに出している国 (ADM0_A3)
  update(toScreen: WorldToScreen, blocked: LabelBox[], altitude: number, excluded: ReadonlySet<string>): void {
    if (this.container.hidden || this.labels.length === 0) return;
    const maxRank = rankAtAltitude(altitude);
    const boxes = this.labels.map((label): LabelBox | null => {
      if (label.country.r > maxRank || excluded.has(label.country.a3)) return null;
      const point = toScreen(label.world);
      if (!point) return null;
      if (label.width === 0) {
        label.width = label.element.offsetWidth;
        label.height = label.element.offsetHeight;
      }
      return { x: point.x - label.width / 2, y: point.y - label.height / 2, width: label.width, height: label.height };
    });
    const shown = placeLabels(boxes, blocked);
    this.labels.forEach((label, index) => {
      const box = boxes[index];
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
