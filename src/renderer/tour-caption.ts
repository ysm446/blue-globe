// ツアーの字幕。画面の下の中央 (操作のボタンの列の上) に説明の文を出す。
// 文字は先頭から順に現れる (ストリーミング表示)。板の大きさが文字の増えるたびに変わらないよう、
// 最初から全文を置き、まだ出していない部分は透明にしておく。
// ツアーの再生中は下に場面の番号と操作の案内 (footer) を出し、クリックで次へ進める
import { revealedCount } from './caption-reveal';

export class TourCaption {
  private readonly body = document.createElement('span');
  private readonly shownPart = document.createElement('span');
  private readonly hiddenPart = document.createElement('span');
  private readonly footer = document.createElement('span');
  private characters: string[] = [];
  private revealed = 0;
  private startedAt = 0;
  private frame: number | null = null;
  private hideTimer: number | null = null;
  private hideAfter: number | undefined;
  private clickHandler: (() => void) | null = null;

  constructor(private readonly element: HTMLElement) {
    this.hiddenPart.className = 'pending';
    this.footer.className = 'tour-footer';
    this.body.append(this.shownPart, this.hiddenPart);
    element.append(this.body, this.footer);
    this.footer.hidden = true;
    element.addEventListener('click', () => this.clickHandler?.());
  }

  onClick(handler: () => void): void {
    this.clickHandler = handler;
  }

  // ツアーの案内。null で消し、字幕はクリックできなくなる
  setFooter(text: string | null): void {
    this.footer.hidden = text === null;
    this.footer.textContent = text ?? '';
    this.element.classList.toggle('interactive', text !== null);
  }

  get streaming(): boolean {
    return this.frame !== null;
  }

  // seconds を渡すと、全文を出し終えてからその秒数のあとに消す。省くと clear まで出したまま
  show(text: string, seconds?: number): void {
    this.stop();
    // サロゲートペア (絵文字など) を途中で切らないよう、文字ごとに分ける
    this.characters = Array.from(text);
    this.revealed = 0;
    this.hideAfter = seconds;
    this.shownPart.textContent = '';
    this.hiddenPart.textContent = text;
    this.body.hidden = text.length === 0;
    this.element.classList.toggle('shown', text.length > 0 || !this.footer.hidden);
    if (text.length === 0) return;
    this.startedAt = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  // 残りをすぐに全部出す
  finish(): void {
    if (this.frame === null) return;
    this.revealed = this.characters.length;
    this.render();
    this.done();
  }

  clear(): void {
    this.stop();
    this.element.classList.remove('shown');
  }

  private readonly tick = (now: number): void => {
    const count = revealedCount(now - this.startedAt, this.characters.length);
    if (count !== this.revealed) {
      this.revealed = count;
      this.render();
    }
    if (this.revealed >= this.characters.length) this.done();
    else this.frame = requestAnimationFrame(this.tick);
  };

  private render(): void {
    this.shownPart.textContent = this.characters.slice(0, this.revealed).join('');
    this.hiddenPart.textContent = this.characters.slice(this.revealed).join('');
  }

  private done(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.hideAfter !== undefined && this.hideAfter > 0) {
      this.hideTimer = window.setTimeout(() => this.clear(), this.hideAfter * 1000);
    }
  }

  private stop(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}
