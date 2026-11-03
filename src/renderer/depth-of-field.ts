// 被写界深度。線形 HDR のまま、ブルームとトーンマップの前に掛ける (明るい点が飽和する前にぼかすと玉ぼけになる)。
// 地球を直径「地球儀の大きさ」の模型に見立て (ミニチュアの縮尺)、実際のレンズの式で錯乱円を求める。
// レンズの側 (焦点距離、F 値、センサー) は現実のままで、場面の距離だけを縮める。焦点距離は画角から求め、二重に持たない。
// 奥行きは深度バッファを使わず、視線と地球の球の交点から計算する (大気や雲は深度を書かず、場面はほぼ球のため)。
// ぼかし方は、半分の解像度で円盤状に周りを集め (自分のぼけと、手前のぼけのはみ出しを分けて集める)、元の解像度の像と混ぜる。
// 小さなぼけは元の解像度で直接ぼかし、ピント面から離れるにつれて途切れずにぼけが増えるようにする
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { focalLengthForFov, sensorHeight, sphereRayDistance } from './camera-lens';
import { FULLSCREEN_VS } from './glsl';

const MAX_COC = 0.025; // ぼけの半径の上限 (画面の高さが 1)。大きくすると円盤の点の間が空いて粗く見える
const KERNEL_SIZE = 106; // 自分のぼけを集める円盤の点の数
const NEAR_SIZE = 48; // 手前のぼけのはみ出しを探す円盤の点の数
const FILL_SIZE = 24; // 点の間を埋めるときの点の数
const SMALL_SIZE = 16; // 小さなぼけを元の解像度でぼかすときの点の数
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// 円盤の点の間隔の、円盤の半径に対する割合
const KERNEL_SPACING = Math.sqrt(Math.PI / KERNEL_SIZE);
const NEAR_SPACING = Math.sqrt(Math.PI / NEAR_SIZE);
// 半分の解像度の結果へ移る、ぼけの半径の範囲 (元の解像度の画素)。これより小さいぼけは元の解像度でぼかす
const HALF_FROM = 3;
const HALF_TO = 6;

// 半径 1 の円盤の点。同心の輪に並べると明るい点のぼけに輪の模様が写るので、黄金角でずらしながら外へ広げる。
// 半径を平方根にして、面積あたりの点の数を揃える
function diskKernel(size: number): THREE.Vector2[] {
  return Array.from({ length: size }, (_, i) => {
    const radius = Math.sqrt((i + 0.5) / size);
    return new THREE.Vector2(Math.cos(i * GOLDEN_ANGLE) * radius, Math.sin(i * GOLDEN_ANGLE) * radius);
  });
}

const KERNEL = diskKernel(KERNEL_SIZE);
const NEAR_KERNEL = diskKernel(NEAR_SIZE);
const FILL_KERNEL = diskKernel(FILL_SIZE);
const SMALL_KERNEL = diskKernel(SMALL_SIZE);

// 画面の点の錯乱円。camera-lens.ts の sphereRayDistance と circleOfConfusion と同じ式
const COC_GLSL = /* glsl */ `
uniform mat4 uInverseProjection;
uniform mat3 uCameraRotation;
uniform vec3 uCameraPos;
uniform float uSphereRadius;
uniform float uSceneScale; // 場面の 1 単位が模型の上で何 m か
uniform float uFocalLength; // m
uniform float uAperture; // 絞りの口径 (m)。焦点距離 / F 値
uniform float uFocus; // ピントの合う距離 (m、模型の上)
uniform float uCocScale; // 錯乱円の直径 (m) を、上限を 1 とした半径にする倍率
float sphereRayDistance(vec3 origin, vec3 dir) {
  float b = dot(origin, dir);
  float c = dot(origin, origin) - uSphereRadius * uSphereRadius;
  float discriminant = b * b - c;
  if (b < 0.0 && discriminant >= 0.0) return -b - sqrt(discriminant);
  return sqrt(max(c, 0.0));
}
// 符号付きの錯乱円の半径。正は奥、負は手前のぼけで、上限を 1 とする
float cocAt(vec2 uv) {
  // カメラから見た向きはカメラの座標で求めてから回す (遠くの点からカメラの位置を引くと精度が落ちる)
  vec4 view = uInverseProjection * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec3 viewDir = normalize(view.xyz / view.w);
  // ピント面は平面なので、視線の長さではなく正面の奥行きで比べる
  float depth = sphereRayDistance(uCameraPos, uCameraRotation * viewDir) * -viewDir.z * uSceneScale;
  float near = uFocalLength + 0.001;
  float plane = max(uFocus, near);
  depth = max(depth, near);
  float coc = uAperture * uFocalLength * (depth - plane) / (depth * (plane - uFocalLength));
  return clamp(coc * uCocScale, -1.0, 1.0);
}
`;

function lensUniforms() {
  return {
    uInverseProjection: { value: new THREE.Matrix4() },
    uCameraRotation: { value: new THREE.Matrix3() },
    uCameraPos: { value: new THREE.Vector3() },
    uSphereRadius: { value: 1 },
    uSceneScale: { value: 1 },
    uFocalLength: { value: 0.024 },
    uAperture: { value: 0.006 },
    uFocus: { value: 1 },
    uCocScale: { value: 1 },
  };
}

type LensUniforms = ReturnType<typeof lensUniforms>;

function fullscreenMaterial(uniforms: Record<string, THREE.IUniform>, fragmentShader: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FULLSCREEN_VS,
    fragmentShader,
    defines: { KERNEL_SIZE, NEAR_SIZE, FILL_SIZE, SMALL_SIZE },
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
}

export class DepthOfFieldPass extends Pass {
  private readonly lens: LensUniforms = lensUniforms();
  private readonly quad = new FullScreenQuad();
  private readonly half: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly prefilter: THREE.ShaderMaterial;
  private readonly bokeh: THREE.ShaderMaterial;
  private readonly postfilter: THREE.ShaderMaterial;
  private readonly composite: THREE.ShaderMaterial;
  private fNumber = 4;
  private globeSize = 1;
  private readonly forward = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    sphereRadius: number,
  ) {
    super();
    this.lens.uSphereRadius.value = sphereRadius;
    const target = (): THREE.WebGLRenderTarget =>
      new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.half = [target(), target(), target()];

    // 半分の解像度へ縮める。4 点の色は、ぼけの大きい点ほど重く混ぜる。
    // 4 点のうち絶対値が最も大きい錯乱円を残す (a に画面の高さを 1 とした半径を入れる)
    this.prefilter = fullscreenMaterial(
      { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, ...this.lens },
      /* glsl */ `
      precision highp float;
      uniform sampler2D tColor;
      uniform vec2 uTexel;
      varying vec2 vUv;
      ${COC_GLSL}
      void main() {
        vec2 offsets[4] = vec2[4](vec2(-0.5, -0.5), vec2(0.5, -0.5), vec2(-0.5, 0.5), vec2(0.5, 0.5));
        vec3 sum = vec3(0.0);
        float weightSum = 0.0;
        float cocMin = 1.0;
        float cocMax = -1.0;
        for (int i = 0; i < 4; i++) {
          vec2 uv = vUv + offsets[i] * uTexel;
          float coc = cocAt(uv);
          float weight = abs(coc) + 1e-4;
          sum += max(texture2D(tColor, uv).rgb, vec3(0.0)) * weight;
          weightSum += weight;
          cocMin = min(cocMin, coc);
          cocMax = max(cocMax, coc);
        }
        float coc = (-cocMin > cocMax ? cocMin : cocMax) * ${MAX_COC.toFixed(4)};
        // ピントの合った点の色は暗くしない。暗くすると、元の解像度の像と混ぜ始める錯乱円の帯で
        // その暗さが写り、奥行きに沿った薄い線になった。奥のぼけへの混ざりは、集めるときの重みで防ぐ
        gl_FragColor = vec4(sum / weightSum, coc);
      }`,
    );

    // 円盤状に周りを集める。自分のぼけは、自分の錯乱円の大きさの円盤で集める (ぼけの大きさによらず円盤の中の点の数が同じなので、
    // 小さなぼけも粗くならず、ピント面から途切れずに大きくなる)。相手の錯乱円が自分より小さい点は、その届く範囲だけを入れる
    // (ピントの合った物を、奥のぼけへ混ぜない)。
    // 手前のぼけは、ピントの合った物や奥の上へもはみ出してくるので、上限の大きさの円盤で、届いている手前の点を探す。
    // 手前の点は自分の錯乱円の面積に光を広げるので、面積で割った重みで集め、その合計を覆う割合とする
    this.bokeh = fullscreenMaterial(
      {
        tSource: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uKernel: { value: KERNEL },
        uNearKernel: { value: NEAR_KERNEL },
        uRcpAspect: { value: 1 },
      },
      /* glsl */ `
      precision highp float;
      uniform sampler2D tSource;
      uniform vec2 uTexel;
      uniform vec2 uKernel[KERNEL_SIZE];
      uniform vec2 uNearKernel[NEAR_SIZE];
      uniform float uRcpAspect;
      varying vec2 vUv;
      void main() {
        vec4 center = texture2D(tSource, vUv);
        float radius = abs(center.a);
        float margin = uTexel.y * 2.0;
        vec4 self = vec4(center.rgb, 1.0);
        for (int i = 0; i < KERNEL_SIZE; i++) {
          vec2 offset = uKernel[i] * radius;
          vec4 tap = texture2D(tSource, vUv + vec2(offset.x * uRcpAspect, offset.y));
          float reach = min(radius, abs(tap.a));
          float weight = clamp((reach - length(offset) + margin) / margin, 0.0, 1.0);
          self += vec4(tap.rgb, 1.0) * weight;
        }
        self.rgb /= self.a;

        float maxCoc = ${MAX_COC.toFixed(4)};
        vec4 near = vec4(0.0);
        for (int i = 0; i < NEAR_SIZE; i++) {
          vec2 offset = uNearKernel[i] * maxCoc;
          vec4 tap = texture2D(tSource, vUv + vec2(offset.x * uRcpAspect, offset.y));
          // 自分より手前にぼけている点だけ
          float tapRadius = -tap.a;
          float inFront = step(uTexel.y, tapRadius) * step(tap.a, center.a - uTexel.y);
          float reach = clamp((tapRadius - length(offset) + margin) / margin, 0.0, 1.0);
          float area = maxCoc / max(tapRadius, uTexel.y);
          float weight = reach * inFront * area * area;
          near += vec4(tap.rgb, 1.0) * weight;
        }
        near.rgb /= near.a + (near.a == 0.0 ? 1.0 : 0.0);
        float alpha = clamp(near.a / float(NEAR_SIZE), 0.0, 1.0);
        gl_FragColor = vec4(mix(self.rgb, near.rgb, alpha), alpha);
      }`,
    );

    // 円盤の点の間を埋める。街明かりのような小さな明るい点は、ぼけると円盤の点の並びがそのまま写り、
    // ぼつぼつに見える。点の間隔はぼけの大きさに比例するので、ならす範囲も錯乱円に比例させる。
    // 手前のぼけのはみ出しは上限の大きさの円盤で探すので、覆う割合に応じてその間隔でならす
    this.postfilter = fullscreenMaterial(
      {
        tSource: { value: null },
        tCoc: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uKernel: { value: FILL_KERNEL },
        uRcpAspect: { value: 1 },
      },
      /* glsl */ `
      precision highp float;
      uniform sampler2D tSource;
      uniform sampler2D tCoc;
      uniform vec2 uTexel;
      uniform vec2 uKernel[FILL_SIZE];
      uniform float uRcpAspect;
      varying vec2 vUv;
      void main() {
        vec4 center = texture2D(tSource, vUv);
        // 間隔ちょうどでは細かい斜めの縞が残ったので、少し広くならす
        float selfRadius = abs(texture2D(tCoc, vUv).a) * ${(KERNEL_SPACING * 1.3).toFixed(4)};
        float nearRadius = center.a * ${(NEAR_SPACING * 1.3 * MAX_COC).toFixed(5)};
        float radius = max(max(selfRadius, nearRadius), uTexel.y * 0.5);
        vec4 sum = center;
        for (int i = 0; i < FILL_SIZE; i++) {
          vec2 offset = uKernel[i] * radius;
          sum += texture2D(tSource, vUv + vec2(offset.x * uRcpAspect, offset.y));
        }
        gl_FragColor = sum / float(FILL_SIZE + 1);
      }`,
    );

    // 元の解像度の像と混ぜる。半分の解像度では数画素より小さいぼけを表せないので、小さなぼけはここで直接ぼかし、
    // 錯乱円が ${HALF_FROM}〜${HALF_TO} 画素の間で半分の解像度の結果へ移す。手前のぼけのはみ出しは覆う割合で混ぜる
    this.composite = fullscreenMaterial(
      {
        tColor: { value: null },
        tDof: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uKernel: { value: SMALL_KERNEL },
        uRcpAspect: { value: 1 },
        ...this.lens,
      },
      /* glsl */ `
      precision highp float;
      uniform sampler2D tColor;
      uniform sampler2D tDof;
      uniform vec2 uTexel;
      uniform vec2 uKernel[SMALL_SIZE];
      uniform float uRcpAspect;
      varying vec2 vUv;
      ${COC_GLSL}
      void main() {
        vec4 color = texture2D(tColor, vUv);
        vec4 dof = texture2D(tDof, vUv);
        float radius = abs(cocAt(vUv)) * ${MAX_COC.toFixed(4)};
        float pixels = radius / uTexel.y;
        vec3 small = color.rgb;
        if (pixels > 0.5 && pixels < ${HALF_TO.toFixed(1)}) {
          vec3 sum = color.rgb;
          float weightSum = 1.0;
          for (int i = 0; i < SMALL_SIZE; i++) {
            vec2 uv = vUv + vec2(uKernel[i].x * uRcpAspect, uKernel[i].y) * radius;
            // ピントの合った物を、ぼけた後ろへ広げない
            float weight = clamp(abs(cocAt(uv)) * ${MAX_COC.toFixed(4)} / radius, 0.25, 1.0);
            sum += texture2D(tColor, uv).rgb * weight;
            weightSum += weight;
          }
          small = sum / weightSum;
        }
        float halfAmount = smoothstep(${HALF_FROM.toFixed(1)}, ${HALF_TO.toFixed(1)}, pixels);
        gl_FragColor = vec4(mix(small, dof.rgb, max(halfAmount, dof.a)), color.a);
      }`,
    );
  }

  // fNumber は F 値、globeSize は地球を見立てる地球儀の直径 (m)
  setLens(fNumber: number, globeSize: number): void {
    this.fNumber = fNumber;
    this.globeSize = globeSize;
  }

  setSize(width: number, height: number): void {
    const [w, h] = [Math.max(1, Math.ceil(width / 2)), Math.max(1, Math.ceil(height / 2))];
    for (const target of this.half) target.setSize(w, h);
    this.prefilter.uniforms.uTexel.value.set(1 / width, 1 / height);
    this.composite.uniforms.uTexel.value.set(1 / width, 1 / height);
    this.bokeh.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.postfilter.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.bokeh.uniforms.uRcpAspect.value = h / w;
    this.postfilter.uniforms.uRcpAspect.value = h / w;
    this.composite.uniforms.uRcpAspect.value = height / width;
  }

  private updateLens(): void {
    const camera = this.camera;
    const lens = this.lens;
    const focalLength = focalLengthForFov(camera.fov, camera.aspect) / 1000;
    const sceneScale = this.globeSize / 2; // 地球の半径が場面の 1 単位
    camera.getWorldDirection(this.forward);
    lens.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    lens.uCameraRotation.value.setFromMatrix4(camera.matrixWorld);
    lens.uCameraPos.value.copy(camera.position);
    lens.uSceneScale.value = sceneScale;
    lens.uFocalLength.value = focalLength;
    lens.uAperture.value = focalLength / this.fNumber;
    // ピントは画面の中心の視線が地表に当たる点 (地域ビューでは中心の地点、地球ビューでは真下の地表) に合わせる
    lens.uFocus.value =
      sphereRayDistance(camera.position.toArray(), this.forward.toArray(), lens.uSphereRadius.value) * sceneScale;
    lens.uCocScale.value = 0.5 / (sensorHeight(camera.aspect) / 1000) / MAX_COC;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.updateLens();
    const [a, b, c] = this.half;
    const draw = (material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void => {
      this.quad.material = material;
      renderer.setRenderTarget(target);
      this.quad.render(renderer);
    };
    this.prefilter.uniforms.tColor.value = readBuffer.texture;
    draw(this.prefilter, a);
    this.bokeh.uniforms.tSource.value = a.texture;
    draw(this.bokeh, b);
    this.postfilter.uniforms.tSource.value = b.texture;
    this.postfilter.uniforms.tCoc.value = a.texture;
    draw(this.postfilter, c);
    this.composite.uniforms.tColor.value = readBuffer.texture;
    this.composite.uniforms.tDof.value = c.texture;
    draw(this.composite, this.renderToScreen ? null : writeBuffer);
  }

  dispose(): void {
    for (const target of this.half) target.dispose();
    for (const material of [this.prefilter, this.bokeh, this.postfilter, this.composite]) material.dispose();
    this.quad.dispose();
  }
}
