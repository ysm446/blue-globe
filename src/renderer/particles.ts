import * as THREE from 'three';
import { WindField } from './wind';
import { lonLatToVector3 } from './globe';
import { lonLatToPlane, wrapLon, MAX_MERC_Y } from './projection';

const BASE_DEG_PER_FRAME = 0.03; // 風速 1 m/s あたりの 1 フレーム移動量(度)
const MAX_LAT = 85; // 極近傍は移流が破綻するためリセットする
const FADE_IN_FRAMES = 8; // 出現直後にフェードイン
const FADE_OUT_FRAMES = 24; // 寿命の終わりにフェードアウト

// 風速 (m/s) → 色のグラデーション。[風速, [R, G, B]] の列(風速昇順)
export type ColorStops = Array<[number, [number, number, number]]>;

// 配色プリセット。Viridis / Turbo は代表点をサンプリングした折れ線近似
export const COLOR_SCHEMES: Record<string, ColorStops> = {
  standard: [
    [0, [70, 110, 215]],
    [5, [80, 195, 205]],
    [10, [125, 215, 125]],
    [15, [235, 215, 100]],
    [25, [255, 140, 85]],
    [35, [255, 90, 170]],
  ],
  // 暗い青緑の海から強風帯が金色〜赤に浮かぶ、earth.nullschool 風の配色
  earth: [
    [0, [10, 36, 47]],
    [3, [36, 89, 98]],
    [7, [62, 138, 109]],
    [11, [109, 174, 104]],
    [15, [164, 199, 100]],
    [20, [222, 209, 107]],
    [26, [240, 160, 71]],
    [35, [214, 64, 38]],
  ],
  viridis: [
    [0, [68, 1, 84]],
    [8.75, [59, 82, 139]],
    [17.5, [33, 145, 140]],
    [26.25, [94, 201, 98]],
    [35, [253, 231, 37]],
  ],
  turbo: [
    [0, [48, 18, 59]],
    [5, [64, 112, 232]],
    [10, [38, 189, 221]],
    [15, [112, 247, 116]],
    [20, [227, 221, 46]],
    [25, [253, 156, 49]],
    [30, [217, 69, 28]],
    [35, [122, 4, 3]],
  ],
};

export function speedColor(
  speed: number,
  stops: ColorStops = COLOR_SCHEMES.standard,
): [number, number, number] {
  if (speed <= stops[0][0]) {
    const c = stops[0][1];
    return [c[0] / 255, c[1] / 255, c[2] / 255];
  }
  for (let i = 1; i < stops.length; i++) {
    if (speed <= stops[i][0]) {
      const [s0, c0] = stops[i - 1];
      const [s1, c1] = stops[i];
      const t = (speed - s0) / (s1 - s0);
      return [
        (c0[0] + (c1[0] - c0[0]) * t) / 255,
        (c0[1] + (c1[1] - c0[1]) * t) / 255,
        (c0[2] + (c1[2] - c0[2]) * t) / 255,
      ];
    }
  }
  const c = stops[stops.length - 1][1];
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}

export class ParticleSystem {
  readonly object3d: THREE.LineSegments;
  speedFactor = 1.0;
  brightness = 1.0;
  colorStops: ColorStops = COLOR_SCHEMES.standard;
  morph = 0; // 地球儀 (0) ⇔ メルカトル平面 (1)
  centerLon = 0; // 地図の中央経度

  private readonly count: number;
  private readonly radius: number;
  private readonly trailLen: number; // 1 粒子あたりの軌跡点数
  private wind: WindField;
  private readonly lons: Float32Array;
  private readonly lats: Float32Array;
  private readonly ages: Float32Array;
  private readonly maxAges: Float32Array;
  private readonly speeds: Float32Array;
  private readonly trails: Float32Array; // 投影済み座標 count * TRAIL * 3
  private readonly trailLonLats: Float32Array; // 経緯度の履歴 count * TRAIL * 2
  private lastMorph = 0; // morph / centerLon が動いた次のフレームで軌跡全体を再投影する
  private lastCenterLon = 0;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpPlane = new THREE.Vector3();

  constructor(count: number, radius: number, wind: WindField, trailLen = 16) {
    const TRAIL = Math.max(2, trailLen);
    this.count = count;
    this.radius = radius;
    this.trailLen = TRAIL;
    this.wind = wind;
    this.lons = new Float32Array(count);
    this.lats = new Float32Array(count);
    this.ages = new Float32Array(count);
    this.maxAges = new Float32Array(count);
    this.speeds = new Float32Array(count);
    this.trails = new Float32Array(count * TRAIL * 3);
    this.trailLonLats = new Float32Array(count * TRAIL * 2);

    const segments = count * (TRAIL - 1);
    const positions = new Float32Array(segments * 2 * 3);
    const colors = new Float32Array(segments * 2 * 3);
    const geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(positions, 3);
    this.colorAttr = new THREE.BufferAttribute(colors, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('color', this.colorAttr);

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.object3d = new THREE.LineSegments(geometry, material);
    this.object3d.frustumCulled = false;

    for (let i = 0; i < count; i++) this.respawn(i);
  }

  setWind(wind: WindField): void {
    this.wind = wind;
    for (let i = 0; i < this.count; i++) this.respawn(i);
  }

  // 現在のモーフ量・中央経度で経緯度をワールド座標へ投影する (表示経度で計算)
  private project(lon: number, lat: number, out: THREE.Vector3): void {
    const dlon = wrapLon(lon - this.centerLon);
    lonLatToVector3(dlon, lat, this.radius, out);
    if (this.morph > 0) {
      lonLatToPlane(dlon, lat, this.radius, this.tmpPlane);
      out.lerp(this.tmpPlane, this.morph);
    }
  }

  private respawn(i: number): void {
    const TRAIL = this.trailLen;
    // 緯度分布は表示に合わせてブレンドする (球面上で一様 ⇔ メルカトル地図上で一様)
    const u = Math.random() * 2 - 1;
    const latSphere = (Math.asin(u) * 180) / Math.PI;
    const latMap = ((2 * Math.atan(Math.exp(u * MAX_MERC_Y)) - Math.PI / 2) * 180) / Math.PI;
    const lat = latSphere + (latMap - latSphere) * this.morph;
    const lon = Math.random() * 360 - 180;
    this.lons[i] = lon;
    this.lats[i] = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    this.ages[i] = 0;
    this.maxAges[i] = 80 + Math.random() * 120;
    this.speeds[i] = 0;
    this.project(this.lons[i], this.lats[i], this.tmpVec);
    for (let k = 0; k < TRAIL; k++) {
      const base = (i * TRAIL + k) * 3;
      this.trails[base] = this.tmpVec.x;
      this.trails[base + 1] = this.tmpVec.y;
      this.trails[base + 2] = this.tmpVec.z;
      const lbase = (i * TRAIL + k) * 2;
      this.trailLonLats[lbase] = this.lons[i];
      this.trailLonLats[lbase + 1] = this.lats[i];
    }
  }

  update(): void {
    const TRAIL = this.trailLen;
    const positions = this.positionAttr.array as Float32Array;
    const colors = this.colorAttr.array as Float32Array;
    // モーフ・中央経度の変更中は投影が変わるので、蓄積済みの軌跡もすべて投影し直す
    const reproject = this.morph !== this.lastMorph || this.centerLon !== this.lastCenterLon;
    this.lastMorph = this.morph;
    this.lastCenterLon = this.centerLon;

    for (let i = 0; i < this.count; i++) {
      const w = this.wind.sample(this.lons[i], this.lats[i]);
      let wrapped = false;
      if (w) {
        const k = BASE_DEG_PER_FRAME * this.speedFactor;
        const cosLat = Math.max(
          0.05,
          Math.cos((this.lats[i] * Math.PI) / 180),
        );
        const lon = this.lons[i] + (w.u * k) / cosLat;
        // 地図の切れ目 (表示経度 ±180°) をまたいだかで判定する
        wrapped =
          Math.abs(wrapLon(lon - this.centerLon) - wrapLon(this.lons[i] - this.centerLon)) > 180;
      }
      // 平面表示中に地図の切れ目をまたぐと軌跡が地図を横断してしまうのでリセットする
      if (
        !w ||
        this.ages[i] > this.maxAges[i] ||
        Math.abs(this.lats[i]) > MAX_LAT ||
        (wrapped && this.morph > 0)
      ) {
        this.respawn(i);
      } else {
        const k = BASE_DEG_PER_FRAME * this.speedFactor;
        const cosLat = Math.max(
          0.05,
          Math.cos((this.lats[i] * Math.PI) / 180),
        );
        let lon = this.lons[i] + (w.u * k) / cosLat;
        if (lon > 180) lon -= 360;
        else if (lon < -180) lon += 360;
        this.lons[i] = lon;
        this.lats[i] += w.v * k;
        this.ages[i] += 1;
        this.speeds[i] = w.speed;

        // 軌跡を 1 つずらして先頭に現在位置を入れる
        const trailBase = i * TRAIL * 3;
        this.trails.copyWithin(trailBase, trailBase + 3, trailBase + TRAIL * 3);
        const lonlatBase = i * TRAIL * 2;
        this.trailLonLats.copyWithin(lonlatBase, lonlatBase + 2, lonlatBase + TRAIL * 2);
        this.project(this.lons[i], this.lats[i], this.tmpVec);
        const head = trailBase + (TRAIL - 1) * 3;
        this.trails[head] = this.tmpVec.x;
        this.trails[head + 1] = this.tmpVec.y;
        this.trails[head + 2] = this.tmpVec.z;
        const lhead = lonlatBase + (TRAIL - 1) * 2;
        this.trailLonLats[lhead] = this.lons[i];
        this.trailLonLats[lhead + 1] = this.lats[i];
      }

      if (reproject) {
        for (let k = 0; k < TRAIL; k++) {
          const lbase = (i * TRAIL + k) * 2;
          this.project(this.trailLonLats[lbase], this.trailLonLats[lbase + 1], this.tmpVec);
          const base = (i * TRAIL + k) * 3;
          this.trails[base] = this.tmpVec.x;
          this.trails[base + 1] = this.tmpVec.y;
          this.trails[base + 2] = this.tmpVec.z;
        }
      }

      // 軌跡をラインセグメント列として書き出す(古いほど暗く)
      // 出現・消滅が急に見えないよう、寿命の出入りで明るさを絞る
      const life = Math.max(
        0,
        Math.min(
          1,
          this.ages[i] / FADE_IN_FRAMES,
          (this.maxAges[i] - this.ages[i]) / FADE_OUT_FRAMES,
        ),
      );
      let [r, g, b] = speedColor(this.speeds[i], this.colorStops);
      const lum = life * this.brightness;
      r *= lum;
      g *= lum;
      b *= lum;
      const trailBase = i * TRAIL * 3;
      for (let k = 0; k < TRAIL - 1; k++) {
        const seg = (i * (TRAIL - 1) + k) * 6;
        const p0 = trailBase + k * 3;
        const p1 = p0 + 3;
        positions[seg] = this.trails[p0];
        positions[seg + 1] = this.trails[p0 + 1];
        positions[seg + 2] = this.trails[p0 + 2];
        positions[seg + 3] = this.trails[p1];
        positions[seg + 4] = this.trails[p1 + 1];
        positions[seg + 5] = this.trails[p1 + 2];

        const f0 = k / (TRAIL - 1);
        const f1 = (k + 1) / (TRAIL - 1);
        colors[seg] = r * f0;
        colors[seg + 1] = g * f0;
        colors[seg + 2] = b * f0;
        colors[seg + 3] = r * f1;
        colors[seg + 4] = g * f1;
        colors[seg + 5] = b * f1;
      }
    }

    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  dispose(): void {
    this.object3d.geometry.dispose();
    (this.object3d.material as THREE.Material).dispose();
  }
}
