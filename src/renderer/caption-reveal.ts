// 字幕の文字を先頭から順に出すときの、出す文字数の計算 (tour-caption.ts から使う。DOM を使わない)
const CHARS_PER_SECOND = 28; // 日本語を読むのと同じくらいの速さ

// 出し始めてから elapsedMs たったときに出す文字数。requestAnimationFrame の時刻はフレームの始まりなので、
// 出し始めた時刻 (performance.now()) より前になることがある。負の数を slice に渡すと末尾を除いたほぼ全文が
// 一瞬見えてしまったので、0 から全文の文字数までに収める
export function revealedCount(elapsedMs: number, length: number): number {
  return Math.max(0, Math.min(length, Math.floor((elapsedMs / 1000) * CHARS_PER_SECOND)));
}
