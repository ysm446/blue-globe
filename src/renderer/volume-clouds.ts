// 地域ビューの立体の雲。衛星の雲マップから広がりを、濃さから高さを決め、細かい形はノイズで作る。
// 視線に沿って厚みをたどるので重い。解像度を下げて別に描き、それを画面へ重ねる。
// 地球が唯一の遮るものなので、奥行きのバッファは使わず球との交点を計算で求める
import * as THREE from 'three';
import { CLOUD_NOISE_SIZE, createCloudNoise } from './cloud-noise';

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

// 雲マップは左端が経度 -180 度、1 行目が北端
export const CLOUD_UV_GLSL = /* glsl */ `
vec2 cloudUvOf(vec3 n) {
  float angle = atan(n.z, -n.x);
  float u = angle / 6.28318530718 + (angle < 0.0 ? 1.0 : 0.0);
  return vec2(u, 0.5 - asin(clamp(n.y, -1.0, 1.0)) / 3.14159265359);
}
`;

const FULLSCREEN_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const MARCH_FS = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D uCloud;
uniform sampler3D uNoise;
uniform mat4 uViewToWorld;
uniform vec3 uSunDir;
uniform float uRadius;
uniform float uPixelAngle;
uniform float uAmount;
uniform float uHaze;
varying vec2 vUv;
${CLOUD_UV_GLSL}

const float BASE = ${CLOUD_BASE.toFixed(5)};
const float TOP = ${CLOUD_TOP.toFixed(5)};
const float SIGMA = ${EXTINCTION.toFixed(1)};
const int MAX_STEPS = 64;

float cloudLod;
float shapeLod;
float detailLod;
float columnTop; // 最後に調べた点の雲頂の高さ (0〜1)

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

  // 遠いほど 1 画素が広いので、粗いノイズと大きな歩幅で足りる
  float footprint = start * uPixelAngle;
  cloudLod = max(log2(footprint / ${CLOUD_MAP_TEXEL.toFixed(6)}), 0.0);
  shapeLod = max(log2(footprint * ${(CLOUD_NOISE_SIZE / SHAPE_PERIOD).toFixed(1)}), 0.0);
  detailLod = max(log2(footprint * ${(CLOUD_NOISE_SIZE / DETAIL_PERIOD).toFixed(1)}), 0.0);

  // 歩幅の刻みが縞に見えないよう、始点を画素ごとにずらす
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float stride = clamp(start * 0.002, 0.0002, 0.004);
  float t = start + stride * jitter;
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
      float dusk = smoothstep(-0.08, 0.02, ndl) * (1.0 - smoothstep(0.02, 0.28, ndl));
      vec3 sunColor = mix(vec3(1.0, 0.99, 0.97), vec3(1.0, 0.6, 0.36), dusk * 0.8);
      float sunlight = dayLight > 0.0 ? sunlightAt(p) : 0.0;
      // 地球ビューの雲と同じ色合い。影の部分は黒くせず、空の光を受けた青灰色にする
      // 低いところほど周りの雲に光を遮られる。厚い雲の上面の起伏は、主にこの差で見える
      vec3 lit = mix(vec3(0.26, 0.31, 0.42), vec3(0.86), sunlight) * mix(0.48, 1.1, smoothstep(0.1, 0.85, h));
      vec3 sample_ = lit * sunColor * dayLight + vec3(0.016, 0.021, 0.036);
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
  private readonly marchScene = new THREE.Scene();
  private readonly marchMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly bufferSize = new THREE.Vector2();
  private readonly clearColor = new THREE.Color();
  private noise: THREE.Data3DTexture | null = null;

  constructor(radius: number, sunDir: THREE.Vector3, haze: { value: number }) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
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
  }

  // amount は 0 で見えず、1 で本来の濃さ。厚みに掛けるので、厚い雲から先に見え始める
  setAmount(amount: number): void {
    this.mesh.visible = amount > 0;
    this.marchMaterial.uniforms.uAmount.value = amount;
  }

  private ensureNoise(): THREE.Data3DTexture {
    if (this.noise) return this.noise;
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
    return texture;
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
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.render(this.marchScene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(this.clearColor, previousAlpha);
  }
}
