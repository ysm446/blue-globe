// ツアーの再生。場面の並び (ハイライト、字幕、カメラ) を受け取り、字幕をクリックするたびに次の場面へ進む。
// 最後の場面でクリックすると最初に戻り、何度でも繰り返せる。Esc で終える
import type { HighlightSpec } from './highlights';
import type { TourCaption } from './tour-caption';

export interface TourCamera {
  heading?: number; // 方角 (省くと今のまま)
  tilt?: number; // 傾き (省くと今のまま)
  orbit?: number; // 着いてから中心のまわりを回る速さ。旋回の段 (-5〜5。正が右回り)。省くと回らない
}

export interface TourScene {
  highlights: HighlightSpec[];
  caption?: string;
  camera?: TourCamera;
}

export interface TourHost {
  showHighlights(specs: HighlightSpec[]): Promise<void>;
  clearHighlights(): void;
  frame(camera: TourCamera): void;
  stopMotion(): void; // 旋回を止める
}

export class TourPlayer {
  private scenes: TourScene[] = [];
  private index = -1;
  private busy = false;

  constructor(
    private readonly caption: TourCaption,
    private readonly host: TourHost,
  ) {
    caption.onClick(() => this.advance());
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.active) this.stop();
    });
  }

  get active(): boolean {
    return this.index >= 0;
  }

  get position(): { index: number; total: number } {
    return { index: this.index, total: this.scenes.length };
  }

  start(scenes: TourScene[]): void {
    if (scenes.length === 0) return;
    this.scenes = scenes;
    void this.play(0);
  }

  stop(): void {
    this.index = -1;
    this.scenes = [];
    this.host.stopMotion();
    this.host.clearHighlights();
    this.caption.setFooter(null);
    this.caption.clear();
  }

  // 文字を出している途中なら残りを出し切り、出し終えていれば次の場面へ (最後なら最初へ) 進む
  private advance(): void {
    if (!this.active || this.busy) return;
    if (this.caption.streaming) {
      this.caption.finish();
      return;
    }
    void this.play((this.index + 1) % this.scenes.length);
  }

  private async play(index: number): Promise<void> {
    this.busy = true;
    this.index = index;
    const scene = this.scenes[index];
    this.host.stopMotion();
    try {
      await this.host.showHighlights(scene.highlights);
      if (!this.active) return;
      this.host.frame(scene.camera ?? {});
      const last = index === this.scenes.length - 1;
      this.caption.setFooter(`${index + 1} / ${this.scenes.length}  ${last ? 'クリックで最初に戻る' : 'クリックで次へ'}  ·  Esc で終わる`);
      this.caption.show(scene.caption ?? '');
    } finally {
      this.busy = false;
    }
  }
}
