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
import { WindField } from './wind';
import { type ColorStops } from './particles';
import { PROJECT_GLSL, MAX_MERC_LAT, MAX_MERC_Y } from './projection';
import {
  createWindDataTexture,
  createSpeedRampTexture,
  writeWindInterp,
  RAMP_MAX_SPEED,
} from './wind-texture';

const BASE_DEG_PER_FRAME = 0.03; // 風速 1 m/s あたりの 1 フレーム移動量(度)
const MOVING_FADE = 0.82; // カメラ操作中は軌跡を速く消してスミアを抑える

const QUAD_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// 粒子状態の更新。state = (lon, lat, age, maxAge)
const UPDATE_FS = /* glsl */ `
precision highp float;
uniform sampler2D uState;
uniform sampler2D uWind;
uniform vec4 uGrid;     // lo1, la1, dx, dy
uniform vec2 uGridSize; // nx, ny
uniform float uK;       // 度/フレーム per m/s
uniform float uTime;
uniform float uMorph;   // 地球儀 (0) ⇔ メルカトル平面 (1)
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

vec2 windAt(vec2 lonlat) {
  float c = mod(lonlat.x - uGrid.x, 360.0) / uGrid.z;
  float r = (uGrid.y - lonlat.y) / uGrid.w;
  return texture2D(uWind, vec2((c + 0.5) / uGridSize.x, (r + 0.5) / uGridSize.y)).xy;
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

  if (age >= maxAge || abs(lonlat.y) > ${MAX_MERC_LAT.toFixed(1)}) {
    vec2 seed = vUv * 1.37 + fract(vec2(uTime * 0.1031, uTime * 0.0973));
    float r1 = hash(seed);
    float r2 = hash(seed + 19.19);
    float r3 = hash(seed + 47.47);
    // 緯度分布は表示に合わせてブレンドする:
    //   地球儀 = 球面上で一様 (sin(lat) を一様サンプリング)
    //   平面   = メルカトル地図上で一様 (メルカトル Y を一様サンプリングし逆変換)
    float u = r2 * 2.0 - 1.0;
    float latSphere = degrees(asin(u));
    float latMap = degrees(2.0 * atan(exp(u * ${MAX_MERC_Y.toFixed(6)})) - 1.5707963267948966);
    float lat = clamp(mix(latSphere, latMap, uMorph), -${MAX_MERC_LAT.toFixed(1)}, ${MAX_MERC_LAT.toFixed(1)});
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
${PROJECT_GLSL}
uniform sampler2D uState;
uniform sampler2D uWind;
uniform vec4 uGrid;
uniform vec2 uGridSize;
uniform float uPointSize;
uniform float uRadius;
uniform float uMorph;
uniform float uCenterLon; // 地図の中央経度。位置は表示経度 (実経度 - 中央経度) で計算する
varying float vSpeed;
varying float vLife;

vec2 windAt(vec2 lonlat) {
  float c = mod(lonlat.x - uGrid.x, 360.0) / uGrid.z;
  float r = (uGrid.y - lonlat.y) / uGrid.w;
  return texture2D(uWind, vec2((c + 0.5) / uGridSize.x, (r + 0.5) / uGridSize.y)).xy;
}

void main() {
  vec4 st = texture2D(uState, position.xy);
  vSpeed = length(windAt(st.xy));
  // 出現・消滅が急に見えないよう、寿命の出入りで明るさを絞る
  vLife = clamp(min(st.z / 8.0, (st.w - st.z) / 24.0), 0.0, 1.0);

  float dlon = windmapWrapLon(st.x - uCenterLon);
  float phi = (dlon + 180.0) * 0.017453292519943295;
  float theta = (90.0 - st.y) * 0.017453292519943295;
  vec3 p = vec3(-cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta)) * uRadius;
  p = windmapMorphPos(p, vec2(dlon, st.y), uRadius, uMorph);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uPointSize;
}
`;

// 蓄積バッファ内で裏側の粒子を隠す深度専用の地球 (モーフ対応)。
// SphereGeometry の UV から経緯度を復元して地表と同じ形に変形する
const DEPTH_VS = /* glsl */ `
${PROJECT_GLSL}
uniform float uMorph;
void main() {
  vec2 lonlat = vec2(uv.x * 360.0 - 180.0, uv.y * 180.0 - 90.0);
  vec3 p = windmapMorphPos(position, lonlat, length(position), uMorph);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const DEPTH_FS = /* glsl */ `
void main() {
  gl_FragColor = vec4(0.0);
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
  private readonly uWind = { value: null as THREE.Texture | null };
  private readonly uGrid = { value: new THREE.Vector4() };
  private readonly uGridSize = { value: new THREE.Vector2() };
  private readonly uMorph = { value: 0 }; // 地球儀 (0) ⇔ メルカトル平面 (1)
  private readonly uCenterLon = { value: 0 }; // 地図の中央経度
  private morphMoving = false; // モーフ・中央経度の変更中は軌跡を速く消してスミアを抑える

  private stateRead: THREE.WebGLRenderTarget;
  private stateWrite: THREE.WebGLRenderTarget;
  private initTexture: THREE.DataTexture | null;
  private windTexture: THREE.DataTexture | null = null;
  private rampTexture: THREE.DataTexture;

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
    wind: WindField,
    stateSize: number, // 粒子数 = stateSize^2
    particleRadius: number,
    globeRadius: number,
    initialMorph = 0, // 平面表示中の再構築でも密度が合うよう、初期分布にも反映する
  ) {
    this.renderer = renderer;
    this.rampTexture = createSpeedRampTexture();
    this.uMorph.value = initialMorph;

    // 初期状態: 一様分布 (UPDATE_FS の再配置と同じ緯度分布) + 寿命をばらけさせる
    const count = stateSize * stateSize;
    const init = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const maxAge = 120 + Math.random() * 360;
      const u = Math.random() * 2 - 1;
      const latSphere = (Math.asin(u) * 180) / Math.PI;
      const latMap = ((2 * Math.atan(Math.exp(u * MAX_MERC_Y)) - Math.PI / 2) * 180) / Math.PI;
      const lat = latSphere + (latMap - latSphere) * initialMorph;
      init[i * 4] = Math.random() * 360 - 180;
      init[i * 4 + 1] = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat));
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

    this.setWind(wind);

    this.updateMat = new THREE.ShaderMaterial({
      uniforms: {
        uState: this.uState,
        uWind: this.uWind,
        uGrid: this.uGrid,
        uGridSize: this.uGridSize,
        uK: { value: BASE_DEG_PER_FRAME },
        uTime: { value: 0 },
        uMorph: this.uMorph,
      },
      vertexShader: QUAD_VS,
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
      vertexShader: QUAD_VS,
      fragmentShader: FADE_FS,
      depthTest: false,
      depthWrite: false,
    });
    this.fadeScene = makeQuadScene(this.fadeMat);

    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: { uTrail: { value: null }, uBrightness: { value: this.brightness } },
      vertexShader: QUAD_VS,
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
        uState: this.uState,
        uWind: this.uWind,
        uGrid: this.uGrid,
        uGridSize: this.uGridSize,
        uRamp: { value: this.rampTexture },
        uPointSize: { value: Math.max(1, renderer.getPixelRatio()) },
        uRadius: { value: particleRadius },
        uMorph: this.uMorph,
        uCenterLon: this.uCenterLon,
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
    // heightSegments はメルカトルモーフのクランプ位置 (±85°) に頂点行が乗るよう 36 の倍数
    const depthGlobe = new THREE.Mesh(
      new THREE.SphereGeometry(globeRadius, 64, 36),
      new THREE.ShaderMaterial({
        uniforms: { uMorph: this.uMorph },
        vertexShader: DEPTH_VS,
        fragmentShader: DEPTH_FS,
        colorWrite: false,
      }),
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

  setColorStops(stops: ColorStops): void {
    const tex = createSpeedRampTexture(stops);
    this.rampTexture.dispose();
    this.rampTexture = tex;
    this.pointsMat.uniforms.uRamp.value = tex;
  }

  // 地球儀 (0) ⇔ メルカトル平面 (1) のモーフ量
  setMorph(morph: number): void {
    if (Math.abs(morph - this.uMorph.value) > 1e-4) this.morphMoving = true;
    this.uMorph.value = morph;
  }

  // 地図の中央経度。全粒子の表示位置が変わるので軌跡もリセット扱いにする
  setCenterLon(centerLon: number): void {
    if (centerLon !== this.uCenterLon.value) this.morphMoving = true;
    this.uCenterLon.value = centerLon;
  }

  setWind(wind: WindField): void {
    const tex = createWindDataTexture(wind);
    this.windTexture?.dispose();
    this.windTexture = tex;
    this.uWind.value = tex;
    this.uGrid.value.set(wind.lo1, wind.la1, wind.dx, wind.dy);
    this.uGridSize.value.set(wind.nx, wind.ny);
  }

  // 2 フレームを時間補間した風場をその場で反映する(再生の補間用)
  setWindInterp(a: WindField, b: WindField, t: number): void {
    if (!this.windTexture || this.uGridSize.value.x !== a.nx || this.uGridSize.value.y !== a.ny) {
      this.setWind(a);
    }
    writeWindInterp(this.windTexture!, a, b, t);
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
    let moving = this.morphMoving; // モーフ中も点が動くのでカメラ移動と同じ扱い
    this.morphMoving = false;
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
    this.trailRead.dispose();
    this.trailWrite.dispose();
    const { trailA, trailB } = this.makeTrailTargets();
    this.trailRead = trailA;
    this.trailWrite = trailB;
  }

  dispose(): void {
    this.stateRead.dispose();
    this.stateWrite.dispose();
    this.trailRead.dispose();
    this.trailWrite.dispose();
    this.initTexture?.dispose();
    this.windTexture?.dispose();
    this.rampTexture.dispose();
    for (const scene of [this.updateScene, this.fadeScene, this.compositeScene, this.pointsScene]) {
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Points) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
    }
  }
}
