// 右下の「表示」ボタンと、押すと開く表示の切り替えのメニュー。設定の「表示」と同じ値を切り替えて保存する
import { el } from './dom';

type DisplayKey =
  | 'show_map_lines'
  | 'show_country_labels'
  | 'show_population'
  | 'show_city_labels'
  | 'show_planet_labels'
  | 'show_constellations'
  | 'show_heading_tape'
  | 'show_scale_bar';

interface DisplayItem {
  key: DisplayKey;
  label: string;
  // その視点とモードで効かないときの理由 (薄くして、説明に出す)。効くときは null
  inactive: (mode: MapMode, view: GlobeView) => string | null;
}

const ITEMS: DisplayItem[] = [
  {
    key: 'show_map_lines',
    label: '海岸線と国境線',
    inactive: (mode, view) => (view === 'solar' ? '太陽系では出ません' : mode === 'wind' ? '風速モードではいつも描きます' : null),
  },
  { key: 'show_country_labels', label: '国名', inactive: (_mode, view) => (view === 'solar' ? '太陽系では出ません' : null) },
  { key: 'show_city_labels', label: '都市名', inactive: (_mode, view) => (view === 'solar' ? '太陽系では出ません' : null) },
  {
    key: 'show_population',
    label: '人口の分布',
    inactive: (mode, view) => (view === 'solar' ? '太陽系では出ません' : mode === 'wind' ? '風速モードでは出ません' : null),
  },
  { key: 'show_planet_labels', label: '惑星の名前', inactive: (mode) => (mode === 'wind' ? '風速モードでは出ません' : null) },
  { key: 'show_constellations', label: '星座の線', inactive: (mode) => (mode === 'wind' ? '風速モードでは出ません' : null) },
  { key: 'show_heading_tape', label: '方位のメーター', inactive: (_mode, view) => (view === 'region' ? null : '地域ビューで動いている間だけ出ます') },
  { key: 'show_scale_bar', label: '縮尺のバー', inactive: (_mode, view) => (view === 'solar' ? '太陽系では出ません' : null) },
];

const MENU_GAP = 8; // ボタンとメニューの間 (px)
const EDGE = 8; // 画面の端との間 (px)

export function initDisplayMenu(onChange: (changes: Partial<GraphicsSettings>) => void) {
  const toggle = el<HTMLButtonElement>('display-toggle');
  const menu = el('display-menu');
  let graphics: GraphicsSettings | null = null;
  let mode: MapMode = 'normal';
  let view: GlobeView = 'globe';

  const buttons = ITEMS.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'display-item';
    button.textContent = item.label;
    button.addEventListener('click', () => {
      if (!graphics) return;
      onChange({ [item.key]: !graphics[item.key] });
    });
    menu.append(button);
    return button;
  });

  function render(): void {
    ITEMS.forEach((item, i) => {
      const button = buttons[i];
      button.setAttribute('aria-pressed', String(graphics?.[item.key] ?? false));
      const reason = item.inactive(mode, view);
      button.classList.toggle('inactive', reason !== null);
      button.title = reason ?? '';
    });
  }

  // 右下の並びは、狭い画面では画面の上に移るので、空きのある側 (ふだんは上) へ開く
  function place(): void {
    const anchor = toggle.getBoundingClientRect();
    const above = anchor.top - MENU_GAP - menu.offsetHeight >= EDGE;
    menu.style.top = `${above ? anchor.top - MENU_GAP - menu.offsetHeight : anchor.bottom + MENU_GAP}px`;
    // ボタンは右下の並びの左端にあるので、メニューの左端をボタンの左端にそろえる
    menu.style.left = `${Math.max(EDGE, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - EDGE))}px`;
  }

  function setOpen(open: boolean): void {
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      render();
      place();
    }
  }

  toggle.addEventListener('click', () => {
    setOpen(menu.hidden);
    toggle.blur(); // フォーカスが残ると W/A/S/D などが効かないことがある
  });
  // メニューの外を押したら閉じる (地球のドラッグを始めたときも閉じる)
  document.addEventListener('pointerdown', (event) => {
    if (menu.hidden || !(event.target instanceof Node)) return;
    if (!menu.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  });
  // 捕捉の段で受け、ツアーなど Esc で終わるものより先に閉じる (開いているときだけ)
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || menu.hidden) return;
      event.stopImmediatePropagation();
      setOpen(false);
    },
    true,
  );
  window.addEventListener('resize', () => {
    if (!menu.hidden) place();
  });

  return {
    // 設定が変わったら合わせる (設定画面やメニューで変えたとき、起動したとき)
    sync(next: GraphicsSettings): void {
      graphics = next;
      render();
    },
    // 今の表示モードと視点。効かない項目を薄くする
    setContext(nextMode: MapMode, nextView: GlobeView): void {
      mode = nextMode;
      view = nextView;
      render();
    },
  };
}
