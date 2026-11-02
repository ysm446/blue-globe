// 地球儀の上に出す都市のラベル。クリックするとその都市の天気に切り替わる
import * as THREE from 'three';
import type { DemoPlace } from './demo';
import { lonLatToVector3 } from './globe';
import { placeLabels, type LabelBox } from './label-layout';

const DOT_OFFSET = 8; // ラベルの左端から点の中心まで (style.css の .city-label と合わせる)

interface CityLabel {
  place: DemoPlace;
  element: HTMLButtonElement;
  world: THREE.Vector3;
  width: number; // 文字の幅は変わらないので、最初に測って使い回す
  height: number;
  transform: string;
  shown: boolean;
}

export type WorldToScreen = (world: THREE.Vector3) => { x: number; y: number } | null;

export class CityLabels {
  private readonly labels: CityLabel[];
  private excluded: string | null = null;

  constructor(
    private readonly container: HTMLElement,
    places: DemoPlace[],
    radius: number,
    onSelect: (place: DemoPlace) => void,
  ) {
    this.labels = places.map((place) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'city-label off';
      element.textContent = place.name;
      element.title = `${place.name}の天気を表示`;
      element.addEventListener('click', () => onSelect(place));
      container.append(element);
      return {
        place,
        element,
        world: lonLatToVector3(place.lon, place.lat, radius),
        width: 0,
        height: 0,
        transform: '',
        shown: false,
      };
    });
  }

  setVisible(visible: boolean): void {
    this.container.hidden = !visible;
  }

  // 地点のマーカーが同じ名前を出している間は、ラベルを出さない
  setExcluded(name: string | null): void {
    this.excluded = name;
  }

  // 毎フレーム呼ぶ。blocked はラベルを重ねない範囲
  update(toScreen: WorldToScreen, blocked: LabelBox[]): void {
    if (this.container.hidden) return;
    const boxes = this.labels.map((label): LabelBox | null => {
      if (label.place.name === this.excluded) return null;
      const point = toScreen(label.world);
      if (!point) return null;
      if (label.width === 0) {
        label.width = label.element.offsetWidth;
        label.height = label.element.offsetHeight;
      }
      return { x: point.x - DOT_OFFSET, y: point.y - label.height / 2, width: label.width, height: label.height };
    });
    const shown = placeLabels(boxes, blocked);
    this.labels.forEach((label, index) => {
      const box = boxes[index];
      if (box) {
        const transform = `translate(${box.x}px, ${box.y}px)`;
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
