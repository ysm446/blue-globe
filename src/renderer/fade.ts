// 雲の現れ方と消え方。FPS によらず同じ時間で変わるように、経過時間で進める
import { clamp } from './math.ts';

const FADE_IN_SECONDS = 1.6;
const FADE_OUT_SECONDS = 0.7;

// progress は 0 (消えている) 〜 1 (見えている)
export function stepFade(progress: number, visible: boolean, dt: number): number {
  const next = visible ? progress + dt / FADE_IN_SECONDS : progress - dt / FADE_OUT_SECONDS;
  return clamp(next, 0, 1);
}
