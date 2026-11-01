// 雲の現れ方と消え方。FPS によらず同じ時間で変わるように、経過時間で進める
const FADE_IN_SECONDS = 1.6;
const FADE_OUT_SECONDS = 0.7;

// progress は 0 (消えている) 〜 1 (見えている)
export function stepFade(progress: number, visible: boolean, dt: number): number {
  const next = visible ? progress + dt / FADE_IN_SECONDS : progress - dt / FADE_OUT_SECONDS;
  return Math.min(1, Math.max(0, next));
}

// 動き始めと終わりをなめらかにする
export function easeFade(progress: number): number {
  return progress * progress * (3 - 2 * progress);
}
