// GPU パーティクルを使えない環境のための、CPU で動かす風の粒子
import * as THREE from 'three';
import { lonLatToVector3 } from './globe';
import { DEG } from './math';
import { WindField } from './wind';
import { BASE_DEG_PER_FRAME, PARTICLE_MAX_LAT, randomParticleLat, speedColor } from './wind-texture';

const FADE_IN_FRAMES = 8; // 出現直後にフェードイン
const FADE_OUT_FRAMES = 24; // 寿命の終わりにフェードアウト

export class ParticleSystem {
  readonly object3d: THREE.LineSegments;
  speedFactor = 1.0;
  brightness = 1.0;

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
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly tmpVec = new THREE.Vector3();

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

  private respawn(i: number): void {
    const TRAIL = this.trailLen;
    this.lats[i] = randomParticleLat();
    this.lons[i] = Math.random() * 360 - 180;
    this.ages[i] = 0;
    this.maxAges[i] = 80 + Math.random() * 120;
    this.speeds[i] = 0;
    lonLatToVector3(this.lons[i], this.lats[i], this.radius, this.tmpVec);
    for (let k = 0; k < TRAIL; k++) this.tmpVec.toArray(this.trails, (i * TRAIL + k) * 3);
  }

  update(): void {
    const TRAIL = this.trailLen;
    const positions = this.positionAttr.array as Float32Array;
    const colors = this.colorAttr.array as Float32Array;
    const k = BASE_DEG_PER_FRAME * this.speedFactor;

    for (let i = 0; i < this.count; i++) {
      const w = this.wind.sample(this.lons[i], this.lats[i]);
      if (!w || this.ages[i] > this.maxAges[i] || Math.abs(this.lats[i]) > PARTICLE_MAX_LAT) {
        this.respawn(i);
      } else {
        const cosLat = Math.max(0.05, Math.cos(this.lats[i] * DEG));
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
        lonLatToVector3(this.lons[i], this.lats[i], this.radius, this.tmpVec);
        this.tmpVec.toArray(this.trails, trailBase + (TRAIL - 1) * 3);
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
      let [r, g, b] = speedColor(this.speeds[i]);
      const lum = life * this.brightness;
      r *= lum;
      g *= lum;
      b *= lum;
      const trailBase = i * TRAIL * 3;
      for (let t = 0; t < TRAIL - 1; t++) {
        const seg = (i * (TRAIL - 1) + t) * 6;
        const p0 = trailBase + t * 3;
        const p1 = p0 + 3;
        positions[seg] = this.trails[p0];
        positions[seg + 1] = this.trails[p0 + 1];
        positions[seg + 2] = this.trails[p0 + 2];
        positions[seg + 3] = this.trails[p1];
        positions[seg + 4] = this.trails[p1 + 1];
        positions[seg + 5] = this.trails[p1 + 2];

        const f0 = t / (TRAIL - 1);
        const f1 = (t + 1) / (TRAIL - 1);
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
}
