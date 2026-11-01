// 文章を 1 文字ずつ順に見せる表示。文字の場所は最初から確保するので、途中で行が動かない。
// 内容が変わった段落だけを、上から順に流す
const CHAR_MS = 26;
const PARAGRAPH_PAUSE_MS = 160;
const CHAR_FADE_MS = 200; // style.css の .stream-char と合わせる

export interface StreamStep {
  animate: boolean;
  startMs: number;
  durationMs: number;
}

export function planStream(next: string[], shown: string[]): StreamStep[] {
  let cursor = 0;
  return next.map((text, index) => {
    const length = Array.from(text).length;
    if (text === shown[index] || length === 0) return { animate: false, startMs: 0, durationMs: 0 };
    const step = { animate: true, startMs: cursor, durationMs: length * CHAR_MS + CHAR_FADE_MS };
    cursor += length * CHAR_MS + PARAGRAPH_PAUSE_MS;
    return step;
  });
}

const shownText = new WeakMap<HTMLElement, string>();
const finishTimers = new WeakMap<HTMLElement, number>();

function setPlainText(element: HTMLElement, text: string): void {
  window.clearTimeout(finishTimers.get(element));
  element.textContent = text;
}

function startParagraph(element: HTMLElement, text: string, step: StreamStep): void {
  window.clearTimeout(finishTimers.get(element));
  element.replaceChildren(
    ...Array.from(text).map((char, index) => {
      const span = document.createElement('span');
      span.className = 'stream-char';
      span.style.animationDelay = `${step.startMs + index * CHAR_MS}ms`;
      span.textContent = char;
      return span;
    }),
  );
  // 終わったら普通の文字列へ戻す (選択やコピー、読み上げのため)
  finishTimers.set(
    element,
    window.setTimeout(() => {
      element.textContent = text;
    }, step.startMs + step.durationMs),
  );
}

export function streamParagraphs(paragraphs: Array<[HTMLElement, string]>): void {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const plan = planStream(
    paragraphs.map(([, text]) => text),
    paragraphs.map(([element]) => shownText.get(element) ?? ''),
  );
  paragraphs.forEach(([element, text], index) => {
    const changed = shownText.get(element) !== text;
    shownText.set(element, text);
    if (plan[index].animate && !reduceMotion) startParagraph(element, text, plan[index]);
    else if (changed) setPlainText(element, text);
  });
}
