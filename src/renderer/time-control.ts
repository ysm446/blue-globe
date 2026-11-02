// 過去の時刻を見るスライダー。動かしている間は太陽と時計だけを追従させ、止めたらデータを取りに行く
import { el } from './dom';
import { offsetLabel, TIME_RANGE_MINUTES, TIME_STEP_MINUTES, viewTimeAt } from './time-view';

const COMMIT_DELAY_MS = 300; // キーを続けて押している間は取得しない

export function initTimeControl(
  onPreview: (at: Date | null) => void,
  onCommit: (at: Date | null) => void,
) {
  const slider = el<HTMLInputElement>('time-slider');
  let timer = 0;
  let view: Date | null = null;
  let committed: Date | null = null;

  slider.min = String(-TIME_RANGE_MINUTES);
  slider.max = '0';
  slider.step = String(TIME_STEP_MINUTES);
  slider.value = '0';

  function show(): void {
    const minutesBefore = -Number(slider.value);
    slider.setAttribute('aria-valuetext', offsetLabel(minutesBefore)); // 画面には出さず、読み上げに使う
    slider.style.setProperty('--fill', `${(1 - minutesBefore / TIME_RANGE_MINUTES) * 100}%`);
    view = viewTimeAt(minutesBefore);
    onPreview(view);
  }

  function commit(): void {
    window.clearTimeout(timer);
    if (view?.getTime() === committed?.getTime()) return;
    committed = view;
    onCommit(view);
  }

  function reset(): void {
    slider.value = '0';
    show();
    commit();
  }

  slider.addEventListener('input', show);
  slider.addEventListener('change', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(commit, COMMIT_DELAY_MS);
  });
  slider.setAttribute('aria-valuetext', offsetLabel(0));
  slider.style.setProperty('--fill', '100%');

  return { reset };
}
