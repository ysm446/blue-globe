// 惑星の点の横に出す名前。点だけでは星と見分けられないため。クリックはできない。太陽系の場面でも使う
import * as THREE from 'three';
import { earthClearance } from './exposure';

const LABEL_OFFSET = 7; // 点の中心から文字の左端まで (CSS ピクセル)

interface PlanetLabel {
  element: HTMLElement;
  transform: string;
  shown: boolean;
}

export class PlanetLabels {
  private readonly labels = new Map<string, PlanetLabel>();
  private readonly toPlanet = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();

  constructor(
    private readonly container: HTMLElement,
    names: string[],
    private readonly globeRadius: number | null, // 地球の後ろの名前を隠すときの地球の半径。null は隠さない
  ) {
    for (const name of names) {
      const element = document.createElement('span');
      element.className = 'planet-label off';
      element.textContent = name;
      container.append(element);
      this.labels.set(name, { element, transform: '', shown: false });
    }
  }

  // 毎フレーム呼ぶ。position が null のものと、地球の後ろと画面の外のものは出さない
  update(planets: ReadonlyArray<{ name: string; position: THREE.Vector3 | null }>, camera: THREE.Camera, visible: boolean): void {
    this.container.hidden = !visible;
    if (!visible) return;
    const eye = camera.position.toArray();
    for (const planet of planets) {
      const label = this.labels.get(planet.name);
      if (!label) continue;
      let shown = false;
      if (planet.position) {
        this.toPlanet.copy(planet.position).sub(camera.position).normalize();
        this.projected.copy(planet.position).project(camera);
        const onScreen =
          this.projected.z < 1 && Math.abs(this.projected.x) <= 1 && Math.abs(this.projected.y) <= 1;
        shown =
          onScreen && (this.globeRadius === null || earthClearance(eye, this.toPlanet.toArray(), this.globeRadius) > 0.5);
      }
      if (shown) {
        const x = ((this.projected.x + 1) / 2) * window.innerWidth + LABEL_OFFSET;
        const y = ((1 - this.projected.y) / 2) * window.innerHeight;
        const transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translateY(-50%)`;
        if (transform !== label.transform) {
          label.transform = transform;
          label.element.style.transform = transform;
        }
      }
      if (shown !== label.shown) {
        label.shown = shown;
        label.element.classList.toggle('off', !shown);
      }
    }
  }
}
