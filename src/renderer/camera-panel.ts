// 右上のカメラのパネル。開いて画面に出ている間だけ計算する
import * as THREE from 'three';
import {
  EARTH_RADIUS_KM,
  formatAltitude,
  formatExposure,
  formatHeading,
  formatLatitude,
  formatLongitude,
  formatSpeed,
  groundDistanceKm,
  viewReadout,
} from './camera-readout';
import { el } from './dom';
import type { Vec3 } from './math';

const REFRESH_SECONDS = 0.1; // 数字が読めるよう、書き換えは 1 秒に 10 回まで
const SPEED_SECONDS = 0.3; // 速さはフレームごとにばらつくので、この時定数でならす

export interface CameraPanelState {
  focalLength: number;
  exposure: number | null; // 画面の明るさの倍率。露出の処理を通さないときは null
}

export class CameraPanel {
  private readonly panel = el('camera-panel');
  private readonly fold = el<HTMLDetailsElement>('fold-camera');
  private readonly fields = {
    altitude: el('camera-altitude'),
    speed: el('camera-speed'),
    latitude: el('camera-latitude'),
    longitude: el('camera-longitude'),
    heading: el('camera-heading'),
    tilt: el('camera-tilt'),
    lens: el('camera-lens'),
    exposure: el('camera-exposure'),
  };
  private readonly forward = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private previous: Vec3 | null = null;
  private speed = 0;
  private sinceRefresh = Infinity;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly radius: number,
  ) {}

  // 画面を描いたあとに毎フレーム呼ぶ
  update(dt: number, state: CameraPanelState): void {
    if (!this.fold.open || !this.panel.checkVisibility()) {
      // 開き直したときに、閉じていた間の移動を速さに数えない
      this.previous = null;
      this.speed = 0;
      this.sinceRefresh = Infinity;
      return;
    }
    const position = this.camera.position.toArray() as Vec3;
    if (this.previous && dt > 0) {
      const instant = groundDistanceKm(this.previous, position) / dt;
      this.speed += (instant - this.speed) * (1 - Math.exp(-dt / SPEED_SECONDS));
    }
    this.previous = position;
    this.sinceRefresh += dt;
    if (this.sinceRefresh < REFRESH_SECONDS) return;
    this.sinceRefresh = 0;

    this.camera.getWorldDirection(this.forward);
    this.up.setFromMatrixColumn(this.camera.matrixWorld, 1).normalize();
    const view = viewReadout(position, this.forward.toArray(), this.up.toArray(), this.radius);
    this.show('altitude', formatAltitude((this.camera.position.length() - this.radius) * EARTH_RADIUS_KM));
    this.show('speed', formatSpeed(this.speed));
    this.show('latitude', formatLatitude(view.lat));
    this.show('longitude', formatLongitude(view.lon));
    this.show('heading', formatHeading(view.heading));
    this.show('tilt', `${Math.round(view.tilt)}°`);
    const focal = Number.isInteger(state.focalLength) ? state.focalLength : state.focalLength.toFixed(1);
    this.show('lens', `${focal}mm / ${this.camera.fov.toFixed(1)}°`);
    this.show('exposure', formatExposure(state.exposure));
  }

  private show(field: keyof CameraPanel['fields'], text: string): void {
    if (this.fields[field].textContent !== text) this.fields[field].textContent = text;
  }
}
