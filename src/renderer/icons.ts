// 天気アイコン。外部素材を使わず 32x32 の SVG を組み立てる。色は style.css の --icon-* で決める。
const CLOUD_PATH = 'M10 23a6 6 0 0 1-.9-11.9A8 8 0 0 1 24.4 13 5 5 0 0 1 24 23Z';
const MOON_PATH = 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z';

function sun(cx: number, cy: number, r: number): string {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const x = (d: number) => (cx + Math.cos(a) * d).toFixed(2);
    const y = (d: number) => (cy + Math.sin(a) * d).toFixed(2);
    return `<line x1="${x(r * 1.5)}" y1="${y(r * 1.5)}" x2="${x(r * 2)}" y2="${y(r * 2)}"/>`;
  }).join('');
  return `<g class="icon-sun"><circle cx="${cx}" cy="${cy}" r="${r}"/>${rays}</g>`;
}

function moon(transform: string): string {
  return `<path class="icon-moon" transform="${transform}" d="${MOON_PATH}"/>`;
}

function cloud(transform = ''): string {
  return `<path class="icon-cloud" transform="${transform}" d="${CLOUD_PATH}"/>`;
}

// 降水を描けるよう、雲を上に寄せる
const RAISED_CLOUD = cloud('translate(0 -4)');

function drops(xs: number[], y1: number, y2: number): string {
  const lines = xs.map((x) => `<line x1="${x}" y1="${y1}" x2="${x - 1.5}" y2="${y2}"/>`).join('');
  return `<g class="icon-rain">${lines}</g>`;
}

function flake(x: number, y: number): string {
  const r = 2.4;
  const dx = (r * Math.sqrt(3)) / 2;
  const dy = r / 2;
  return (
    `<g class="icon-snow"><line x1="${x}" y1="${y - r}" x2="${x}" y2="${y + r}"/>` +
    `<line x1="${x - dx}" y1="${y - dy}" x2="${x + dx}" y2="${y + dy}"/>` +
    `<line x1="${x - dx}" y1="${y + dy}" x2="${x + dx}" y2="${y - dy}"/></g>`
  );
}

function shapes(icon: string, isDay: boolean): string {
  switch (icon) {
    case 'clear':
      return isDay ? sun(16, 16, 6) : moon('translate(2.5 2.5) scale(1.1)');
    case 'mostly-clear':
      return (
        (isDay ? sun(14, 12, 5.5) : moon('translate(1 0) scale(.95)')) +
        cloud('translate(13 15) scale(.58)')
      );
    case 'partly-cloudy':
      return (
        (isDay ? sun(11, 11, 4.5) : moon('translate(0 -1) scale(.72)')) +
        cloud('translate(5 6) scale(.84)')
      );
    case 'fog':
      return `${RAISED_CLOUD}<g class="icon-fog"><line x1="6" y1="23" x2="26" y2="23"/><line x1="9" y1="27.5" x2="23" y2="27.5"/></g>`;
    case 'drizzle':
      return RAISED_CLOUD + drops([12.5, 21.5], 23, 26);
    case 'rain':
      return RAISED_CLOUD + drops([11, 17, 23], 22.5, 28);
    case 'heavy-rain':
      return RAISED_CLOUD + drops([9, 14, 19, 24], 22, 30);
    case 'snow':
      return RAISED_CLOUD + flake(10.5, 25) + flake(21.5, 25);
    case 'sleet':
      return RAISED_CLOUD + drops([11], 22.5, 28) + flake(21, 25);
    case 'thunder':
      return RAISED_CLOUD + '<path class="icon-bolt" d="M17.5 15.5 11.5 24H16l-1.5 6.5L21 21.5h-4.5z"/>';
    default:
      return cloud();
  }
}

export function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

export function weatherIcon(icon: string, isDay: boolean, label: string, size: number): SVGSVGElement {
  const svg = svgElement('svg', {
    viewBox: '0 0 32 32',
    width: size,
    height: size,
    role: 'img',
    'aria-label': label,
    class: 'weather-icon',
  });
  svg.innerHTML = `<title></title>${shapes(icon, isDay)}`;
  svg.querySelector('title')!.textContent = label;
  return svg;
}
