// 右下の縮尺のバー。画面の中心の左右に伸ばした視線が地表に当たる 2 点の距離から、1 画素あたりの距離を求める
import * as THREE from 'three';
import { formatScaleDistance, globeFillsView, groundSpanKm, niceScale } from './camera-readout';
import { el } from './dom';
import type { Vec3 } from './math';

const PROBE_PX = 50; // 中心から左右にこれだけ離した 2 点で測る。中心の縮尺を読むので、狭くてよい
const MAX_BAR_PX = 120; // バーの最長。1・2・5 刻みなので、短いときはこの 0.4 倍 (48px) まで縮む

export class ScaleBar {
  private readonly root = el('scale-bar');
  private readonly label = el('scale-bar-label');
  private readonly line = el('scale-bar-line');
  private readonly ndc = new THREE.Vector3();
  private readonly left = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private text = '';
  private width = -1;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly radius: number,
  ) {}

  // 画面を描いたあとに毎フレーム呼ぶ。enabled が false (太陽系など) のときは隠す
  update(enabled: boolean): void {
    const km = enabled ? this.measure() : null;
    if (km === null) {
      this.root.hidden = true;
      return;
    }
    const bar = niceScale(km / (PROBE_PX * 2), MAX_BAR_PX);
    const text = formatScaleDistance(bar.km);
    const width = Math.round(bar.px);
    if (text !== this.text) this.label.textContent = this.text = text;
    if (width !== this.width) this.line.style.width = `${(this.width = width)}px`;
    this.root.hidden = false;
  }

  // 中心をはさむ 2 点の、地表に沿った距離 (km)。地球の縁が画面に入っているか、地表を外れたら null
  private measure(): number | null {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const tanHalfFovY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    if (!globeFillsView(this.camera.position.length(), this.radius, tanHalfFovY, w, h)) return null;
    // 画面の中心の左右の点を、カメラから見た向きに直す (狭い画面で地球をずらす分は投影行列に入っているので、そのまま画面の座標で測れる)
    const dx = (PROBE_PX / w) * 2;
    const position = this.camera.position;
    this.left.copy(this.ndc.set(-dx, 0, 0.5)).unproject(this.camera).sub(position);
    this.right.copy(this.ndc.set(dx, 0, 0.5)).unproject(this.camera).sub(position);
    return groundSpanKm(
      position.toArray() as Vec3,
      this.left.toArray() as Vec3,
      this.right.toArray() as Vec3,
      this.radius,
    );
  }
}
