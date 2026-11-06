// 過去の時刻を見るスライダー。動かしている間は太陽と時計だけを追従させ、止めたらデータを取りに行く。
// 太陽と時計は選んだ時刻へ一瞬で切り替えず、なめらかに追いつかせる。
// スライダーの下には、範囲の中の日の出 (▲) と日の入り (▼) の位置に印を置く。
// 日付を押すと、3 日前までの日を選ぶメニューが開く。今日はスライダーが今から 24 時間前まで、
// 過去の日はその日の 0 時から 24 時までを動かす
import { sunEvents, type SunEvent } from './astro';
import { el } from './dom';
import type { LonLat } from './math';
import {
  dayStart,
  MAX_DAYS_BACK,
  offsetLabel,
  sliderValueForDay,
  smoothTowards,
  TIME_STEP_MINUTES,
  viewTimeAt,
  windowMax,
  windowStart,
} from './time-view';

const COMMIT_DELAY_MS = 300; // キーを続けて押している間は取得しない
const SUN_MARKS_UPDATE_MS = 60_000; // 範囲は今の時刻とともにずれる
// 太陽のアイコンは小さく縮めると矢印の向きが見えないので、三角形にする (viewBox 0 0 8 7)
const SUN_MARKS: Record<SunEvent['kind'], { points: string; label: string }> = {
  sunrise: { points: '4,0 8,7 0,7', label: '日の出' },
  sunset: { points: '0,0 8,0 4,7', label: '日の入り' },
};
const FOLLOW_SECONDS = 0.7; // 選んだ時刻へ追いつく速さ。24 時間動かすと、1 秒で約 8 割、2 秒でほぼ着く
const ARRIVED_MINUTES = 0.25; // ここまで近づいたら、選んだ時刻にそろえて止める
const DAY_NOTES = ['今日', '昨日', '2日前', '3日前'];
const MENU_GAP = 6; // 日付とメニューの間 (px)
const EDGE = 8; // 画面の端との間 (px)

export function initTimeControl(
  onPreview: (at: Date | null) => void,
  onCommit: (at: Date | null) => void,
) {
  const slider = el<HTMLInputElement>('time-slider');
  const dateButton = el('clock-date');
  const dateMenu = el('date-menu');
  let daysBack = 0; // 選んでいる日。0 は今日
  let timer = 0;
  let view: Date | null = null;
  let committed: Date | null = null;
  // 画面に出している時刻と、その動く速さ (何分前か、分/秒)
  let shownMinutes = 0;
  let velocity = 0;
  let frame = 0;
  let lastFrameTime = 0;
  let sunPlace: LonLat | null = null;
  let sunOffsetSeconds: number | null = null; // 時計の時差。null はパソコンの時刻

  slider.min = '0';
  slider.max = String(windowMax(0));
  slider.step = String(TIME_STEP_MINUTES);
  slider.value = slider.max;

  // スライダーで選んでいる時刻。今日の右端は今で、null
  function goalTime(now = Date.now()): number | null {
    const value = Number(slider.value);
    if (daysBack === 0 && value === windowMax(0)) return null;
    return windowStart(daysBack, now, sunOffsetSeconds) + value * 60_000;
  }

  // 選んでいる時刻が何分前か
  function goalMinutes(): number {
    const now = Date.now();
    const goal = goalTime(now);
    return goal === null ? 0 : (now - goal) / 60_000;
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
    view = viewTimeAt(minutesBefore);
    // 画面には出さず、読み上げに使う
    slider.setAttribute(
      'aria-valuetext',
      view && daysBack > 0 ? `${dayLabel(daysBack)} ${clockLabel(view)}` : offsetLabel(Math.round(minutesBefore)),
    );
    slider.style.setProperty('--fill', `${(Number(slider.value) / Number(slider.max)) * 100}%`);
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

  // 時計と同じく、時差が分かっている都市はその現地時刻、それ以外はパソコンの時刻で出す
  function clockLabel(at: Date): string {
    const shifted = sunOffsetSeconds !== null;
    const local = new Date(at.getTime() + (sunOffsetSeconds ?? 0) * 1000);
    return local.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone: shifted ? 'UTC' : undefined });
  }

  // 時計の日付と同じ書き方で、days 日前の日付を出す
  function dayLabel(days: number): string {
    const shifted = sunOffsetSeconds !== null;
    const noon = dayStart(days, Date.now(), sunOffsetSeconds) + 12 * 3600_000 + (sunOffsetSeconds ?? 0) * 1000;
    return new Date(noon).toLocaleDateString('ja-JP', {
      month: 'long',
      day: 'numeric',
      weekday: 'short',
      timeZone: shifted ? 'UTC' : undefined,
    });
  }

  // 位置はスライダーの値と同じく、左端が範囲の始まり、右端がスライダーの右端
  function renderSunMarks(): void {
    if (!sunPlace) {
      sunMarks.replaceChildren();
      return;
    }
    const span = Number(slider.max) * 60_000;
    const from = new Date(windowStart(daysBack, Date.now(), sunOffsetSeconds));
    sunMarks.innerHTML = sunEvents(sunPlace, from, new Date(from.getTime() + span))
      .map(({ kind, at }) => {
        const position = (at.getTime() - from.getTime()) / span;
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
    if (!dateMenu.hidden) renderMenu();
  }

  // 日を切り替える。動かしている途中の時刻は追わず、選んだ日の時刻へすぐに移す
  // (何日分も追いかけると昼と夜が目まぐるしく入れ替わる)。value を省くと、見ている時刻の時と分を保つ
  function selectDay(days: number, value?: number): void {
    const from = goalTime() ?? Date.now();
    daysBack = days;
    slider.max = String(windowMax(days));
    slider.value = String(value ?? sliderValueForDay(days, from, Date.now(), sunOffsetSeconds));
    cancelAnimationFrame(frame);
    frame = 0;
    shownMinutes = goalMinutes();
    velocity = 0;
    show();
    commit();
    renderSunMarks();
  }

  // 今の時刻へすぐに戻す (デモを始めるとき)
  function reset(): void {
    setMenuOpen(false);
    selectDay(0, windowMax(0));
  }

  const dayButtons = DAY_NOTES.slice(0, MAX_DAYS_BACK + 1).map((note, days) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'date-item';
    button.setAttribute('role', 'menuitemradio');
    button.addEventListener('click', () => {
      setMenuOpen(false);
      if (days !== daysBack) selectDay(days);
    });
    dateMenu.append(button);
    return { button, note };
  });

  function renderMenu(): void {
    dayButtons.forEach(({ button, note }, days) => {
      button.innerHTML = `<span>${dayLabel(days)}</span><span class="date-note">${note}</span>`;
      button.setAttribute('aria-checked', String(days === daysBack));
    });
  }

  // 日付の下に、右端を日付の右端にそろえて開く。下に収まらなければ上へ
  function placeMenu(): void {
    const anchor = dateButton.getBoundingClientRect();
    const below = anchor.bottom + MENU_GAP + dateMenu.offsetHeight <= window.innerHeight - EDGE;
    dateMenu.style.top = `${below ? anchor.bottom + MENU_GAP : anchor.top - MENU_GAP - dateMenu.offsetHeight}px`;
    const left = anchor.right - dateMenu.offsetWidth;
    dateMenu.style.left = `${Math.max(EDGE, Math.min(left, window.innerWidth - dateMenu.offsetWidth - EDGE))}px`;
  }

  function setMenuOpen(open: boolean): void {
    dateMenu.hidden = !open;
    dateButton.setAttribute('aria-expanded', String(open));
    if (open) {
      renderMenu();
      placeMenu();
    }
  }

  dateButton.addEventListener('click', () => {
    setMenuOpen(dateMenu.hidden);
    dateButton.blur(); // フォーカスが残ると W/A/S/D などが効かないことがある
  });
  dateButton.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setMenuOpen(dateMenu.hidden);
  });
  // メニューの外を押したら閉じる (地球のドラッグを始めたときも閉じる)
  document.addEventListener('pointerdown', (event) => {
    if (dateMenu.hidden || !(event.target instanceof Node)) return;
    if (!dateMenu.contains(event.target) && !dateButton.contains(event.target)) setMenuOpen(false);
  });
  // 捕捉の段で受け、ツアーなど Esc で終わるものより先に閉じる (開いているときだけ)
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || dateMenu.hidden) return;
      event.stopImmediatePropagation();
      setMenuOpen(false);
    },
    true,
  );
  window.addEventListener('resize', () => {
    if (!dateMenu.hidden) placeMenu();
  });

  slider.addEventListener('input', show);
  slider.addEventListener('change', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(commit, COMMIT_DELAY_MS);
  });
  slider.setAttribute('aria-valuetext', offsetLabel(0));
  slider.style.setProperty('--fill', '100%');

  return { reset, setSunPlace };
}
