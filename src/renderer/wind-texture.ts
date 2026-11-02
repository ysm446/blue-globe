// 風場テクスチャと配色ランプ、風を引くシェーダーの共有部分。
// GPU パーティクル (gpu-particles.ts) と風速カラーオーバーレイ (overlay.ts) で同じテクスチャを使う。

import * as THREE from 'three';
import { clamp, DEG } from './math';
import { WindField } from './wind';

export const RAMP_MAX_SPEED = 35; // 配色の上限風速 (m/s)
export const BASE_DEG_PER_FRAME = 0.03; // 風速 1 m/s あたりの 1 フレーム移動量(度)
export const PARTICLE_MAX_LAT = 85; // 極近傍は移流が破綻するので、この緯度を超えたら置き直す

// 風速 (m/s) → 色のグラデーション。[風速, [R, G, B]] の列(風速昇順)
export type ColorStops = Array<[number, [number, number, number]]>;

// 暗い青緑の海から強風帯が金色〜赤に浮かぶ、earth.nullschool 風の配色
export const WIND_COLOR_STOPS: ColorStops = [
  [0, [10, 36, 47]],
  [3, [36, 89, 98]],
  [7, [62, 138, 109]],
  [11, [109, 174, 104]],
  [15, [164, 199, 100]],
  [20, [222, 209, 107]],
  [26, [240, 160, 71]],
  [35, [214, 64, 38]],
];

export function speedColor(speed: number): [number, number, number] {
  const stops = WIND_COLOR_STOPS;
  if (speed <= stops[0][0]) {
    const c = stops[0][1];
    return [c[0] / 255, c[1] / 255, c[2] / 255];
  }
  for (let i = 1; i < stops.length; i++) {
    if (speed <= stops[i][0]) {
      const [s0, c0] = stops[i - 1];
      const [s1, c1] = stops[i];
      const t = (speed - s0) / (s1 - s0);
      return [
        (c0[0] + (c1[0] - c0[0]) * t) / 255,
        (c0[1] + (c1[1] - c0[1]) * t) / 255,
        (c0[2] + (c1[2] - c0[2]) * t) / 255,
      ];
    }
  }
  const c = stops[stops.length - 1][1];
  return [c[0] / 255, c[1] / 255, c[2] / 255];
}

// 球面上で一様な緯度 (sin(lat) を一様サンプリング)
export function randomParticleLat(): number {
  const lat = Math.asin(Math.random() * 2 - 1) / DEG;
  return clamp(lat, -PARTICLE_MAX_LAT, PARTICLE_MAX_LAT);
}

// 風場 (u, v) を半精度浮動小数点テクスチャに焼く。補間は GPU のバイリニアフィルタに任せる
function createWindDataTexture(wind: WindField): THREE.DataTexture {
  const { nx, ny, uValues: u, vValues: v } = wind;
  const data = new Uint16Array(nx * ny * 4);
  const one = THREE.DataUtils.toHalfFloat(1);
  for (let k = 0; k < nx * ny; k++) {
    data[k * 4] = THREE.DataUtils.toHalfFloat(u[k]);
    data[k * 4 + 1] = THREE.DataUtils.toHalfFloat(v[k]);
    data[k * 4 + 2] = 0;
    data[k * 4 + 3] = one;
  }
  const tex = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.wrapS = THREE.RepeatWrapping; // 経度方向は日付変更線をまたいで補間する
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// 風速 0〜RAMP_MAX_SPEED m/s を横軸にした 1D カラーランプ
function createSpeedRampTexture(): THREE.DataTexture {
  const width = 256;
  const data = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) {
    const [r, g, b] = speedColor((i / (width - 1)) * RAMP_MAX_SPEED);
    data[i * 4] = Math.round(r * 255);
    data[i * 4 + 1] = Math.round(g * 255);
    data[i * 4 + 2] = Math.round(b * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, width, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export interface WindUniforms {
  uWind: { value: THREE.DataTexture | null }; // 風データが届くまでは null
  uGrid: { value: THREE.Vector4 }; // lo1, la1, dx, dy
  uGridSize: { value: THREE.Vector2 }; // nx, ny
  uRamp: { value: THREE.DataTexture };
}

export function createWindUniforms(): WindUniforms {
  return {
    uWind: { value: null },
    uGrid: { value: new THREE.Vector4() },
    uGridSize: { value: new THREE.Vector2() },
    uRamp: { value: createSpeedRampTexture() },
  };
}

export function updateWindUniforms(uniforms: WindUniforms, wind: WindField): void {
  const texture = createWindDataTexture(wind);
  uniforms.uWind.value?.dispose();
  uniforms.uWind.value = texture;
  uniforms.uGrid.value.set(wind.lo1, wind.la1, wind.dx, wind.dy);
  uniforms.uGridSize.value.set(wind.nx, wind.ny);
}

// 経緯度から風 (u, v) を引く
export const WIND_LOOKUP_GLSL = /* glsl */ `
uniform sampler2D uWind;
uniform vec4 uGrid;
uniform vec2 uGridSize;
vec2 windAt(vec2 lonlat) {
  float c = mod(lonlat.x - uGrid.x, 360.0) / uGrid.z;
  float r = (uGrid.y - lonlat.y) / uGrid.w;
  return texture2D(uWind, vec2((c + 0.5) / uGridSize.x, (r + 0.5) / uGridSize.y)).xy;
}
`;
