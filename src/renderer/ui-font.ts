// 画面の文字のフォント。時計と気温の大きな数字は別のフォントのまま
// 鍵は設定ファイルに保存する名前。server/api.py の GraphicsUpdate と合わせる
export const UI_FONTS: Record<UiFont, string> = {
  'noto-sans-jp': 'Noto Sans JP',
  'yu-gothic-ui': 'Yu Gothic UI',
  'meiryo-ui': 'Meiryo UI',
  'biz-udp-gothic': 'BIZ UDPGothic',
  'yu-mincho': 'Yu Mincho',
};

// 入っていないフォントを選んでも、style.css の続きの游ゴシック UI で表示される
export function applyUiFont(font: UiFont): void {
  document.documentElement.style.setProperty('--ui-font', `'${UI_FONTS[font] ?? UI_FONTS['noto-sans-jp']}'`);
}

// 英字と日本語の幅が、どちらの代わりのフォントとも違えば入っているとみなす
export function isFontInstalled(family: string): boolean {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return true;
  const sample = 'mmwwiil あ漢字 0123';
  return ['monospace', 'serif'].some((fallback) => {
    ctx.font = `32px ${fallback}`;
    const plain = ctx.measureText(sample).width;
    ctx.font = `32px '${family}', ${fallback}`;
    return ctx.measureText(sample).width !== plain;
  });
}
