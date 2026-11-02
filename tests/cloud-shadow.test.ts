// 雲の影の焼き込みの範囲と条件の検証。実行: node --test tests/cloud-shadow.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsShadowBake, shadowBasis, shadowHalfSize, type ShadowBake, type Vec3 } from '../src/renderer/cloud-shadow.ts';

const BAKED: ShadowBake = { center: [1, 0, 0], halfSize: 0.5, sun: [0, 1, 0], cloudVersion: 1 };

test('まだ焼いていなければ焼く', () => {
  assert.equal(needsShadowBake(null, BAKED), true);
});

test('何も変わらなければ焼き直さない', () => {
  assert.equal(needsShadowBake(BAKED, { ...BAKED }), false);
});

test('中心が少し動いただけでは焼き直さず、範囲の 15% を超えると焼き直す', () => {
  assert.equal(needsShadowBake(BAKED, { ...BAKED, center: [1, 0, 0.07] }), false);
  assert.equal(needsShadowBake(BAKED, { ...BAKED, center: [1, 0, 0.08] }), true);
});

test('寄ったときも引いたときも、大きさが 1.25 倍変わると焼き直す', () => {
  assert.equal(needsShadowBake(BAKED, { ...BAKED, halfSize: 0.6 }), false);
  assert.equal(needsShadowBake(BAKED, { ...BAKED, halfSize: 0.65 }), true);
  assert.equal(needsShadowBake(BAKED, { ...BAKED, halfSize: 0.42 }), false);
  assert.equal(needsShadowBake(BAKED, { ...BAKED, halfSize: 0.38 }), true);
});

test('太陽が約 0.25 度動くと焼き直す', () => {
  const sunAt = (degrees: number): Vec3 => {
    const angle = (degrees * Math.PI) / 180;
    return [Math.sin(angle), Math.cos(angle), 0];
  };
  assert.equal(needsShadowBake(BAKED, { ...BAKED, sun: sunAt(0.2) }), false);
  assert.equal(needsShadowBake(BAKED, { ...BAKED, sun: sunAt(0.3) }), true);
});

test('雲のデータが新しくなると焼き直す', () => {
  assert.equal(needsShadowBake(BAKED, { ...BAKED, cloudVersion: 2 }), true);
});

test('範囲の大きさは距離に比例し、上限と下限がある', () => {
  assert.equal(shadowHalfSize(0.24), 0.48);
  assert.equal(shadowHalfSize(0.01), 0.15);
  assert.equal(shadowHalfSize(5), 1);
});

test('面の向きは太陽と直交する単位ベクトルになる。真上や真下の太陽でも同じ', () => {
  const suns: Vec3[] = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0.6, 0.48, 0.64]];
  for (const sun of suns) {
    const { u, v } = shadowBasis(sun);
    const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    assert.ok(Math.abs(dot(u, u) - 1) < 1e-9);
    assert.ok(Math.abs(dot(v, v) - 1) < 1e-9);
    assert.ok(Math.abs(dot(u, v)) < 1e-9);
    assert.ok(Math.abs(dot(u, sun)) < 1e-9);
    assert.ok(Math.abs(dot(v, sun)) < 1e-9);
  }
});
