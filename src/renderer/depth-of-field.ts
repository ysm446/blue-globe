// 被写界深度。線形 HDR のまま、ブルームとトーンマップの前に掛ける (明るい点が飽和する前にぼかすと玉ぼけになる)。
// 地球を直径「地球儀の大きさ」の模型に見立て (ミニチュアの縮尺)、実際のレンズの式で錯乱円を求める。
// レンズの側 (焦点距離、F 値、センサー) は現実のままで、場面の距離だけを縮める。焦点距離は画角から求め、二重に持たない。
// 奥行きは深度バッファを使わず、視線と地球の球の交点から計算する (大気や雲は深度を書かず、場面はほぼ球のため)。
// ぼかし方は、半分の解像度で円盤状に周りを集め (奥と手前のぼけを分けて集める)、元の解像度の像と混ぜる
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { focalLengthForFov, sensorHeight, sphereRayDistance } from './camera-lens';
import { FULLSCREEN_VS } from './glsl';

const MAX_COC = 0.025; // ぼけの半径の上限 (画面の高さが 1)。大きくすると円盤の点の間が空いて粗く見える
const KERNEL_SIZE = 106; // 円盤の点の数
const FILL_SIZE = 24; // 点の間を埋めるときの点の数
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// 円盤の点の間隔 (画面の高さが 1)。円盤は常に上限の大きさで集めるので、間隔はぼけの大きさによらない
const KERNEL_SPACING = Math.sqrt(Math.PI / KERNEL_SIZE) * MAX_COC;

// 半径 1 の円盤の点。同心の輪に並べると明るい点のぼけに輪の模様が写るので、黄金角でずらしながら外へ広げる。
// 半径を平方根にして、面積あたりの点の数を揃える
function diskKernel(size: number): THREE.Vector2[] {
  return Array.from({ length: size }, (_, i) => {
    const radius = Math.sqrt((i + 0.5) / size);
    return new THREE.Vector2(Math.cos(i * GOLDEN_ANGLE) * radius, Math.sin(i * GOLDEN_ANGLE) * radius);
  });
}

const KERNEL = diskKernel(KERNEL_SIZE);
const FILL_KERNEL = diskKernel(FILL_SIZE);

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
    defines: { KERNEL_SIZE, FILL_SIZE },
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

    // 円盤状に周りを集める。奥のぼけは自分と相手の小さいほうの錯乱円で届く範囲だけを集め、
    // 手前のぼけは相手の錯乱円で届いていれば集める (手前のぼけはピントの合った物の上へはみ出す)
    this.bokeh = fullscreenMaterial(
      {
        tSource: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uKernel: { value: KERNEL },
        uRcpAspect: { value: 1 },
      },
      /* glsl */ `
      precision highp float;
      uniform sampler2D tSource;
      uniform vec2 uTexel;
      uniform vec2 uKernel[KERNEL_SIZE];
      uniform float uRcpAspect;
      varying vec2 vUv;
      void main() {
        vec4 center = texture2D(tSource, vUv);
        vec4 far = vec4(0.0);
        vec4 near = vec4(0.0);
        float margin = uTexel.y * 2.0;
        for (int i = 0; i < KERNEL_SIZE; i++) {
          vec2 offset = uKernel[i] * ${MAX_COC.toFixed(4)};
          float distance = length(offset);
          vec4 tap = texture2D(tSource, vUv + vec2(offset.x * uRcpAspect, offset.y));
          float farCoc = max(min(center.a, tap.a), 0.0);
          float farWeight = clamp((farCoc - distance + margin) / margin, 0.0, 1.0);
          float nearWeight = clamp((-tap.a - distance + margin) / margin, 0.0, 1.0);
          // 手前にぼけていない点 (ピントの合った点と奥の点) は、手前のぼけに入れない
          nearWeight *= step(uTexel.y, -tap.a);
          far += vec4(tap.rgb, 1.0) * farWeight;
          near += vec4(tap.rgb, 1.0) * nearWeight;
        }
        far.rgb /= far.a + (far.a == 0.0 ? 1.0 : 0.0);
        near.rgb /= near.a + (near.a == 0.0 ? 1.0 : 0.0);
        // 手前のぼけがこの点を覆う割合
        float alpha = clamp(near.a * 3.14159265 / float(KERNEL_SIZE), 0.0, 1.0);
        gl_FragColor = vec4(mix(far.rgb, near.rgb, alpha), alpha);
      }`,
    );

    // 円盤の点の間を埋める。街明かりのような小さな明るい点は、ぼけると円盤の点の並びがそのまま写り、
    // ぼつぼつに見える。ぼけているところだけ、点の間隔ほどの範囲をならす (ピントの合ったところは細部を残す)
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
        float spacing = ${KERNEL_SPACING.toFixed(5)};
        // 手前のぼけは、ピントの合ったところの上にもはみ出してくるので、覆う割合でも広げる
        float blur = max(smoothstep(0.0, spacing, abs(texture2D(tCoc, vUv).a)), center.a);
        // 間隔ちょうどでは細かい斜めの縞が残ったので、少し広くならす
        float radius = max(spacing * 1.3 * blur, uTexel.y * 0.5);
        vec4 sum = center;
        for (int i = 0; i < FILL_SIZE; i++) {
          vec2 offset = uKernel[i] * radius;
          sum += texture2D(tSource, vUv + vec2(offset.x * uRcpAspect, offset.y));
        }
        gl_FragColor = sum / float(FILL_SIZE + 1);
      }`,
    );

    // 元の解像度の像と混ぜる。奥のぼけは自分の錯乱円で、手前のぼけは覆う割合で混ぜる
    this.composite = fullscreenMaterial(
      { tColor: { value: null }, tDof: { value: null }, uTexel: { value: new THREE.Vector2() }, ...this.lens },
      /* glsl */ `
      precision highp float;
      uniform sampler2D tColor;
      uniform sampler2D tDof;
      uniform vec2 uTexel;
      varying vec2 vUv;
      ${COC_GLSL}
      void main() {
        vec4 color = texture2D(tColor, vUv);
        vec4 dof = texture2D(tDof, vUv);
        float coc = cocAt(vUv) * ${MAX_COC.toFixed(4)};
        float farAlpha = smoothstep(uTexel.y * 2.0, uTexel.y * 4.0, coc);
        gl_FragColor = vec4(mix(color.rgb, dof.rgb, farAlpha + dof.a - farAlpha * dof.a), color.a);
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
