// 時計、現在の天気、天気ニュース、24 時間と週間の予報の表示
import { el, formatDateTime, prefersReducedMotion } from './dom';
import { linePath, linePoints, REVEAL_FADE_MS, revealDelayMs, revealTotalMs } from './hourly-chart';
import { svgElement, weatherIcon } from './icons';
import { streamParagraphs } from './stream';

const METHOD_LABEL: Record<NewsOutlook['method'], string> = {
  rule: '気象庁の文を整形',
  verbatim: '気象庁の原文',
};

// 予報の表は時刻や日付を横に並べる。行ごとに、各列のセルの中身を入れる
function fillRow<T>(
  id: string,
  items: T[],
  fill: (cell: HTMLTableCellElement, item: T, index: number) => void,
): void {
  const row = el<HTMLTableRowElement>(id);
  row.querySelectorAll('td').forEach((cell) => cell.remove());
  items.forEach((item, index) => fill(row.insertCell(), item, index));
}

function rainText(rain: number | null): string {
  return rain === null ? '–' : `${rain}%`;
}

const DROP_PATH = 'M5 0C5 0 0 6 0 9a5 5 0 0 0 10 0C10 6 5 0 5 0Z';
const HOURLY_LINE_HEIGHT = 40;

// 降水確率の分だけ下から満たした雫
function rainDrop(rain: number, key: number | string): SVGSVGElement {
  const svg = svgElement('svg', {
    class: 'rain-drop',
    viewBox: '-0.5 -0.5 11 15', // 枠いっぱいに描くと、線の太さの半分が切れる
    width: 10,
    height: 14,
    'aria-hidden': 'true',
  });
  const clipId = `rain-drop-${key}`;
  const clip = svgElement('clipPath', { id: clipId });
  clip.append(svgElement('rect', { x: 0, y: 14 * (1 - rain / 100), width: 10, height: 14 }));
  svg.append(
    clip,
    svgElement('path', {
      d: DROP_PATH,
      fill: 'none',
      stroke: 'var(--icon-rain)',
      'stroke-width': 1,
      'stroke-linejoin': 'round',
    }),
    svgElement('path', { d: DROP_PATH, fill: 'var(--icon-rain)', 'clip-path': `url(#${clipId})` }),
  );
  return svg;
}

// 予報の表の列を左から順に見せる。場所は最初から確保するので、途中で行が動かない。
// 見えるようになったときと内容が変わったときだけで、同じ内容の更新や幅の変更では流し直さない
function columnReveal(foldId: string, rowIds: string[]) {
  let due = true;
  let startedAt = Number.NEGATIVE_INFINITY;
  return {
    contentChanged(): void {
      due = true;
    },
    // 閉じた中の要素は幅が 0 にならないので open でも確かめる
    isVisible(): boolean {
      const fold = el<HTMLDetailsElement>(foldId);
      const visible = fold.open && fold.clientWidth > 0;
      if (!visible) due = true;
      return visible;
    },
    // 流し始める時期なら始める。流し始めてからの経過時間 (ms) を返す
    play(): number {
      if (due) {
        due = false;
        startedAt = prefersReducedMotion() ? Number.NEGATIVE_INFINITY : performance.now();
        if (Number.isFinite(startedAt)) {
          for (const id of rowIds) {
            el(id).querySelectorAll('td').forEach((td, index) => revealItem(td, index, 0));
          }
        }
      }
      return performance.now() - startedAt;
    },
  };
}

// 線の座標は実際の幅で計算する。伸縮させると印が楕円になる
let hourlyShown: NewsReport['hourly'] = [];
const hourlyReveal = columnReveal('fold-hourly', ['hourly-time', 'hourly-icon', 'hourly-temperature', 'hourly-rain']);

let weeklyShown: NewsReport['weekly'] = [];
const weeklyReveal = columnReveal('fold-weekly', ['weekly-day', 'weekly-icon', 'weekly-high', 'weekly-low', 'weekly-rain']);

function syncWeeklyReveal(): void {
  if (weeklyShown.length > 0 && weeklyReveal.isVisible()) weeklyReveal.play();
}

// order 番目に現す。すばやく流し直しても、遅れて始まる前のアニメーションで要素が一瞬消えないよう、前のものは取り消す
function revealItem(element: Element, order: number, elapsed: number): void {
  for (const animation of element.getAnimations()) animation.cancel();
  element.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], {
    duration: REVEAL_FADE_MS,
    delay: revealDelayMs(order) - elapsed,
    easing: 'ease-out',
    fill: 'backwards',
  });
}

// 線は左から伸ばす。横方向に一定の速さなので、各列が現れ始めるときに線の先が列の中央へ届く。
// 線の太さの分だけ外まで見せる。気温が一定だと線の高さが 0 になる
function revealLine(line: Element, columns: number, elapsed: number): void {
  line.animate([{ clipPath: 'inset(-4px 100% -4px -4px)' }, { clipPath: 'inset(-4px -4px -4px -4px)' }], {
    duration: revealDelayMs(columns - 1),
    delay: -elapsed,
    fill: 'backwards',
  });
}

function drawHourlyLine(): void {
  const cell = el<HTMLTableCellElement>('hourly-line-cell');
  const width = cell.clientWidth;
  cell.colSpan = Math.max(hourlyShown.length, 1);
  if (!hourlyReveal.isVisible() || hourlyShown.length === 0) return; // 閉じているときは、開いたときに描く
  const points = linePoints(hourlyShown.map((hour) => hour.temperature), width, HOURLY_LINE_HEIGHT);
  const svg = svgElement('svg', {
    class: 'hourly-line',
    width,
    height: HOURLY_LINE_HEIGHT,
    role: 'img',
    'aria-label': `気温の変化: ${hourlyShown.map((hour) => `${hour.time} ${hour.temperature}度`).join('、')}`,
  });
  const line = svgElement('path', { d: linePath(points) });
  svg.append(line);
  const markers: SVGCircleElement[] = [];
  const column = width / points.length;
  points.forEach((point, index) => {
    const hour = hourlyShown[index];
    // 印より大きい範囲で、カーソルを合わせた列の値を出す
    const target = svgElement('rect', { x: column * index, y: 0, width: column, height: HOURLY_LINE_HEIGHT });
    const title = svgElement('title', {});
    title.textContent = `${hour.time} ${hour.temperature}° ${hour.weather} 降水 ${rainText(hour.rain)}`;
    target.append(title);
    const marker = svgElement('circle', { cx: point.x, cy: point.y });
    markers.push(marker);
    svg.append(target, marker);
  });
  cell.replaceChildren(svg);

  // 流している途中で幅が変わって線を描き直しても、続きから流す
  const elapsed = hourlyReveal.play();
  if (elapsed < revealTotalMs(points.length)) {
    markers.forEach((marker, index) => revealItem(marker, index, elapsed));
    revealLine(line, points.length, elapsed);
  }
}

export function renderHourly(news: NewsReport): void {
  // 同じ内容なら作り直さない。順次表示の途中で切れない
  if (JSON.stringify(news.hourly) === JSON.stringify(hourlyShown)) return;
  const textRow = (id: string, format: (h: NewsReport['hourly'][number]) => string): void =>
    fillRow(id, news.hourly, (cell, hour) => {
      cell.textContent = format(hour);
      cell.title = hour.weather;
    });
  textRow('hourly-time', (h) => h.time);
  textRow('hourly-temperature', (h) => `${h.temperature}°`);
  fillRow('hourly-rain', news.hourly, (cell, hour, index) => {
    cell.title = hour.weather;
    if (hour.rain !== null) cell.append(rainDrop(hour.rain, index));
    cell.append(rainText(hour.rain));
  });
  fillRow('hourly-icon', news.hourly, (cell, hour) => {
    cell.append(weatherIcon(hour.icon, hour.is_day, hour.weather, 26));
  });
  hourlyReveal.contentChanged();
  hourlyShown = news.hourly;
  el<HTMLTableCellElement>('hourly-line-cell').colSpan = news.hourly.length;
  drawHourlyLine();
}

function renderWeekly(news: NewsReport): void {
  // 同じ内容なら作り直さない。順次表示の途中で切れない
  if (JSON.stringify(news.weekly) === JSON.stringify(weeklyShown)) return;
  const textRow =(id: string, format: (d: NewsReport['weekly'][number]) => string): void =>
    fillRow(id, news.weekly, (cell, day, index) => {
      cell.textContent = format(day);
      cell.title = day.weather;
      if (index === 0) cell.className = 'today';
    });
  textRow('weekly-day', (d) => d.label);
  textRow('weekly-high', (d) => `${d.high}°`);
  textRow('weekly-low', (d) => `${d.low}°`);
  textRow('weekly-rain', (d) => rainText(d.rain));
  fillRow('weekly-icon', news.weekly, (cell, day) => {
    cell.append(weatherIcon(day.icon, true, day.weather, 24));
  });
  weeklyReveal.contentChanged();
  weeklyShown = news.weekly;
  syncWeeklyReveal();
}

export function renderNews(news: NewsReport): void {
  el('headline').textContent = news.headline;
  el('current-icon').replaceChildren(
    weatherIcon(news.current.icon, news.current.is_day, news.current.weather, 52),
  );
  el('clock-icon').replaceChildren(
    weatherIcon(news.current.icon, news.current.is_day, news.current.weather, 84),
  );
  el('clock-temperature').textContent = `${Math.round(news.current.temperature)}°`;
  el('clock-weather').hidden = false;
  el('detail-sunrise').textContent = news.current.sunrise ?? '–';
  el('detail-sunset').textContent = news.current.sunset ?? '–';
  el('detail-rain').textContent = rainText(news.current.rain);
  el('detail-rain-icon').replaceChildren(rainDrop(news.current.rain ?? 0, 'now'));
  el('detail-humidity').textContent = `${news.current.humidity}%`;
  el('detail-wind').textContent = `${news.current.wind_speed.toFixed(1)}m/s`;
  el('detail-wind-item').title = `${news.current.wind_direction}寄りの風、最大瞬間 ${news.current.gust.toFixed(1)}m/s`;
  el('clock-details').hidden = false;
  revealClockWeather(news.location);
  renderHourly(news);
  renderWeekly(news);

  const { outlook } = news;
  el('outlook-text').hidden = !outlook;
  const note = el('outlook-note');
  note.textContent = news.note ?? '';
  note.hidden = !news.note;
  el('original-box').hidden = !outlook?.original || outlook.method === 'verbatim';
  el('original-text').textContent = outlook?.original ?? '';

  el('hourly-title').textContent = news.at ? 'この時刻から24時間' : 'これから24時間';
  const parts = [news.at ? '過去の値: Open-Meteo' : '予報値: Open-Meteo'];
  if (outlook) {
    parts.push(METHOD_LABEL[outlook.method]);
    if (outlook.reported_at) parts.push(`${formatDateTime(new Date(outlook.reported_at), 'Asia/Tokyo')} 発表`);
  }
  el('outlook-source').textContent = parts.join('・');
  el('news-body').hidden = false;
  el('forecasts').hidden = false;
  streamParagraphs([
    [el('current-text'), news.current_text],
    [el('day-text'), news.day_text],
    [el('outlook-text'), outlook?.text ?? ''],
  ]);
}

// 左上のパネルを読む順に見せる。値は 15 分ごとにほぼ必ず変わるので、場所が変わったときだけ流す
const CLOCK_PLACE_ITEMS = 3; // 地名、時刻、日付。天気はその次から現す
let clockPlaceName: string | null = null;
let clockWeatherPlace: string | null = null;

function revealInOrder(elements: Element[], first = 0): void {
  if (prefersReducedMotion()) return;
  elements.forEach((element, index) => revealItem(element, first + index, 0));
}

function revealClockWeather(location: WeatherLocation): void {
  const place = `${location.latitude},${location.longitude}`;
  if (place === clockWeatherPlace) return;
  clockWeatherPlace = place;
  revealInOrder(
    [el('clock-icon'), el('clock-temperature'), ...document.querySelectorAll('#clock-details .detail-row > div')],
    CLOCK_PLACE_ITEMS,
  );
}

// 地点を変えたとき、前の地点の文を新しい地点のマーカーと並べて見せない
export function hideNews(): void {
  clockWeatherPlace = null;
  el('news-body').hidden = true;
  el('forecasts').hidden = true;
  el('clock-weather').hidden = true;
  el('clock-details').hidden = true;
}

// PC の時刻を表示する。スリープ復帰後もすぐ合うよう、毎秒確かめて変わったときだけ書き換える
let clockOffsetSeconds: number | null = null; // デモで都市を見せている間は、その都市の現地時刻にする
let clockViewTime: Date | null = null; // 過去の時刻を見ている間は、その時刻で止める

function updateClock(): void {
  const timeEl = el('clock-time');
  const dateEl = el('clock-date');
  const shifted = clockOffsetSeconds !== null;
  const now = new Date((clockViewTime?.getTime() ?? Date.now()) + (clockOffsetSeconds ?? 0) * 1000);
  const timeZone = shifted ? 'UTC' : undefined;
  const time = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone });
  const date = now.toLocaleDateString('ja-JP', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    timeZone,
  });
  if (timeEl.textContent !== time) timeEl.textContent = time;
  if (dateEl.textContent !== date) dateEl.textContent = date;
}

// 過去の時刻を見ている間は、その時刻を渡す。null で今の時刻に戻す
export function setClockTime(at: Date | null): void {
  clockViewTime = at;
  updateClock();
}

// デモで都市を見せている間は、その都市の時差を渡す。null でパソコンの時刻に戻す
export function setClockOffset(seconds: number | null): void {
  clockOffsetSeconds = seconds;
  updateClock();
}

export function showClockPlace(location: WeatherLocation | null): void {
  const name = location?.name ?? '';
  el('clock-place-name').textContent = name;
  el('clock-place').hidden = !location;
  if (name === clockPlaceName) return;
  // 起動時は時刻がすでに出ているので、地名だけを流す
  revealInOrder(clockPlaceName === null ? [el('clock-place')] : [el('clock-place'), el('clock-time'), el('clock-date')]);
  clockPlaceName = name;
}

export function initNewsView(): void {
  updateClock();
  revealInOrder([el('clock-time'), el('clock-date')]);
  window.setInterval(updateClock, 1000);
  // パネルを開いたときや幅が変わったときに描き直す
  new ResizeObserver(drawHourlyLine).observe(el('fold-hourly'));
  new ResizeObserver(syncWeeklyReveal).observe(el('fold-weekly'));
}
