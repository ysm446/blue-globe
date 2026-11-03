// 雲の画像の入れ替え。新しい時刻の雲が届いたら、いま見えている雲から一定の時間で線形に混ぜて入れ替える
// (過去の時刻へ戻したときなどに、雲が一瞬で切り替わらないように)。
// 混ぜた結果は GPU の描画先に持ち、地表の影、平らな雲、立体の雲はすべてそれを引く。
// 描画先は 2 枚を交互に使い、入れ替えの途中で次の雲が届いたら、そのとき見えている状態から混ぜ直す
import * as THREE from 'three';
import { FULLSCREEN_VS } from './glsl';

export const CLOUD_BLEND_SECONDS = 1.5;

const BLEND_FS = /* glsl */ `
precision highp float;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uMix;
varying vec2 vUv;
void main() {
  float from = textureLod(uFrom, vUv, 0.0).r;
  float to = textureLod(uTo, vUv, 0.0).r;
  gl_FragColor = vec4(mix(from, to, uMix), 0.0, 0.0, 1.0);
}
`;

function cloudTarget(nx: number, ny: number): THREE.WebGLRenderTarget {
  const target = new THREE.WebGLRenderTarget(nx, ny, {
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  target.texture.wrapS = THREE.RepeatWrapping;
  return target;
}

export class CloudBlend {
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  private shown = 0; // 見えているのは targets[shown]
  private incoming: THREE.DataTexture | null = null;
  private amount = 1; // 新しい雲の割合
  private dirty = false;
  private readonly material = new THREE.ShaderMaterial({
    uniforms: { uFrom: { value: null }, uTo: { value: null }, uMix: { value: 1 } },
    vertexShader: FULLSCREEN_VS,
    fragmentShader: BLEND_FS,
    depthTest: false,
    depthWrite: false,
  });
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.Camera();

  constructor() {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene = new THREE.Scene().add(quad);
  }

  // 見えている雲。届くまでは null
  get texture(): THREE.Texture | null {
    return this.targets?.[this.shown].texture ?? null;
  }

  // 新しい雲の割合 (0〜1)。入れ替えの途中でなければ 1
  get progress(): number {
    return this.amount;
  }

  // data は 1 画素 1 バイトの雲の濃さ。1 行目が北端、左端が経度 -180 度。
  // 見えている雲のテクスチャが替わるので、呼んだあとは texture を引き直す
  setData(nx: number, ny: number, data: Uint8Array): void {
    const texture = new THREE.DataTexture(data as Uint8Array<ArrayBuffer>, nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
    texture.needsUpdate = true;
    this.incoming?.dispose();
    this.incoming = texture;
    if (!this.targets || this.targets[0].width !== nx || this.targets[0].height !== ny) {
      // 初めての雲 (または大きさが変わったとき) は、混ぜずにそのまま出す
      this.targets?.forEach((target) => target.dispose());
      this.targets = [cloudTarget(nx, ny), cloudTarget(nx, ny)];
      this.shown = 0;
      this.amount = 1;
    } else {
      // いま見えている描画先を混ぜ始めの雲にして、もう 1 枚へ描く
      this.shown = 1 - this.shown;
      this.amount = 0;
    }
    this.dirty = true;
  }

  // 毎フレーム呼ぶ
  update(dt: number): void {
    if (this.amount >= 1) return;
    this.amount = Math.min(1, this.amount + dt / CLOUD_BLEND_SECONDS);
    this.dirty = true;
  }

  // 画面を描く前に呼ぶ。描き直したら true
  render(renderer: THREE.WebGLRenderer): boolean {
    if (!this.dirty || !this.targets || !this.incoming) return false;
    const uniforms = this.material.uniforms;
    uniforms.uFrom.value = this.targets[1 - this.shown].texture;
    uniforms.uTo.value = this.incoming;
    uniforms.uMix.value = this.amount;
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.targets[this.shown]);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previousTarget);
    this.dirty = false;
    return true;
  }
}
