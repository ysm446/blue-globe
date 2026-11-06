// カメラの視点の保存 (Ctrl+数字) と呼び出し (数字)。Unreal Engine のビューポートのブックマークと同じ操作。
// 画面の計算から切り離して検証できるよう、DOM と Three.js に依存しない
import { DEG } from './math.ts';

const LIFT_START = 3; // これより近い視点へは上がらずに移る (度)
const LIFT_PER_RADIAN = 0.8; // 離れた角度 1 ラジアンあたりに上がる高さ (地球の半径が 1)

// 押したキーの番号 (0〜9)。テンキーの数字も同じ番号として扱う。数字のキーでなければ null
export function bookmarkSlot(code: string): number | null {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  return match ? Number(match[1]) : null;
}

// 地域ビューで保存した視点へ飛ぶときに、途中で上がる高さ (地球の半径が 1)。separation は出発点と行き先の中心の角度 (度)。
// 低い視点のまま遠くへ移ると、地表すれすれで大陸を横切ってしまうので、離れているほど高く上がって弧を描く
// (日本からパリの約 87° で約 1.2、地球の裏側で約 2.5)
export function bookmarkLift(separation: number): number {
  return Math.max(0, separation - LIFT_START) * DEG * LIFT_PER_RADIAN;
}
