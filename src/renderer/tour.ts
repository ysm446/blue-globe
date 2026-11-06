// ツアーの再生。場面の並び (ハイライト、字幕、カメラ) を受け取り、字幕をクリックするたびに次の場面へ進む。
// 最後の場面でクリックすると最初に戻り、何度でも繰り返せる。Esc で終える
import type { HighlightSpec } from './highlights';
import type { TourCaption } from './tour-caption';
import { localHourToDate } from './tour-time';

export interface TourCamera {
  heading?: number; // 方角 (省くと今のまま)
  tilt?: number; // 傾き (省くと今のまま)
  orbit?: number; // 着いてから中心のまわりを回る速さ。旋回の段 (-5〜5。正が右回り)。省くと回らない
}

// 見せる時刻。hour はその場所の地方時 (経度から求めた平均太陽時。0〜24)、iso は日時そのもの。省くと前の場面のまま
export interface TourTime {
  hour?: number;
  iso?: string;
}

export interface TourScene {
  highlights: HighlightSpec[];
  caption?: string;
  camera?: TourCamera;
  time?: TourTime;
}

export interface TourHost {
  showHighlights(specs: HighlightSpec[]): Promise<void>;
  clearHighlights(): void;
  frame(camera: TourCamera): { lon: number } | null; // 映す場所の中心の経度を返す
  stopMotion(): void; // 旋回を止める
  setTime(at: Date | null): void; // null で元の時刻 (今、またはスライダーの時刻) に戻す
}

const ADVANCE_INTERVAL_MS = 600;

export class TourPlayer {
  private scenes: TourScene[] = [];
  private index = -1;
  private busy = false;
  private lastAdvance = 0; // 続けて届いたクリック (ダブルクリックなど) で場面を飛ばさないよう、間を空ける

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
    this.host.setTime(null);
    this.caption.setFooter(null);
    this.caption.clear();
  }

  // 文字を出している途中なら残りを出し切り、出し終えていれば次の場面へ (最後なら最初へ) 進む
  private advance(): void {
    if (!this.active || this.busy) return;
    const now = performance.now();
    if (now - this.lastAdvance < ADVANCE_INTERVAL_MS) return;
    this.lastAdvance = now;
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
      const view = this.host.frame(scene.camera ?? {});
      if (scene.time?.iso) this.host.setTime(new Date(scene.time.iso));
      else if (scene.time?.hour !== undefined && view) this.host.setTime(localHourToDate(scene.time.hour, view.lon));
      const last = index === this.scenes.length - 1;
      this.caption.setFooter(`${index + 1} / ${this.scenes.length}  ${last ? 'クリックで最初に戻る' : 'クリックで次へ'}  ·  Esc で終わる`);
      this.caption.show(scene.caption ?? '');
    } finally {
      this.busy = false;
    }
  }
}
