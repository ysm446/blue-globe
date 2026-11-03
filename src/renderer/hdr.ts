// HDR 的な描画の流れ。明るさの上限がないバッファへ描き、明るい部分をにじませ (ブルーム)、
// 最後に画面の明るさへ変換する。モニターの HDR 出力ではなく、SDR の画面で見るための計算
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { DepthOfFieldPass } from './depth-of-field';
import { FULLSCREEN_VS, PIXEL_JITTER_GLSL } from './glsl';

const BLOOM_STRENGTH = 0.42;
const BLOOM_RADIUS = 0.6;
const BLOOM_THRESHOLD = 2.6; // 太陽に照らされた陸、雲、氷はにじませない
const SUN_BLOOM_BOOST = 0.3; // 太陽が見えているときのにじみの増え方
const MSAA_SAMPLES = 4;

const FINAL_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uExposure: { value: 1 },
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    uGlare: { value: 0 },
    uGlareTint: { value: new THREE.Vector3(1, 1, 1) },
    uVeil: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: FULLSCREEN_VS,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform vec2 uSunUv;
    uniform float uGlare;
    uniform vec3 uGlareTint;
    uniform float uVeil;
    uniform float uAspect;
    varying vec2 vUv;
    ${PIXEL_JITTER_GLSL}
    vec3 aces(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }
    vec3 toSrgb(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }
    // レンズの中で太陽の光が散って見えるもの。太陽の前に地球があっても、その上に重なる。
    // 光の輪、放射状の光の筋、画面全体のかぶりを足す。距離は画面の高さを 1 とする
    vec3 sunGlare() {
      vec2 d = (vUv - uSunUv) * vec2(uAspect, 1.0);
      float r = length(d);
      float angle = atan(d.y, d.x);
      float halo = 0.0004 / (r * r + 0.0004) * 1.5 + 0.02 / (r * r + 0.02) * 0.25 * uVeil;
      // 筋の太さと長さを揃えないよう、別の周期で強さを変える
      float rays = pow(abs(cos(angle * 3.0 + 0.4)), 300.0) * (0.7 + 0.3 * sin(angle * 5.0))
        + pow(abs(cos(angle * 5.0 + 1.3)), 500.0) * 0.5 * (0.6 + 0.4 * cos(angle * 3.0 + 2.0));
      rays *= 0.008 / (r + 0.01) * smoothstep(0.3, 0.0, r);
      float veil = 0.025 * uVeil;
      return uGlareTint * (halo + rays + veil) * uGlare;
    }
    void main() {
      vec3 scene = max(texture2D(tDiffuse, vUv).rgb, vec3(0.0)) + sunGlare();
      vec3 color = toSrgb(aces(scene * uExposure));
      // 暗い背景の階調が帯状に見えないよう、8 ビットの 1 段分より小さいノイズを足す
      gl_FragColor = vec4(color + (pixelJitter() - 0.5) / 255.0, 1.0);
    }
  `,
};

export class HdrPipeline {
  private readonly composer: EffectComposer;
  private readonly scenePass: RenderPass;
  private backdropPass: RenderPass | null = null;
  private readonly depthOfField: DepthOfFieldPass;
  private readonly bloom: UnrealBloomPass;
  private readonly finalPass: ShaderPass;

  // earthRadius は被写界深度で奥行きを求める地球の球の半径
  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, earthRadius: number) {
    const floatable =
      renderer.extensions.has('EXT_color_buffer_float') ||
      renderer.extensions.has('EXT_color_buffer_half_float');
    const size = renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(
      renderer,
      new THREE.WebGLRenderTarget(size.x, size.y, {
        type: floatable ? THREE.HalfFloatType : THREE.UnsignedByteType,
        samples: MSAA_SAMPLES,
      }),
    );
    this.composer.setPixelRatio(renderer.getPixelRatio());
    this.composer.setSize(size.x, size.y);
    this.scenePass = new RenderPass(scene, camera);
    this.composer.addPass(this.scenePass);
    this.depthOfField = new DepthOfFieldPass(camera, earthRadius);
    this.composer.addPass(this.depthOfField);
    this.bloom = new UnrealBloomPass(size, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    this.composer.addPass(this.bloom);
    this.finalPass = new ShaderPass(FINAL_SHADER);
    this.finalPass.uniforms.uAspect.value = size.x / size.y;
    this.composer.addPass(this.finalPass);
  }

  // x, y は太陽の画面上の位置 (0〜1。左下が 0)。strength が 0 のときは描かない。
  // veil は大きな光の輪と画面全体のかぶりの強さ (0〜1)
  setSunGlare(x: number, y: number, strength: number, tint: THREE.Vector3, veil: number): void {
    this.finalPass.uniforms.uSunUv.value.set(x, y);
    this.finalPass.uniforms.uGlare.value = strength;
    this.finalPass.uniforms.uGlareTint.value.copy(tint);
    this.finalPass.uniforms.uVeil.value = veil;
  }

  // exposure は画面全体の明るさの倍率、sunVisibility は太陽の見えている割合 (0〜1)
  // bloomScale はにじみの強さの倍率。地域ビューの強さは設定で変えられる
  setExposure(exposure: number, sunVisibility: number, bloomScale = 1): void {
    this.finalPass.uniforms.uExposure.value = exposure;
    this.bloom.strength = BLOOM_STRENGTH * (1 + SUN_BLOOM_BOOST * sunVisibility) * bloomScale;
  }

  // 太陽系の場面を先に描き、その上にこの場面を重ねる。null で元に戻す。
  // sceneVisible が false のときは、重ねる場面を描かない (地球が点になるほど遠いとき)
  setBackdrop(scene: THREE.Scene | null, camera: THREE.Camera | null, sceneVisible = true): void {
    if (scene && camera) {
      if (!this.backdropPass) {
        this.backdropPass = new RenderPass(scene, camera);
        this.composer.insertPass(this.backdropPass, 0);
      }
      this.backdropPass.enabled = true;
    } else if (this.backdropPass) {
      this.backdropPass.enabled = false;
    }
    const layered = this.backdropPass?.enabled === true;
    this.scenePass.clear = !layered;
    this.scenePass.clearDepth = layered;
    this.scenePass.enabled = !layered || sceneVisible;
  }

  // fNumber は F 値、globeSize は地球を見立てる地球儀の直径 (m)。null で掛けない
  setDepthOfField(lens: { fNumber: number; globeSize: number } | null): void {
    this.depthOfField.enabled = lens !== null;
    if (lens) this.depthOfField.setLens(lens.fNumber, lens.globeSize);
  }

  setBloomEnabled(enabled: boolean): void {
    this.bloom.enabled = enabled;
  }

  setPixelRatio(pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
  }

  render(): void {
    this.composer.render();
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
    this.finalPass.uniforms.uAspect.value = width / height;
  }
}
