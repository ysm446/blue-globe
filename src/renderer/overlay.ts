// 風速カラーオーバーレイ: 地表を風速に応じた色の半透明球で覆う (nullschool の Overlay 相当)。
//
// 風場テクスチャをフラグメントシェーダーで直接サンプリングするため、
// 画面解像度に依存せず滑らかなグラデーションになり、
// 風データの差し替え (setWind) も即座に反映される。

import * as THREE from 'three';
import { WindField } from './wind';
import { type ColorStops } from './particles';
import { PROJECT_GLSL } from './projection';
import {
  createWindDataTexture,
  createSpeedRampTexture,
  writeWindInterp,
  RAMP_MAX_SPEED,
} from './wind-texture';

const VS = /* glsl */ `
${PROJECT_GLSL}
uniform float uMorph;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec2 lonlat = vec2(uv.x * 360.0 - 180.0, uv.y * 180.0 - 90.0);
  vec3 p = windmapMorphPos(position, lonlat, length(position), uMorph);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FS = /* glsl */ `
precision highp float;
uniform sampler2D uWind;
uniform sampler2D uRamp;
uniform vec4 uGrid;     // lo1, la1, dx, dy
uniform vec2 uGridSize; // nx, ny
uniform float uOpacity;
uniform float uCenterLon; // 地図の中央経度 (UV は表示経度なので実経度に戻す)
varying vec2 vUv;

void main() {
  // SphereGeometry の UV (u=0 が表示経度 -180、v=1 が lat=90) を経緯度へ戻す
  float lon = vUv.x * 360.0 - 180.0 + uCenterLon;
  float lat = vUv.y * 180.0 - 90.0;
  float c = mod(lon - uGrid.x, 360.0) / uGrid.z;
  float r = (uGrid.y - lat) / uGrid.w;
  vec2 w = texture2D(uWind, vec2((c + 0.5) / uGridSize.x, (r + 0.5) / uGridSize.y)).xy;
  float speed = length(w);
  vec3 color = texture2D(uRamp, vec2(clamp(speed / ${RAMP_MAX_SPEED.toFixed(1)}, 0.0, 1.0), 0.5)).rgb;
  gl_FragColor = vec4(color, uOpacity);
}
`;

export class SpeedOverlay {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private rampTexture: THREE.DataTexture;
  private windTexture: THREE.DataTexture | null = null;
  private enabled = false;

  constructor(radius: number) {
    this.rampTexture = createSpeedRampTexture();
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uWind: { value: null },
        uRamp: { value: this.rampTexture },
        uGrid: { value: new THREE.Vector4(0, 90, 1, 1) },
        uGridSize: { value: new THREE.Vector2(1, 1) },
        uOpacity: { value: 0.3 },
        uMorph: { value: 0 },
        uCenterLon: { value: 0 },
      },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
    });
    // heightSegments はメルカトルモーフのクランプ位置 (±85°) に頂点行が乗るよう 36 の倍数
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 72), this.material);
    this.mesh.visible = false;
  }

  setWind(wind: WindField): void {
    const tex = createWindDataTexture(wind);
    this.windTexture?.dispose();
    this.windTexture = tex;
    this.material.uniforms.uWind.value = tex;
    this.material.uniforms.uGrid.value.set(wind.lo1, wind.la1, wind.dx, wind.dy);
    this.material.uniforms.uGridSize.value.set(wind.nx, wind.ny);
    this.syncVisible();
  }

  // 2 フレームを時間補間した風場をその場で反映する(再生の補間用)
  setWindInterp(a: WindField, b: WindField, t: number): void {
    const size = this.material.uniforms.uGridSize.value as THREE.Vector2;
    if (!this.windTexture || size.x !== a.nx || size.y !== a.ny) {
      this.setWind(a);
    }
    writeWindInterp(this.windTexture!, a, b, t);
  }

  setColorStops(stops: ColorStops): void {
    const tex = createSpeedRampTexture(stops);
    this.rampTexture.dispose();
    this.rampTexture = tex;
    this.material.uniforms.uRamp.value = tex;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.syncVisible();
  }

  setOpacity(opacity: number): void {
    this.material.uniforms.uOpacity.value = opacity;
  }

  // 地球儀 (0) ⇔ メルカトル平面 (1) のモーフ量
  setMorph(morph: number): void {
    this.material.uniforms.uMorph.value = morph;
  }

  // 地図の中央経度
  setCenterLon(centerLon: number): void {
    this.material.uniforms.uCenterLon.value = centerLon;
  }

  // 風データ未着のうちは真っ黒な球になるので、テクスチャが揃うまで隠す
  private syncVisible(): void {
    this.mesh.visible = this.enabled && this.windTexture !== null;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.rampTexture.dispose();
    this.windTexture?.dispose();
  }
}
