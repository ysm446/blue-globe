// HDR 的な描画の流れ。明るさの上限がないバッファへ描き、明るい部分をにじませ (ブルーム)、
// 最後に画面の明るさへ変換する。モニターの HDR 出力ではなく、SDR の画面で見るための計算
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

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
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    varying vec2 vUv;
    vec3 aces(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }
    vec3 toSrgb(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }
    void main() {
      vec3 color = toSrgb(aces(max(texture2D(tDiffuse, vUv).rgb, vec3(0.0)) * uExposure));
      // 暗い背景の階調が帯状に見えないよう、8 ビットの 1 段分より小さいノイズを足す
      float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      gl_FragColor = vec4(color + (noise - 0.5) / 255.0, 1.0);
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
  setExposure(exposure: number, sunVisibility: number): void {
    this.finalPass.uniforms.uExposure.value = exposure;
    this.bloom.strength = BLOOM_STRENGTH * (1 + SUN_BLOOM_BOOST * sunVisibility);
  }

  render(): void {
    this.composer.render();
  }

  setSize(width: number, height: number): void {
    this.composer.setSize(width, height);
  }
}
