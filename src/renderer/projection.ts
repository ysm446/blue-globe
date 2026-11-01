// 地球儀 ⇔ メルカトル平面のモーフ投影。
//
// 地表・海岸線・オーバーレイ・パーティクルはすべて経緯度から頂点位置を計算して
// いるので、共通の GLSL 関数 (PROJECT_GLSL) を各頂点シェーダーに注入し、
// uniform uMorph (0=地球儀, 1=平面) で球面位置と平面位置を線形補間する。
//
// 平面は経度0°・緯度0° が球面上で向く方向 (+X) を法線とし、原点を通る。
// こうするとモーフ前後で「地図の中心」と「地球儀の正面 (経度0°)」が一致する。
// 平面内の座標系は、+X から原点を見たとき東 (経度+) が画面右になる向き:
//   位置 = (半径 - 1, メルカトルY, -メルカトルX)
// 半径-1 を法線方向のオフセットにすることで、球面での Z ファイティング回避用の
// 半径差 (地表 1.0 < オーバーレイ 1.0008 < 海岸線 1.0015 < 粒子 1.004) が
// 平面でもそのまま前後関係として保たれる。

import * as THREE from 'three';

// ラジアン → ワールド座標の倍率。地図全幅 = 2π × MAP_SCALE ≈ 3.77 (球の直径 2 に対して)
export const MAP_SCALE = 0.6;

// メルカトルの緯度クランプ。これ以上の高緯度は地図の上下端に張り付く
export const MAX_MERC_LAT = 85;

// クランプ緯度でのメルカトル Y (ラジアン単位、MAP_SCALE 適用前)。
// 平面均等なパーティクル再配置のサンプリング範囲に使う
export const MAX_MERC_Y = Math.log(Math.tan(Math.PI / 4 + (MAX_MERC_LAT * Math.PI) / 360));

// 地図全体が収まるカメラ距離 (fov 45° 基準)。モーフ時のカメラ移動先に使う
export const MAP_CAMERA_DIST = 4.8;

// 経度を [-180, 180) に正規化する
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// 頂点シェーダーへ注入する共通 GLSL
export const PROJECT_GLSL = /* glsl */ `
float windmapWrapLon(float lon) {
  return mod(lon + 180.0, 360.0) - 180.0;
}
vec3 windmapPlanePos(vec2 lonlat, float radius) {
  float mx = radians(lonlat.x) * ${MAP_SCALE.toFixed(4)};
  float lat = clamp(lonlat.y, -${MAX_MERC_LAT.toFixed(1)}, ${MAX_MERC_LAT.toFixed(1)});
  float my = log(tan(0.7853981633974483 + radians(lat) * 0.5)) * ${MAP_SCALE.toFixed(4)};
  return vec3(radius - 1.0, my, -mx);
}
vec3 windmapMorphPos(vec3 spherePos, vec2 lonlat, float radius, float morph) {
  return mix(spherePos, windmapPlanePos(lonlat, radius), morph);
}
`;

// PROJECT_GLSL の windmapPlanePos と同じ計算 (CPU パーティクル用)
export function lonLatToPlane(
  lon: number,
  lat: number,
  radius: number,
  target: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const mx = (lon * Math.PI) / 180 * MAP_SCALE;
  const clamped = Math.max(-MAX_MERC_LAT, Math.min(MAX_MERC_LAT, lat));
  const my = Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) * MAP_SCALE;
  return target.set(radius - 1, my, -mx);
}
