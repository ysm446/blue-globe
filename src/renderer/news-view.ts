// 時計、現在の天気、天気ニュース、24 時間と週間の予報の表示
import { el, formatDateTime } from './dom';
import { linePath, linePoints } from './hourly-chart';
import { svgElement, weatherIcon } from './icons';
import { streamParagraphs } from './stream';

const METHOD_LABEL: Record<NewsOutlook['method'], string> = {
  rule: '気象庁の文を整形',
  llm: '気象庁の文を LLM で要約',
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

// 線の座標は実際の幅で計算する。伸縮させると印が楕円になる
let hourlyShown: NewsReport['hourly'] = [];

function drawHourlyLine(): void {
  const cell = el<HTMLTableCellElement>('hourly-line-cell');
  const width = cell.clientWidth;
  cell.colSpan = Math.max(hourlyShown.length, 1);
  if (width === 0 || hourlyShown.length === 0) return; // 閉じているときは、開いたときに描く
  const points = linePoints(hourlyShown.map((hour) => hour.temperature), width, HOURLY_LINE_HEIGHT);
  const svg = svgElement('svg', {
    class: 'hourly-line',
    width,
    height: HOURLY_LINE_HEIGHT,
    role: 'img',
    'aria-label': `気温の変化: ${hourlyShown.map((hour) => `${hour.time} ${hour.temperature}度`).join('、')}`,
  });
  svg.append(svgElement('path', { d: linePath(points) }));
  const column = width / points.length;
  points.forEach((point, index) => {
    const hour = hourlyShown[index];
    // 印より大きい範囲で、カーソルを合わせた列の値を出す
    const target = svgElement('rect', { x: column * index, y: 0, width: column, height: HOURLY_LINE_HEIGHT });
    const title = svgElement('title', {});
    title.textContent = `${hour.time} ${hour.temperature}° ${hour.weather} 降水 ${rainText(hour.rain)}`;
    target.append(title);
    svg.append(target, svgElement('circle', { cx: point.x, cy: point.y }));
  });
  cell.replaceChildren(svg);
}

export function renderHourly(news: NewsReport): void {
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
  hourlyShown = news.hourly;
  el<HTMLTableCellElement>('hourly-line-cell').colSpan = news.hourly.length;
  drawHourlyLine();
}

function renderWeekly(news: NewsReport): void {
  const textRow = (id: string, format: (d: NewsReport['weekly'][number]) => string): void =>
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
}

export function renderNews(news: NewsReport): void {
  el('headline').textContent = news.headline;
  el('current-icon').replaceChildren(
    weatherIcon(news.current.icon, news.current.is_day, news.current.weather, 52),
  );
  el('clock-icon').replaceChildren(
    weatherIcon(news.current.icon, news.current.is_day, news.current.weather, 60),
  );
  el('clock-temperature').textContent = `${Math.round(news.current.temperature)}°`;
  el('clock-weather').hidden = false;
  el('clock-apparent').textContent = `体感 ${Math.round(news.current.apparent)}°`;
  el('detail-sunrise').textContent = news.current.sunrise ?? '–';
  el('detail-sunset').textContent = news.current.sunset ?? '–';
  el('detail-rain').textContent = rainText(news.current.rain);
  el('detail-rain-icon').replaceChildren(rainDrop(news.current.rain ?? 0, 'now'));
  el('detail-humidity').textContent = `${news.current.humidity}%`;
  el('detail-wind').textContent = `${news.current.wind_speed.toFixed(1)}m/s`;
  el('detail-wind-item').title = `${news.current.wind_direction}寄りの風、最大瞬間 ${news.current.gust.toFixed(1)}m/s`;
  el('clock-details').hidden = false;
  renderHourly(news);
  renderWeekly(news);

  const { outlook } = news;
  el('outlook-text').hidden = !outlook;
  const note = el('outlook-note');
  note.textContent = news.note ?? '';
  note.hidden = !news.note;
  el('original-box').hidden = !outlook?.original || outlook.method === 'verbatim';
  el('original-text').textContent = outlook?.original ?? '';

  const parts = ['予報値: Open-Meteo'];
  if (outlook) {
    parts.push(METHOD_LABEL[outlook.method]);
    if (outlook.model) parts.push(outlook.model);
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

// 地点を変えたとき、前の地点の文を新しい地点のマーカーと並べて見せない
export function hideNews(): void {
  el('news-body').hidden = true;
  el('forecasts').hidden = true;
  el('clock-weather').hidden = true;
  el('clock-details').hidden = true;
}

// PC の時刻を表示する。スリープ復帰後もすぐ合うよう、毎秒確かめて変わったときだけ書き換える
let clockOffsetSeconds: number | null = null; // デモで都市を見せている間は、その都市の現地時刻にする

function updateClock(): void {
  const timeEl = el('clock-time');
  const shifted = clockOffsetSeconds !== null;
  const now = new Date(Date.now() + (clockOffsetSeconds ?? 0) * 1000);
  const timeZone = shifted ? 'UTC' : undefined;
  const time = now.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', timeZone });
  const date = now.toLocaleDateString('ja-JP', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    timeZone,
  });
  const text = `${date} ${time}`;
  if (timeEl.textContent !== text) timeEl.textContent = text;
}

// デモで都市を見せている間は、その都市の時差を渡す。null でパソコンの時刻に戻す
export function setClockOffset(seconds: number | null): void {
  clockOffsetSeconds = seconds;
  updateClock();
}

export function showClockPlace(location: WeatherLocation | null): void {
  el('clock-place-name').textContent = location?.name ?? '';
  el('clock-place').hidden = !location;
}

export function initNewsView(): void {
  updateClock();
  window.setInterval(updateClock, 1000);
  // パネルを開いたときや幅が変わったときに描き直す
  new ResizeObserver(drawHourlyLine).observe(el('fold-hourly'));
}
