// GPU パーティクルによる風の流線描画。
//
// 仕組み (Mapbox webgl-wind / nullschool と同系統):
//  1. 粒子の状態 (lon, lat, age, maxAge) を浮動小数点テクスチャに持ち、
//     フラグメントシェーダーで毎フレーム移流する (ping-pong FBO)
//  2. 風場 (u, v) はテクスチャに焼き、補間は GPU のバイリニアフィルタに任せる
//  3. 軌跡は画面スペースの蓄積バッファで表現する:
//     前フレームの蓄積画像を少し減衰させて描き、その上に現在の粒子を点で重ねる
//  4. 蓄積画像をメインシーンの上に加算合成する
//
// 蓄積バッファ内では毎フレーム地球を深度のみ描画してから点を打つため、
// 地球の裏側の粒子は深度テストで落ちる。

import * as THREE from 'three';
import { FULLSCREEN_VS } from './glsl';
import {
  BASE_DEG_PER_FRAME,
  PARTICLE_MAX_LAT,
  RAMP_MAX_SPEED,
  randomParticleLat,
  WIND_LOOKUP_GLSL,
  type WindUniforms,
} from './wind-texture';

const MOVING_FADE = 0.82; // カメラ操作中は軌跡を速く消してスミアを抑える

// 粒子状態の更新。state = (lon, lat, age, maxAge)
const UPDATE_FS = /* glsl */ `
precision highp float;
${WIND_LOOKUP_GLSL}
uniform sampler2D uState;
uniform float uK;       // 度/フレーム per m/s
uniform float uTime;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec4 st = texture2D(uState, vUv);
  vec2 lonlat = st.xy;
  float age = st.z + 1.0;
  float maxAge = st.w;

  vec2 w = windAt(lonlat);
  float cosLat = max(cos(radians(lonlat.y)), 0.05);
  lonlat.x += w.x * uK / cosLat;
  lonlat.y += w.y * uK;
  lonlat.x = mod(lonlat.x + 180.0, 360.0) - 180.0;

  if (age >= maxAge || abs(lonlat.y) > ${PARTICLE_MAX_LAT.toFixed(1)}) {
    vec2 seed = vUv * 1.37 + fract(vec2(uTime * 0.1031, uTime * 0.0973));
    float r1 = hash(seed);
    float r2 = hash(seed + 19.19);
    float r3 = hash(seed + 47.47);
    // 球面上で一様 (sin(lat) を一様サンプリング)
    float lat = clamp(degrees(asin(r2 * 2.0 - 1.0)), -${PARTICLE_MAX_LAT.toFixed(1)}, ${PARTICLE_MAX_LAT.toFixed(1)});
    lonlat = vec2(r1 * 360.0 - 180.0, lat);
    age = 0.0;
    maxAge = 120.0 + 360.0 * r3;
  }

  gl_FragColor = vec4(lonlat, age, maxAge);
}
`;

// 前フレームの蓄積画像を減衰させてコピーする。
// floor() で量子化することで、8bit バッファでも確実に 0 まで減衰させる
const FADE_FS = /* glsl */ `
precision highp float;
uniform sampler2D uPrev;
uniform float uFade;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(uPrev, vUv).rgb;
  gl_FragColor = vec4(floor(c * 255.0 * uFade) / 255.0, 1.0);
}
`;

const COMPOSITE_FS = /* glsl */ `
precision highp float;
uniform sampler2D uTrail;
uniform float uBrightness;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(uTrail, vUv).rgb * uBrightness, 1.0);
}
`;

// 各頂点 = 1 粒子。position.xy に状態テクスチャの UV を入れてある
const POINT_VS = /* glsl */ `
${WIND_LOOKUP_GLSL}
uniform sampler2D uState;
uniform float uPointSize;
uniform float uRadius;
varying float vSpeed;
varying float vLife;

void main() {
  vec4 st = texture2D(uState, position.xy);
  vSpeed = length(windAt(st.xy));
  // 出現・消滅が急に見えないよう、寿命の出入りで明るさを絞る
  vLife = clamp(min(st.z / 8.0, (st.w - st.z) / 24.0), 0.0, 1.0);

  float phi = (st.x + 180.0) * 0.017453292519943295;
  float theta = (90.0 - st.y) * 0.017453292519943295;
  vec3 p = vec3(-cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta)) * uRadius;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uPointSize;
}
`;

// 注意: 蓄積バッファへの点描は加算ではなくアルファ合成にする。
// 加算だと同じ画素に毎フレーム光が足されて飽和し、時間とともに白化する。
const POINT_FS = /* glsl */ `
precision highp float;
uniform sampler2D uRamp;
varying float vSpeed;
varying float vLife;
void main() {
  vec3 color = texture2D(uRamp, vec2(clamp(vSpeed / ${RAMP_MAX_SPEED.toFixed(1)}, 0.0, 1.0), 0.5)).rgb;
  gl_FragColor = vec4(color, vLife);
}
`;

function makeStateTarget(size: number): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.generateMipmaps = false;
  return rt;
}

function makeQuadScene(material: THREE.ShaderMaterial): THREE.Scene {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return scene;
}

export class GpuParticleSystem {
  speedFactor = 1.0;
  trailFade = 0.95; // 静止時の軌跡の減衰率 (1 に近いほど長い)
  brightness = 1.0; // 合成時に軌跡レイヤー全体へ乗算する

  private readonly renderer: THREE.WebGLRenderer;
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly startTime = performance.now();

  // 共有 uniform (update と points の両方から参照する)
  private readonly uState = { value: null as THREE.Texture | null };

  private stateRead: THREE.WebGLRenderTarget;
  private stateWrite: THREE.WebGLRenderTarget;
  private initTexture: THREE.DataTexture | null;

  private updateMat: THREE.ShaderMaterial;
  private fadeMat: THREE.ShaderMaterial;
  private compositeMat: THREE.ShaderMaterial;
  private pointsMat: THREE.ShaderMaterial;
  private updateScene: THREE.Scene;
  private fadeScene: THREE.Scene;
  private compositeScene: THREE.Scene;
  private pointsScene: THREE.Scene;

  private trailRead: THREE.WebGLRenderTarget;
  private trailWrite: THREE.WebGLRenderTarget;
  private prevCamMatrix = new THREE.Matrix4();
  private currentFade = MOVING_FADE; // 起動直後は控えめから滑らかに立ち上げる

  static isSupported(renderer: THREE.WebGLRenderer): boolean {
    return renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
  }

  constructor(
    renderer: THREE.WebGLRenderer,
    wind: WindUniforms,
    stateSize: number, // 粒子数 = stateSize^2
    particleRadius: number,
    globeRadius: number,
  ) {
    this.renderer = renderer;

    // 初期状態: 一様分布 (UPDATE_FS の再配置と同じ緯度分布) + 寿命をばらけさせる
    const count = stateSize * stateSize;
    const init = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const maxAge = 120 + Math.random() * 360;
      init[i * 4 + 1] = randomParticleLat();
      init[i * 4] = Math.random() * 360 - 180;
      init[i * 4 + 2] = Math.random() * maxAge;
      init[i * 4 + 3] = maxAge;
    }
    this.initTexture = new THREE.DataTexture(
      init,
      stateSize,
      stateSize,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.initTexture.minFilter = THREE.NearestFilter;
    this.initTexture.magFilter = THREE.NearestFilter;
    this.initTexture.needsUpdate = true;
    this.uState.value = this.initTexture;

    this.stateRead = makeStateTarget(stateSize);
    this.stateWrite = makeStateTarget(stateSize);

    this.updateMat = new THREE.ShaderMaterial({
      uniforms: {
        ...wind,
        uState: this.uState,
        uK: { value: BASE_DEG_PER_FRAME },
        uTime: { value: 0 },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: UPDATE_FS,
      depthTest: false,
      depthWrite: false,
    });
    this.updateScene = makeQuadScene(this.updateMat);

    this.fadeMat = new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null },
        uFade: { value: this.trailFade },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: FADE_FS,
      depthTest: false,
      depthWrite: false,
    });
    this.fadeScene = makeQuadScene(this.fadeMat);

    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: { uTrail: { value: null }, uBrightness: { value: this.brightness } },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: COMPOSITE_FS,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    });
    this.compositeScene = makeQuadScene(this.compositeMat);

    // 粒子 (1 頂点 = 1 粒子、position.xy = 状態テクスチャの UV)
    const refs = new Float32Array(count * 3);
    for (let j = 0; j < stateSize; j++) {
      for (let i = 0; i < stateSize; i++) {
        const idx = (j * stateSize + i) * 3;
        refs[idx] = (i + 0.5) / stateSize;
        refs[idx + 1] = (j + 0.5) / stateSize;
      }
    }
    const pointsGeo = new THREE.BufferGeometry();
    pointsGeo.setAttribute('position', new THREE.BufferAttribute(refs, 3));
    this.pointsMat = new THREE.ShaderMaterial({
      uniforms: {
        ...wind,
        uState: this.uState,
        uPointSize: { value: Math.max(1, renderer.getPixelRatio()) },
        uRadius: { value: particleRadius },
      },
      vertexShader: POINT_VS,
      fragmentShader: POINT_FS,
      transparent: true,
      blending: THREE.NormalBlending,
      depthTest: true,
      depthWrite: false,
    });
    const points = new THREE.Points(pointsGeo, this.pointsMat);
    points.frustumCulled = false;
    points.renderOrder = 1;

    // 蓄積バッファ内で裏側を隠すための深度専用の地球
    const depthGlobe = new THREE.Mesh(
      new THREE.SphereGeometry(globeRadius, 64, 36),
      new THREE.MeshBasicMaterial({ colorWrite: false }),
    );
    depthGlobe.renderOrder = 0;

    this.pointsScene = new THREE.Scene();
    this.pointsScene.add(depthGlobe);
    this.pointsScene.add(points);

    const { trailA, trailB } = this.makeTrailTargets();
    this.trailRead = trailA;
    this.trailWrite = trailB;
  }

  private makeTrailTargets(): { trailA: THREE.WebGLRenderTarget; trailB: THREE.WebGLRenderTarget } {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const make = () => {
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: true,
        stencilBuffer: false,
      });
      rt.texture.generateMipmaps = false;
      return rt;
    };
    const trailA = make();
    const trailB = make();
    // 未初期化のテクスチャを読まないよう明示的にクリアしておく
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(trailA);
    this.renderer.clear(true, true, false);
    this.renderer.setRenderTarget(trailB);
    this.renderer.clear(true, true, false);
    this.renderer.setRenderTarget(prev);
    return { trailA, trailB };
  }

  // 毎フレーム、メインシーンの描画前に呼ぶ
  update(camera: THREE.PerspectiveCamera): void {
    const renderer = this.renderer;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // 1) 粒子状態の更新 (ping-pong)
    this.updateMat.uniforms.uK.value = BASE_DEG_PER_FRAME * this.speedFactor;
    this.updateMat.uniforms.uTime.value = (performance.now() - this.startTime) / 1000;
    renderer.setRenderTarget(this.stateWrite);
    renderer.render(this.updateScene, this.quadCam);
    [this.stateRead, this.stateWrite] = [this.stateWrite, this.stateRead];
    this.uState.value = this.stateRead.texture;
    if (this.initTexture) {
      this.initTexture.dispose();
      this.initTexture = null;
    }

    // 2) 軌跡の蓄積: 前フレームを減衰コピー → 地球の深度 → 粒子を点描
    // カメラ移動判定は完全一致ではなく許容誤差付きで行う。
    // ダンピングによるサブピクセルの動きを「移動中」と誤判定すると、
    // 静止した瞬間に減衰率が急変して明度が跳ねるため
    camera.updateMatrixWorld();
    const e1 = this.prevCamMatrix.elements;
    const e2 = camera.matrixWorld.elements;
    let moving = false;
    for (let i = 0; i < 16 && !moving; i++) {
      if (Math.abs(e1[i] - e2[i]) > 1e-4) {
        moving = true;
      }
    }
    this.prevCamMatrix.copy(camera.matrixWorld);
    const targetFade = moving ? Math.min(this.trailFade, MOVING_FADE) : this.trailFade;
    // 動き始めは即座に強い減衰へ、停止後は緩やかに戻して明度の急変を防ぐ
    this.currentFade =
      targetFade < this.currentFade
        ? targetFade
        : this.currentFade + (targetFade - this.currentFade) * 0.02;
    this.fadeMat.uniforms.uFade.value = this.currentFade;
    this.fadeMat.uniforms.uPrev.value = this.trailRead.texture;

    renderer.setRenderTarget(this.trailWrite);
    renderer.clear(true, true, false);
    renderer.render(this.fadeScene, this.quadCam);
    renderer.render(this.pointsScene, camera);
    [this.trailRead, this.trailWrite] = [this.trailWrite, this.trailRead];

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  // メインシーンの描画後に呼び、蓄積した軌跡を画面に加算合成する
  composite(): void {
    const renderer = this.renderer;
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.compositeMat.uniforms.uTrail.value = this.trailRead.texture;
    this.compositeMat.uniforms.uBrightness.value = this.brightness;
    renderer.render(this.compositeScene, this.quadCam);
    renderer.autoClear = prevAutoClear;
  }

  resize(): void {
    this.pointsMat.uniforms.uPointSize.value = Math.max(1, this.renderer.getPixelRatio());
    this.trailRead.dispose();
    this.trailWrite.dispose();
    const { trailA, trailB } = this.makeTrailTargets();
    this.trailRead = trailA;
    this.trailWrite = trailB;
  }
}
