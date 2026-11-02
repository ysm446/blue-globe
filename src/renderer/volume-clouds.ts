// 地域ビューの立体の雲。衛星の雲マップから広がりを、濃さから高さを決め、細かい形はノイズで作る。
// 視線に沿って厚みをたどるので重い。解像度を下げて別に描き、それを画面へ重ねる。
// 地球が唯一の遮るものなので、奥行きのバッファは使わず球との交点を計算で求める。
// 太陽から見た雲の濃さを画像に焼き込み、地面の影と、遠くの雲が別の雲に落とす影に使う
import * as THREE from 'three';
import { CLOUD_NOISE_SIZE, createCloudNoise } from './cloud-noise';
import { needsShadowBake, shadowBasis, shadowHalfSize, type ShadowBake } from './cloud-shadow';
import { CLOUD_SUN_COLOR_GLSL, FULLSCREEN_VS, PIXEL_JITTER_GLSL } from './glsl';
import type { Vec3 } from './math';

const RESOLUTION_SCALE = 0.5;
const CLOUD_BASE = 0.0005; // 約 3km
const CLOUD_TOP = 0.0045; // 約 29km。実際の 2 倍ほどあり、遠くから見ても起伏が分かるように誇張している
const SHAPE_PERIOD = 0.03; // 大きなかたまりのノイズが繰り返す長さ (約 190km)
const DETAIL_PERIOD = 0.007; // 細かいかたまりのノイズが繰り返す長さ (約 45km)
const SWELL_PERIOD = 0.083; // 雲頂の大きなうねりの周期 (約 530km)。他の周期の整数倍にしない
const WARP_PERIOD = 0.02;
const WARP_AMOUNT = 0.003; // 雲マップの画素の四角が見えないよう、引く位置を約 10km までずらす
const EXTINCTION = 900; // 地球の半径 1 あたりの光の通りにくさ
const CLOUD_MAP_TEXEL = (2 * Math.PI) / 4096;
const SHADOW_MAP_SIZE = 1024;
const SHADOW_STEPS = 40;
const SHADOW_MIN_STRIDE = 0.00015;
const FAR_SHADOW_START = 0.003; // 太陽の方向へ歩いて確かめる距離 (約 0.0045) の手前から、焼き込んだ影に引き継ぐ
const FAR_SHADOW_FULL = 0.0055;
const NO_CLOUD_DEPTH = -2; // 雲がない画素の深さ。どの点よりも地球の側にして、影を落とさない

// 雲マップは左端が経度 -180 度、1 行目が北端
export const CLOUD_UV_GLSL = /* glsl */ `
vec2 cloudUvOf(vec3 n) {
  float angle = atan(n.z, -n.x);
  float u = angle / 6.28318530718 + (angle < 0.0 ? 1.0 : 0.0);
  return vec2(u, 0.5 - asin(clamp(n.y, -1.0, 1.0)) / 3.14159265359);
}
`;

// 太陽から見た雲の濃さの画像を引く。地球の描画と立体の雲で共有する
export const BAKED_SHADOW_GLSL = /* glsl */ `
uniform sampler2D uBakedShadow;
uniform vec3 uBakeCenter;
uniform vec3 uBakeU;
uniform vec3 uBakeV;
vec2 bakedUvOf(vec3 fromCenter) {
  return vec2(dot(fromCenter, uBakeU), dot(fromCenter, uBakeV)) * 0.5 + 0.5;
}
// 範囲の中で 1、外で 0。端の手前からなめらかに変わる
float bakedCoverage(vec2 uv) {
  vec2 edge = abs(uv - 0.5) * 2.0;
  return smoothstep(1.0, 0.9, max(edge.x, edge.y));
}
`;

// 雲を描く処理と、影を焼く処理で同じ形を使う
const CLOUD_SHAPE_GLSL = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D uCloud;
uniform sampler3D uNoise;
uniform vec3 uSunDir;
uniform float uRadius;
${CLOUD_UV_GLSL}
${PIXEL_JITTER_GLSL}

const float BASE = ${CLOUD_BASE.toFixed(5)};
const float TOP = ${CLOUD_TOP.toFixed(5)};
const float SIGMA = ${EXTINCTION.toFixed(1)};

float cloudLod;
float shapeLod;
float detailLod;
float columnTop; // 最後に調べた点の雲頂の高さ (0〜1)

// 遠いほど 1 画素が広いので、粗いノイズで足りる
void setFootprint(float footprint) {
  cloudLod = max(log2(footprint / ${CLOUD_MAP_TEXEL.toFixed(6)}), 0.0);
  shapeLod = max(log2(footprint * ${(CLOUD_NOISE_SIZE / SHAPE_PERIOD).toFixed(1)}), 0.0);
  detailLod = max(log2(footprint * ${(CLOUD_NOISE_SIZE / DETAIL_PERIOD).toFixed(1)}), 0.0);
}

// 球との交点。当たらなければ x が y より大きい
vec2 hitSphere(vec3 origin, vec3 ray, float radius) {
  float along = dot(origin, ray);
  float gap = along * along - dot(origin, origin) + radius * radius;
  if (gap < 0.0) return vec2(1.0, -1.0);
  float half_ = sqrt(gap);
  return vec2(-along - half_, -along + half_);
}

// 濃い雲ほど高くまで積もる。雲マップの形を保つよう、ノイズは縁と雲頂を削るだけにする
float densityAt(vec3 p, bool withDetail) {
  float r = length(p);
  vec3 up = p / r;
  float h = (r - uRadius - BASE) / (TOP - BASE);
  vec2 warp = textureLod(uNoise, p / ${WARP_PERIOD.toFixed(3)}, shapeLod + 1.0).rg - 0.5;
  vec3 warped = normalize(up + vec3(warp.x, warp.y, warp.x - warp.y) * ${WARP_AMOUNT.toFixed(4)});
  float cover = textureLod(uCloud, cloudUvOf(warped), cloudLod).r;
  if (cover < 0.015) return 0.0;
  float shape = textureLod(uNoise, p / ${SHAPE_PERIOD.toFixed(3)}, shapeLod).r;
  // 雲頂の高さをノイズで変え、厚い雲の上面にも起伏を作る。粒が規則的に並ばないよう、長い周期のノイズも混ぜる
  float swell = textureLod(uNoise, p / ${SWELL_PERIOD.toFixed(3)}, shapeLod).r;
  columnTop = mix(0.3, 1.0, smoothstep(0.2, 0.9, cover)) * mix(0.5, 1.0, smoothstep(0.2, 0.85, shape * 0.5 + swell * 0.5));
  float profile = smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(columnTop * 0.6, columnTop, h));
  if (profile <= 0.0) return 0.0;
  float erosion = (1.0 - shape) * mix(0.5, 0.25, cover);
  float body = clamp((sqrt(cover) * profile * 1.6 - erosion) / 0.3, 0.0, 1.0);
  if (withDetail && body > 0.0) {
    float detail = textureLod(uNoise, p / ${DETAIL_PERIOD.toFixed(3)}, detailLod).g;
    body = max(body - (1.0 - detail) * 0.35 * (1.0 - body), 0.0);
  }
  return body * mix(0.3, 1.0, smoothstep(0.0, 0.6, cover)); // 薄い雲は地面が透ける
}
`;

// 太陽に垂直な面の各画素から、太陽の反対へ雲を通り抜ける。
// 1 つ目の成分は通り抜けた光の割合、2 つ目は最初に雲に当たった位置 (太陽の方向の座標)
const BAKE_FS = /* glsl */ `
${CLOUD_SHAPE_GLSL}
uniform vec3 uBakeCenter;
uniform vec3 uBakeAxisU;
uniform vec3 uBakeAxisV;
uniform float uBakeFootprint;
varying vec2 vUv;

void main() {
  vec2 plane = vUv * 2.0 - 1.0;
  vec3 origin = uBakeCenter + uBakeAxisU * plane.x + uBakeAxisV * plane.y + uSunDir * 2.0;
  vec3 ray = -uSunDir;
  vec2 shell = hitSphere(origin, ray, uRadius + TOP);
  if (shell.x > shell.y) {
    gl_FragColor = vec4(1.0, ${NO_CLOUD_DEPTH.toFixed(1)}, 0.0, 1.0);
    return;
  }
  vec2 ground = hitSphere(origin, ray, uRadius + BASE);
  float end = ground.x <= ground.y ? ground.x : shell.y;
  setFootprint(uBakeFootprint);

  float stride = max((end - shell.x) / ${SHADOW_STEPS.toFixed(1)}, ${SHADOW_MIN_STRIDE.toFixed(5)});
  float t = shell.x + stride * pixelJitter();
  float tau = 0.0;
  float front = ${NO_CLOUD_DEPTH.toFixed(1)};
  for (int i = 0; i < ${SHADOW_STEPS} && t < end && tau < 6.0; i++) {
    vec3 p = origin + ray * t;
    tau += densityAt(p, false) * SIGMA * stride;
    if (front == ${NO_CLOUD_DEPTH.toFixed(1)} && tau > 0.1) front = dot(p - uBakeCenter, uSunDir);
    t += stride;
  }
  gl_FragColor = vec4(exp(-tau), front, 0.0, 1.0);
}
`;

const MARCH_FS = /* glsl */ `
${CLOUD_SHAPE_GLSL}
${BAKED_SHADOW_GLSL}
${CLOUD_SUN_COLOR_GLSL}
uniform mat4 uViewToWorld;
uniform float uPixelAngle;
uniform float uAmount;
uniform float uHaze;
varying vec2 vUv;

const int MAX_STEPS = 64;

// 太陽の方向へたどり、途中の雲に遮られずに届く光の割合を求める
float sunlightAt(vec3 p) {
  float depth = 0.0;
  float reach = 0.0;
  float stride = 0.0003;
  for (int i = 0; i < 4; i++) {
    reach += stride;
    depth += densityAt(p + uSunDir * reach, false) * stride;
    stride *= 2.0;
  }
  float tau = depth * SIGMA;
  // 雲の中で何度も散乱した光があるので、厚いところでも真っ黒にはならない
  return max(exp(-tau), 0.45 * exp(-tau * 0.25));
}

// たどった距離より遠くの雲が落とす影。太陽が低いと、高い雲の影が遠くの雲に届く
float farShadowAt(vec3 p) {
  vec3 fromCenter = p - uBakeCenter;
  vec2 uv = bakedUvOf(fromCenter);
  float inside = bakedCoverage(uv);
  if (inside <= 0.0) return 1.0;
  vec2 baked = textureLod(uBakedShadow, uv, 0.0).rg;
  float below = baked.g - dot(fromCenter, uSunDir);
  float occluded = smoothstep(${FAR_SHADOW_START.toFixed(4)}, ${FAR_SHADOW_FULL.toFixed(4)}, below);
  return mix(1.0, max(baked.r, 0.45), occluded * inside);
}

void main() {
  vec4 far = uViewToWorld * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 origin = cameraPosition;
  vec3 ray = normalize(far.xyz / far.w - origin);
  vec2 shell = hitSphere(origin, ray, uRadius + TOP);
  if (shell.x > shell.y || shell.y < 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float start = max(shell.x, 0.0);
  vec2 ground = hitSphere(origin, ray, uRadius + BASE);
  float end = ground.x <= ground.y && ground.x > 0.0 ? ground.x : shell.y;
  setFootprint(start * uPixelAngle);

  // 歩幅の刻みが縞に見えないよう、始点を画素ごとにずらす
  float stride = clamp(start * 0.002, 0.0002, 0.004);
  float t = start + stride * pixelJitter();
  float transmit = 1.0;
  vec3 color = vec3(0.0);
  for (int i = 0; i < MAX_STEPS && t < end && transmit > 0.01; i++) {
    vec3 p = origin + ray * t;
    float density = densityAt(p, true);
    if (density > 0.0) {
      float opacity = 1.0 - exp(-density * SIGMA * stride * uAmount);
      vec3 up = normalize(p);
      float ndl = dot(up, uSunDir);
      // 雲頂を 1 とした高さ。低い雲も上面は明るくなる
      float h = clamp((length(p) - uRadius - BASE) / (TOP - BASE) / columnTop, 0.0, 1.0);
      float dayLight = smoothstep(-0.06, 0.5, ndl);
      float sunlight = dayLight > 0.0 ? sunlightAt(p) * farShadowAt(p) : 0.0;
      // 地球ビューの雲と同じ色合い。影の部分は黒くせず、空の光を受けた青灰色にする
      // 低いところほど周りの雲に光を遮られる。厚い雲の上面の起伏は、主にこの差で見える
      vec3 lit = mix(vec3(0.26, 0.31, 0.42), vec3(0.86), sunlight) * mix(0.48, 1.1, smoothstep(0.1, 0.85, h));
      vec3 sample_ = lit * cloudSunColor(ndl) * dayLight + vec3(0.016, 0.021, 0.036);
      color += transmit * opacity * sample_;
      transmit *= 1.0 - opacity;
    }
    t += stride;
  }

  // 地平線の近くは粗くなるので薄く消し、大気の青を重ねる
  vec3 surface = normalize(origin + ray * start);
  float facing = max(dot(surface, -ray), 0.0);
  float limb = smoothstep(0.0, 0.14, facing);
  float alpha = (1.0 - transmit) * limb;
  float haze = pow(1.0 - facing, 3.2) * smoothstep(-0.15, 0.45, dot(surface, uSunDir)) * 0.7 * uHaze;
  gl_FragColor = vec4(color * limb + vec3(0.16, 0.36, 0.8) * haze * alpha, alpha);
}
`;

const COMPOSITE_FS = /* glsl */ `
precision highp float;
uniform sampler2D uVolume;
uniform vec2 uSize;
void main() {
  // 始点をずらした粒が見えないよう、周囲の 4 点をならす
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 texel = ${(0.75 / RESOLUTION_SCALE).toFixed(2)} / uSize;
  gl_FragColor = 0.25 * (
    texture2D(uVolume, uv + vec2(texel.x, texel.y)) +
    texture2D(uVolume, uv + vec2(-texel.x, texel.y)) +
    texture2D(uVolume, uv + vec2(texel.x, -texel.y)) +
    texture2D(uVolume, uv + vec2(-texel.x, -texel.y))
  );
}
`;

export class VolumeClouds {
  // 雲の球の代わりに画面全体へ重ねる面。地球の後ろへ描かれないよう、深度は見ない
  readonly mesh: THREE.Mesh;
  // 地面の影を引くために、地球の描画と共有する
  readonly bakeUniforms = {
    uBakedShadow: { value: null as THREE.Texture | null },
    uBakeCenter: { value: new THREE.Vector3() },
    uBakeU: { value: new THREE.Vector3() }, // 範囲の端で 1 になるよう、範囲の大きさで割ってある
    uBakeV: { value: new THREE.Vector3() },
  };
  private readonly sunDir: THREE.Vector3;
  private readonly marchScene = new THREE.Scene();
  private readonly marchMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly bakeScene = new THREE.Scene();
  private readonly bakeMaterial: THREE.ShaderMaterial;
  private readonly bakeTarget: THREE.WebGLRenderTarget;
  private readonly bufferSize = new THREE.Vector2();
  private readonly clearColor = new THREE.Color();
  private noise: THREE.Data3DTexture | null = null;
  private baked: ShadowBake | null = null;
  private cloudVersion = 0;
  private focus: Vec3 = [0, 0, 1];
  private focusDistance = 1;

  constructor(radius: number, sunDir: THREE.Vector3, haze: { value: number }) {
    this.sunDir = sunDir;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
    this.bakeTarget = new THREE.WebGLRenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, {
      type: THREE.HalfFloatType,
      format: THREE.RGFormat,
      depthBuffer: false,
    });
    this.bakeUniforms.uBakedShadow.value = this.bakeTarget.texture;
    const quad = new THREE.PlaneGeometry(2, 2);
    this.marchMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCloud: { value: null },
        uNoise: { value: null },
        uViewToWorld: { value: new THREE.Matrix4() },
        uSunDir: { value: sunDir },
        uRadius: { value: radius },
        uPixelAngle: { value: 0 },
        uAmount: { value: 0 },
        uHaze: haze,
        ...this.bakeUniforms,
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: MARCH_FS,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const marchMesh = new THREE.Mesh(quad, this.marchMaterial);
    marchMesh.frustumCulled = false;
    this.marchScene.add(marchMesh);

    this.bakeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCloud: this.marchMaterial.uniforms.uCloud,
        uNoise: this.marchMaterial.uniforms.uNoise,
        uSunDir: { value: sunDir },
        uRadius: { value: radius },
        uBakeCenter: this.bakeUniforms.uBakeCenter,
        uBakeAxisU: { value: new THREE.Vector3() },
        uBakeAxisV: { value: new THREE.Vector3() },
        uBakeFootprint: { value: 0 },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: BAKE_FS,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    const bakeMesh = new THREE.Mesh(quad, this.bakeMaterial);
    bakeMesh.frustumCulled = false;
    this.bakeScene.add(bakeMesh);

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uVolume: { value: this.target.texture },
        uSize: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: FULLSCREEN_VS,
      fragmentShader: COMPOSITE_FS,
      transparent: true,
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(quad, this.compositeMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2; // 海岸線より上に重ねる
    this.mesh.visible = false;
  }

  setCloudTexture(texture: THREE.Texture): void {
    this.marchMaterial.uniforms.uCloud.value = texture;
    this.cloudVersion++;
  }

  // amount は 0 で見えず、1 で本来の濃さ。厚みに掛けるので、厚い雲から先に見え始める
  setAmount(amount: number): void {
    this.mesh.visible = amount > 0;
    this.marchMaterial.uniforms.uAmount.value = amount;
  }

  // 影を焼く範囲の中心にする地表の点と、そこからカメラまでの距離
  setShadowFocus(center: THREE.Vector3, distance: number): void {
    this.focus = [center.x, center.y, center.z];
    this.focusDistance = distance;
  }

  get shadowReady(): boolean {
    return this.baked !== null;
  }

  private ensureNoise(): void {
    if (this.noise) return;
    const texture = new THREE.Data3DTexture(
      createCloudNoise(),
      CLOUD_NOISE_SIZE,
      CLOUD_NOISE_SIZE,
      CLOUD_NOISE_SIZE,
    );
    texture.format = THREE.RGFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.wrapR = THREE.RepeatWrapping;
    texture.generateMipmaps = true;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    this.noise = texture;
    this.marchMaterial.uniforms.uNoise.value = texture;
  }

  private bakeShadow(renderer: THREE.WebGLRenderer, camera: THREE.Camera, bake: ShadowBake): void {
    const { u, v } = shadowBasis(bake.sun);
    const size = bake.halfSize;
    this.bakeUniforms.uBakeCenter.value.set(...bake.center);
    this.bakeUniforms.uBakeU.value.set(...u).divideScalar(size);
    this.bakeUniforms.uBakeV.value.set(...v).divideScalar(size);
    const { uniforms } = this.bakeMaterial;
    uniforms.uBakeAxisU.value.set(...u).multiplyScalar(size);
    uniforms.uBakeAxisV.value.set(...v).multiplyScalar(size);
    uniforms.uBakeFootprint.value = (2 * size) / SHADOW_MAP_SIZE;
    renderer.setRenderTarget(this.bakeTarget);
    renderer.render(this.bakeScene, camera);
    this.baked = bake;
  }

  // 画面を描く前に毎フレーム呼ぶ。見えていないときは何もしない
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    if (!this.mesh.visible) return;
    this.ensureNoise();
    renderer.getDrawingBufferSize(this.bufferSize);
    const width = Math.max(1, Math.ceil(this.bufferSize.x * RESOLUTION_SCALE));
    const height = Math.max(1, Math.ceil(this.bufferSize.y * RESOLUTION_SCALE));
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    this.compositeMaterial.uniforms.uSize.value.copy(this.bufferSize);

    camera.updateMatrixWorld();
    const { uniforms } = this.marchMaterial;
    uniforms.uViewToWorld.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    uniforms.uPixelAngle.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height;

    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearColor);
    renderer.setClearColor(0x000000, 0);
    const wanted: ShadowBake = {
      center: this.focus,
      halfSize: shadowHalfSize(this.focusDistance),
      sun: [this.sunDir.x, this.sunDir.y, this.sunDir.z],
      cloudVersion: this.cloudVersion,
    };
    if (needsShadowBake(this.baked, wanted)) this.bakeShadow(renderer, camera, wanted);
    renderer.setRenderTarget(this.target);
    renderer.render(this.marchScene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(this.clearColor, previousAlpha);
  }
}
