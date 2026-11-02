// 地図のラベルの配置の計算。画面の計算から切り離して検証できるよう、DOM に依存しない
export interface LabelBox {
  x: number; // 左上
  y: number;
  width: number;
  height: number;
}

const LABEL_GAP = 2; // 隣のラベルと文字がくっついて読みにくくならないようにする

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return (
    a.x < b.x + b.width + LABEL_GAP &&
    b.x < a.x + a.width + LABEL_GAP &&
    a.y < b.y + b.height + LABEL_GAP &&
    b.y < a.y + a.height + LABEL_GAP
  );
}

// 前から順に置き、すでに置いたものや blocked と重なるものは出さない。順番が優先順位で、
// 同じ順番で判定するので、視点が変わらなければ出るラベルも変わらない。null は画面に出ないもの
export function placeLabels(candidates: Array<LabelBox | null>, blocked: LabelBox[] = []): boolean[] {
  const placed = [...blocked];
  return candidates.map((box) => {
    if (!box || placed.some((other) => overlaps(box, other))) return false;
    placed.push(box);
    return true;
  });
}
