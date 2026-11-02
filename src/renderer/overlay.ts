// 風速カラーオーバーレイ: 地表を風速に応じた色の半透明球で覆う (nullschool の Overlay 相当)。
//
// 風場テクスチャをフラグメントシェーダーで直接サンプリングするため、
// 画面解像度に依存せず滑らかなグラデーションになり、
// 風データの差し替えも即座に反映される。

import * as THREE from 'three';
import { RAMP_MAX_SPEED, WIND_LOOKUP_GLSL, type WindUniforms } from './wind-texture';

const VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FS = /* glsl */ `
precision highp float;
${WIND_LOOKUP_GLSL}
uniform sampler2D uRamp;
uniform float uOpacity;
varying vec2 vUv;

void main() {
  // SphereGeometry の UV (u=0 が lon=-180、v=1 が lat=90) を経緯度へ戻す
  float speed = length(windAt(vec2(vUv.x * 360.0 - 180.0, vUv.y * 180.0 - 90.0)));
  vec3 color = texture2D(uRamp, vec2(clamp(speed / ${RAMP_MAX_SPEED.toFixed(1)}, 0.0, 1.0), 0.5)).rgb;
  gl_FragColor = vec4(color, uOpacity);
}
`;

export class SpeedOverlay {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    radius: number,
    private readonly wind: WindUniforms,
  ) {
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...wind, uOpacity: { value: 0.3 } },
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 72), this.material);
    this.mesh.visible = false;
  }

  // 風データ未着のうちは真っ黒な球になるので、テクスチャが揃うまで隠す。データが届いたらもう一度呼ぶ
  setEnabled(enabled: boolean): void {
    this.mesh.visible = enabled && this.wind.uWind.value !== null;
  }

  setOpacity(opacity: number): void {
    this.material.uniforms.uOpacity.value = opacity;
  }
}
