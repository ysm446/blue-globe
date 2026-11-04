// 過去の時刻を見るスライダー。動かしている間は太陽と時計だけを追従させ、止めたらデータを取りに行く。
// 太陽と時計は選んだ時刻へ一瞬で切り替えず、なめらかに追いつかせる。
// スライダーの下には、範囲の中の日の出 (▲) と日の入り (▼) の位置に印を置く
import { sunEvents, type SunEvent } from './astro';
import { el } from './dom';
import type { LonLat } from './math';
import { offsetLabel, smoothTowards, TIME_RANGE_MINUTES, TIME_STEP_MINUTES, viewTimeAt } from './time-view';

const COMMIT_DELAY_MS = 300; // キーを続けて押している間は取得しない
const SUN_MARKS_UPDATE_MS = 60_000; // 範囲は今の時刻とともにずれる
// 太陽のアイコンは小さく縮めると矢印の向きが見えないので、三角形にする (viewBox 0 0 8 7)
const SUN_MARKS: Record<SunEvent['kind'], { points: string; label: string }> = {
  sunrise: { points: '4,0 8,7 0,7', label: '日の出' },
  sunset: { points: '0,0 8,0 4,7', label: '日の入り' },
};
const FOLLOW_SECONDS = 0.7; // 選んだ時刻へ追いつく速さ。24 時間動かすと、1 秒で約 8 割、2 秒でほぼ着く
const ARRIVED_MINUTES = 0.25; // ここまで近づいたら、選んだ時刻にそろえて止める

export function initTimeControl(
  onPreview: (at: Date | null) => void,
  onCommit: (at: Date | null) => void,
) {
  const slider = el<HTMLInputElement>('time-slider');
  let timer = 0;
  let view: Date | null = null;
  let committed: Date | null = null;
  // 画面に出している時刻と、その動く速さ (何分前か、分/秒)
  let shownMinutes = 0;
  let velocity = 0;
  let frame = 0;
  let lastFrameTime = 0;

  slider.min = String(-TIME_RANGE_MINUTES);
  slider.max = '0';
  slider.step = String(TIME_STEP_MINUTES);
  slider.value = '0';

  function goalMinutes(): number {
    return -Number(slider.value);
  }

  function follow(time: number): void {
    // 最初のフレームの時刻は、動かし始めた時刻よりわずかに前のことがある
    const dt = Math.min(0.1, Math.max(0, (time - lastFrameTime) / 1000));
    lastFrameTime = time;
    const goal = goalMinutes();
    ({ value: shownMinutes, velocity } = smoothTowards(shownMinutes, goal, velocity, FOLLOW_SECONDS, dt));
    const arrived = Math.abs(goal - shownMinutes) < ARRIVED_MINUTES && Math.abs(velocity) < ARRIVED_MINUTES;
    if (arrived) {
      shownMinutes = goal;
      velocity = 0;
    }
    onPreview(viewTimeAt(shownMinutes));
    frame = arrived ? 0 : requestAnimationFrame(follow);
  }

  function show(): void {
    const minutesBefore = goalMinutes();
    slider.setAttribute('aria-valuetext', offsetLabel(minutesBefore)); // 画面には出さず、読み上げに使う
    slider.style.setProperty('--fill', `${(1 - minutesBefore / TIME_RANGE_MINUTES) * 100}%`);
    view = viewTimeAt(minutesBefore);
    if (frame === 0) {
      lastFrameTime = performance.now();
      frame = requestAnimationFrame(follow);
    }
  }

  function commit(): void {
    window.clearTimeout(timer);
    if (view?.getTime() === committed?.getTime()) return;
    committed = view;
    onCommit(view);
  }

  const sunMarks = el('sun-marks');
  let sunPlace: LonLat | null = null;
  let sunOffsetSeconds: number | null = null;

  // 時計と同じく、時差が分かっている都市はその現地時刻、それ以外はパソコンの時刻で出す
  function clockLabel(at: Date): string {
    const shifted = sunOffsetSeconds !== null;
    const local = new Date(at.getTime() + (sunOffsetSeconds ?? 0) * 1000);
    return local.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: shifted ? 'UTC' : undefined });
  }

  // 位置はスライダーの値と同じく、左端が 24 時間前、右端が今
  function renderSunMarks(): void {
    if (!sunPlace) {
      sunMarks.replaceChildren();
      return;
    }
    const now = Date.now();
    const from = new Date(now - TIME_RANGE_MINUTES * 60_000);
    sunMarks.innerHTML = sunEvents(sunPlace, from, new Date(now))
      .map(({ kind, at }) => {
        const position = (at.getTime() - from.getTime()) / (TIME_RANGE_MINUTES * 60_000);
        const { points, label } = SUN_MARKS[kind];
        return (
          `<svg viewBox="0 0 8 7" style="--at: ${position.toFixed(4)}">` +
          `<title>${label} ${clockLabel(at)}</title><polygon points="${points}" /></svg>`
        );
      })
      .join('');
  }
  window.setInterval(renderSunMarks, SUN_MARKS_UPDATE_MS);

  // 時計に出している場所 (設定の場所か、選んだ都市) と、時計の時差 (null はパソコンの時刻)。null で印を消す
  function setSunPlace(place: LonLat | null, offsetSeconds: number | null): void {
    sunPlace = place;
    sunOffsetSeconds = offsetSeconds;
    renderSunMarks();
  }

  // 今の時刻へすぐに戻す (デモを始めるとき)
  function reset(): void {
    cancelAnimationFrame(frame);
    frame = 0;
    slider.value = '0';
    shownMinutes = 0;
    velocity = 0;
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

  return { reset, setSunPlace };
}
