// 写実的な地球。地表写真、夜の街明かり、大気の縁、雲の層を描く。
// 雲は天気モードのときだけ表示し (setCloudsEnabled)、地表より少し高い別の球に載せる。
// 回すと地面とずれて動くので、ボリューム雲を使わなくても高さが感じられる
import * as THREE from 'three';

const CLOUD_ALTITUDE = 0.012; // 実際より高い。視差が見える程度に誇張している

const VS = /* glsl */ `
varying vec3 vPos;
varying vec2 vUv;
void main() {
  vPos = position;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// SphereGeometry の UV は u=0 が経度 -180 度、v=1 が北極。雲マップは左端が -180 度、1 行目が北端。
// 別の点の UV を引くときは atan の継ぎ目でミップマップが乱れないよう、元の UV の微分を渡す
const CLOUD_SAMPLING_GLSL = /* glsl */ `
uniform sampler2D uCloud;
vec2 cloudUvOf(vec3 n) {
  float angle = atan(n.z, -n.x);
  float u = angle / 6.28318530718 + (angle < 0.0 ? 1.0 : 0.0);
  return vec2(u, 0.5 - asin(clamp(n.y, -1.0, 1.0)) / 3.14159265359);
}
float cloudAt(vec3 n, vec2 dx, vec2 dy) {
  return textureGrad(uCloud, cloudUvOf(n), dx, dy).r;
}
`;

const EARTH_FS = /* glsl */ `
precision highp float;
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform float uShadowAmount;
uniform vec3 uSunDir;
varying vec3 vPos;
varying vec2 vUv;
${CLOUD_SAMPLING_GLSL}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec3 n = normalize(vPos);
  vec3 view = normalize(cameraPosition - vPos);
  float ndl = dot(n, uSunDir);
  float light = smoothstep(-0.06, 0.55, ndl);
  float dayMask = smoothstep(-0.1, 0.1, ndl);

  vec3 day = texture2D(uDay, vUv).rgb;
  float ocean = smoothstep(0.02, 0.1, day.b - day.r);

  // 雲の影。太陽が低いほど長く伸びる
  float shadow = 0.0;
  if (uShadowAmount > 0.0 && dayMask > 0.0) {
    vec3 toSun = normalize(uSunDir - n * ndl);
    float sinZenith = sqrt(max(1.0 - ndl * ndl, 0.0));
    float reach = min(${CLOUD_ALTITUDE.toFixed(4)} * sinZenith / max(ndl, 0.12), 0.08);
    float caster = cloudAt(normalize(n + toSun * reach), dFdx(vUv), dFdy(vUv));
    shadow = smoothstep(0.15, 0.75, caster) * 0.55 * uShadowAmount;
  }

  vec3 color = day * 1.5 * light * (1.0 - shadow);

  // 太陽の映り込み (海だけ)
  vec3 halfway = normalize(uSunDir + view);
  color += vec3(1.0, 0.92, 0.8) * pow(max(dot(n, halfway), 0.0), 90.0) * 0.55 * ocean * (1.0 - shadow) * dayMask;

  // 街明かりは夜側だけ
  float lights = pow(smoothstep(0.1, 1.0, texture2D(uNight, vUv).r), 1.4) * (1.0 - dayMask);
  color += vec3(1.0, 0.6, 0.26) * lights * 0.6;

  // 回して触ったときに場所が分かるよう、夜側でも陸と海がうっすら見える光を残す
  color += (day * vec3(0.22, 0.27, 0.4) + vec3(0.003, 0.006, 0.014)) * (1.0 - dayMask);

  // 地表から見える大気 (縁ほど青い)。昼側だけ
  float fresnel = pow(1.0 - max(dot(n, view), 0.0), 3.2);
  color += vec3(0.22, 0.48, 1.0) * fresnel * smoothstep(-0.15, 0.45, ndl) * 1.2;
  color += vec3(0.07, 0.16, 0.34) * light * 0.35;

  gl_FragColor = vec4(aces(color), 1.0);
  #include <colorspace_fragment>
}
`;

const CLOUD_FS = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
varying vec3 vPos;
varying vec2 vUv;
${CLOUD_SAMPLING_GLSL}
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 3.1;
    a *= 0.5;
  }
  return v;
}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
void main() {
  vec3 n = normalize(vPos);
  vec3 view = normalize(cameraPosition - vPos);
  vec2 dx = dFdx(vUv);
  vec2 dy = dFdy(vUv);
  float base = textureGrad(uCloud, vec2(vUv.x, 1.0 - vUv.y), dx, dy).r;
  if (base < 0.01) discard;

  // 細部。薄いところほど崩して巻雲のような縁にし、厚いところは元データの形を保つ
  vec3 warp = vec3(fbm(n * 9.0 + 1.3), fbm(n * 9.0 + 7.1), 0.0) - 0.5;
  float detail = fbm(n * 38.0 + warp * 1.6);
  float d = clamp(base + (detail - 0.5) * 0.6 * (1.0 - smoothstep(0.3, 0.9, base)), 0.0, 1.0);

  // 半透明。光の通りにくさは厚みに対して指数的で、縁では視線が雲を長く通るので濃くなる
  float pathLength = 1.0 / max(dot(n, view), 0.25);
  float opticalDepth = d * 2.3 * mix(1.0, pathLength, 0.45);
  float alpha = (1.0 - exp(-opticalDepth)) * smoothstep(0.015, 0.1, d);

  // 立体感。太陽の方向へ数点たどり、手前にある雲に遮られた分だけ暗くする
  float ndl = dot(n, uSunDir);
  vec3 toSun = normalize(uSunDir - n * ndl);
  float blocked = 0.0;
  blocked += cloudAt(normalize(n + toSun * 0.005), dx, dy) * 0.4;
  blocked += cloudAt(normalize(n + toSun * 0.012), dx, dy) * 0.3;
  blocked += cloudAt(normalize(n + toSun * 0.024), dx, dy) * 0.2;
  blocked += cloudAt(normalize(n + toSun * 0.042), dx, dy) * 0.1;
  float slope = sqrt(max(1.0 - ndl * ndl, 0.0)); // 真上からの光では陰ができない
  float relief = blocked - base * 0.75;
  float transmit = clamp(exp(-max(blocked, 0.0) * 1.15 * slope) + (-relief) * 0.9 * slope, 0.0, 1.0);

  float light = smoothstep(-0.06, 0.5, ndl);
  float dusk = smoothstep(-0.08, 0.02, ndl) * (1.0 - smoothstep(0.02, 0.28, ndl));
  vec3 sunColor = mix(vec3(1.0, 0.99, 0.97), vec3(1.0, 0.6, 0.36), dusk * 0.8);
  // 影の部分は黒くせず、空の光を受けた青灰色にする
  vec3 lit = mix(vec3(0.42, 0.5, 0.66), vec3(1.05), transmit);
  vec3 color = lit * sunColor * light + vec3(0.016, 0.021, 0.036);

  // 縁の雲にも大気の青を重ねる
  float fresnel = pow(1.0 - max(dot(n, view), 0.0), 3.2);
  color += vec3(0.16, 0.36, 0.8) * fresnel * smoothstep(-0.15, 0.45, ndl) * 0.7;

  gl_FragColor = vec4(aces(color), alpha);
  #include <colorspace_fragment>
}
`;

// 地球の外側に見える大気の光。裏面だけを描く少し大きい球で表す
const ATMOSPHERE_FS = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
varying vec3 vPos;
void main() {
  vec3 n = normalize(vPos);
  vec3 view = normalize(cameraPosition - vPos);
  float inner = smoothstep(0.0, 0.38, -dot(n, view));
  float lit = smoothstep(-0.25, 0.55, dot(n, uSunDir));
  float a = pow(inner, 2.6) * lit * 0.9;
  gl_FragColor = vec4(vec3(0.27, 0.55, 1.0) * a, a);
  #include <colorspace_fragment>
}
`;

export class RealisticEarth {
  readonly group = new THREE.Group();
  private readonly material: THREE.ShaderMaterial;
  private readonly cloudMesh: THREE.Mesh;
  private readonly cloudMaterial: THREE.ShaderMaterial;
  private readonly sunDir = new THREE.Vector3(1, 0, 0);
  private cloudTexture: THREE.DataTexture | null = null;
  private cloudsWanted = false;

  constructor(radius: number) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uDay: { value: null },
        uNight: { value: null },
        uCloud: { value: null },
        uShadowAmount: { value: 0 },
        uSunDir: { value: this.sunDir },
      },
      vertexShader: VS,
      fragmentShader: EARTH_FS,
    });
    this.group.add(new THREE.Mesh(new THREE.SphereGeometry(radius, 192, 128), this.material));

    this.cloudMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCloud: { value: null },
        uSunDir: { value: this.sunDir },
      },
      vertexShader: VS,
      fragmentShader: CLOUD_FS,
      transparent: true,
      depthWrite: false,
    });
    this.cloudMesh = new THREE.Mesh(
      new THREE.SphereGeometry(radius + CLOUD_ALTITUDE, 192, 128),
      this.cloudMaterial,
    );
    this.cloudMesh.renderOrder = 2; // 海岸線より上に重ねる
    this.cloudMesh.visible = false;
    this.group.add(this.cloudMesh);

    this.group.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(radius * 1.07, 128, 96),
        new THREE.ShaderMaterial({
          uniforms: { uSunDir: { value: this.sunDir } },
          vertexShader: VS,
          fragmentShader: ATMOSPHERE_FS,
          side: THREE.BackSide,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      ),
    );
  }

  setTextures(day: THREE.Texture, night: THREE.Texture): void {
    this.material.uniforms.uDay.value = day;
    this.material.uniforms.uNight.value = night;
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.sunDir.copy(direction);
  }

  // data は 1 画素 1 バイトの雲の濃さ。1 行目が北端、左端が経度 -180 度
  setCloudData(nx: number, ny: number, data: Uint8Array): void {
    const texture = new THREE.DataTexture(
      data as Uint8Array<ArrayBuffer>,
      nx,
      ny,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    this.cloudTexture?.dispose();
    this.cloudTexture = texture;
    this.material.uniforms.uCloud.value = texture;
    this.cloudMaterial.uniforms.uCloud.value = texture;
    this.syncClouds();
  }

  setCloudsEnabled(enabled: boolean): void {
    this.cloudsWanted = enabled;
    this.syncClouds();
  }

  private syncClouds(): void {
    const show = this.cloudsWanted && this.cloudTexture !== null;
    this.cloudMesh.visible = show;
    this.material.uniforms.uShadowAmount.value = show ? 1 : 0;
  }
}
