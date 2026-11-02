// 過去の時刻を見るスライダー。動かしている間は太陽と時計だけを追従させ、止めたらデータを取りに行く
import { el } from './dom';
import { offsetLabel, TIME_RANGE_MINUTES, TIME_STEP_MINUTES, viewTimeAt } from './time-view';

const COMMIT_DELAY_MS = 300; // キーを続けて押している間は取得しない

export function initTimeControl(
  onPreview: (at: Date | null) => void,
  onCommit: (at: Date | null) => void,
) {
  const slider = el<HTMLInputElement>('time-slider');
  const label = el('time-offset');
  const nowButton = el<HTMLButtonElement>('time-now');
  let timer = 0;
  let view: Date | null = null;
  let committed: Date | null = null;

  slider.min = String(-TIME_RANGE_MINUTES);
  slider.max = '0';
  slider.step = String(TIME_STEP_MINUTES);
  slider.value = '0';

  function show(): void {
    const minutesBefore = -Number(slider.value);
    label.textContent = offsetLabel(minutesBefore);
    nowButton.disabled = minutesBefore === 0;
    slider.style.setProperty('--fill', `${(1 - minutesBefore / TIME_RANGE_MINUTES) * 100}%`);
    el('time-control').classList.toggle('past', minutesBefore !== 0);
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
  nowButton.addEventListener('click', reset);
  label.textContent = offsetLabel(0);
  slider.style.setProperty('--fill', '100%');

  return { reset };
}
