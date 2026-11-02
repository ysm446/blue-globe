// HDR 的な描画の流れ。明るさの上限がないバッファへ描き、明るい部分をにじませ (ブルーム)、
// 最後に画面の明るさへ変換する。モニターの HDR 出力ではなく、SDR の画面で見るための計算
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
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
  },
  vertexShader: FULLSCREEN_VS,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    varying vec2 vUv;
    ${PIXEL_JITTER_GLSL}
    vec3 aces(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }
    vec3 toSrgb(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }
    void main() {
      vec3 color = toSrgb(aces(max(texture2D(tDiffuse, vUv).rgb, vec3(0.0)) * uExposure));
      // 暗い背景の階調が帯状に見えないよう、8 ビットの 1 段分より小さいノイズを足す
      gl_FragColor = vec4(color + (pixelJitter() - 0.5) / 255.0, 1.0);
    }
  `,
};

export class HdrPipeline {
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly finalPass: ShaderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
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
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(size, BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
    this.composer.addPass(this.bloom);
    this.finalPass = new ShaderPass(FINAL_SHADER);
    this.composer.addPass(this.finalPass);
  }

  // exposure は画面全体の明るさの倍率、sunVisibility は太陽の見えている割合 (0〜1)
  // bloomScale はにじみの強さの倍率。地域ビューの強さは設定で変えられる
  setExposure(exposure: number, sunVisibility: number, bloomScale = 1): void {
    this.finalPass.uniforms.uExposure.value = exposure;
    this.bloom.strength = BLOOM_STRENGTH * (1 + SUN_BLOOM_BOOST * sunVisibility) * bloomScale;
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
  }
}
