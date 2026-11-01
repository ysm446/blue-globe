// 24 時間の気温の折れ線の計算。画面の計算から切り離して検証できるよう、DOM に依存しない
const MIN_SPAN_DEGREES = 8; // 1℃ の差が大きな山に見えないよう、縦軸の幅に下限を設ける
const VERTICAL_PADDING = 6; // 印が上下で切れないようにする

export interface LinePoint {
  x: number;
  y: number;
}

// 各列の中央に点を置く。気温が高いほど上 (y が小さい)。変化が小さいときは縦の中央に寄せる
export function linePoints(temperatures: number[], width: number, height: number): LinePoint[] {
  const low = Math.min(...temperatures);
  const high = Math.max(...temperatures);
  const span = Math.max(high - low, MIN_SPAN_DEGREES);
  const bottom = (low + high - span) / 2;
  const usable = height - VERTICAL_PADDING * 2;
  const column = width / temperatures.length;
  return temperatures.map((temperature, index) => ({
    x: column * (index + 0.5),
    y: VERTICAL_PADDING + usable * (1 - (temperature - bottom) / span),
  }));
}

// 各点の傾き。前後の傾きの調和平均を使うと、区間の中で値が前後の点を超えない (単調 3 次補間)。
// 上がってから下がる点では 0 にして、そこを山や谷の頂点にする
function tangents(points: LinePoint[]): number[] {
  const slopes = points.slice(1).map((point, index) => (point.y - points[index].y) / (point.x - points[index].x));
  return points.map((_, index) => {
    if (index === 0) return slopes[0] ?? 0;
    if (index === points.length - 1) return slopes[index - 1];
    const [before, after] = [slopes[index - 1], slopes[index]];
    return before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  });
}

// 点の前後で傾きが同じなので、折れ目のない滑らかな線になる
export function linePath(points: LinePoint[]): string {
  const slopes = tangents(points);
  return points
    .map((point, index) => {
      if (index === 0) return `M${point.x} ${point.y}`;
      const previous = points[index - 1];
      const third = (point.x - previous.x) / 3;
      return (
        `C${previous.x + third} ${previous.y + slopes[index - 1] * third} ` +
        `${point.x - third} ${point.y - slopes[index] * third} ${point.x} ${point.y}`
      );
    })
    .join('');
}
