// 地域ビューの上部中央に出す方位テープ。向いている方角を中央の ▼ に合わせ、目盛りを横に流す。
// ホームや太陽の方角に印を付ける。テープの外の方角にある印は、端に寄せて矢印を付ける
import { el } from './dom';
import { wrapDegrees } from './math';

const SPAN_DEGREES = 120; // テープに見せる範囲 (左右 60° ずつ)
const TICK_DEGREES = 15;
const LABEL_DEGREES = 45;
const LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const EDGE_MARGIN_DEGREES = 6; // この分だけ端より内側を越えた方角の印は、端に寄せて矢印を付ける
const MARKER_PADDING = 6; // 印とテープの端の間 (px)。style.css の .edge-left と .edge-right と揃える
// 目盛りは -180° から 540° まで並べる。0〜360° のどの方角を中央にしても、左右 60° が並びの中に収まる
const STRIP_START = -180;
const STRIP_END = 540;

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);
}

export interface TapeMarker {
  bearing: number; // 0 が北、90 が東
  icon: string; // SVG の文字列
  label?: string;
  className?: string;
  dim?: boolean;
}

export class HeadingTape {
  private readonly root = el('heading-tape');
  private readonly strip = document.createElement('div');
  private readonly readout = document.createElement('div');
  private readonly markerLayer = document.createElement('div');
  private shown = false;

  constructor() {
    this.strip.className = 'tape-strip';
    for (let degrees = STRIP_START; degrees <= STRIP_END; degrees += TICK_DEGREES) {
      const tick = document.createElement('div');
      const major = degrees % LABEL_DEGREES === 0;
      tick.className = major ? 'tape-tick major' : 'tape-tick';      tick.style.setProperty('--at', String(degrees - STRIP_START));
      if (major) tick.dataset.label = LABELS[(((degrees / LABEL_DEGREES) % 8) + 8) % 8];
      this.strip.append(tick);
    }
    this.readout.className = 'tape-readout';
    this.markerLayer.className = 'tape-markers';
    // 目盛りは窓の中で動かし、窓の左右をぼかす (印はぼかさない)
    const frame = document.createElement('div');
    frame.className = 'tape-window';
    frame.append(this.strip);
    this.root.append(frame, this.markerLayer, this.readout);
  }

  setVisible(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    this.root.classList.toggle('visible', visible);
  }

  get visible(): boolean {
    return this.shown;
  }

  update(heading: number, markers: TapeMarker[]): void {
    const width = this.root.clientWidth;
    const degreePixels = width / SPAN_DEGREES;
    this.root.style.setProperty('--deg', `${degreePixels}px`);
    const center = ((heading % 360) + 360) % 360;
    this.strip.style.transform = `translateX(${width / 2 - (center - STRIP_START) * degreePixels}px)`;
    this.readout.textContent = `${Math.round(center) % 360}°`;

    const half = SPAN_DEGREES / 2 - EDGE_MARGIN_DEGREES;
    this.markerLayer.innerHTML = markers
      .map(({ bearing, icon, label, className, dim }) => {
        const offset = wrapDegrees(bearing - heading);
        const side = offset > half ? 'right' : offset < -half ? 'left' : null;
        const text = label ? `<span>${escapeHtml(label)}</span>` : '';
        const arrow = side ? `<span class="tape-arrow">${side === 'left' ? '◀' : '▶'}</span>` : '';
        const content = side === 'left' ? arrow + icon + text : icon + text + arrow;
        const classes = ['tape-marker', className, dim ? 'dim' : null, side ? `edge-${side}` : null].filter(Boolean).join(' ');
        // テープの外の方角にある印は、文字がはみ出さないよう端に揃えて置く
        const position = side ? '' : `left: ${(width / 2 + offset * degreePixels).toFixed(1)}px`;
        return `<div class="${classes}" style="${position}">${content}</div>`;
      })
      .join('');
    // 端の近くにある長い印も、テープの中に収まるようにずらす
    for (const marker of this.markerLayer.children) {
      if (!(marker instanceof HTMLElement) || !marker.style.left) continue;
      const half = marker.offsetWidth / 2 + MARKER_PADDING;
      const x = Math.min(Math.max(parseFloat(marker.style.left), half), width - half);
      marker.style.left = `${x.toFixed(1)}px`;
    }
  }
}
