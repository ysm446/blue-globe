// 保存したツアーの名前と id。パネル (tour-panel.ts) から使う。DOM を使わない計算だけを置く
import type { TourScene } from './tour';

export const TOUR_TITLE_MAX = 80; // server/api.py の SavedTour と合わせる
const CAPTION_TITLE_MAX = 30; // 字幕から名前を作るときの長さ

// 名前がないツアーの既定の名前。最初の場面の字幕の最初の文、なければ日時
export function defaultTourTitle(title: string | null, scenes: TourScene[], now = new Date()): string {
  const given = title?.trim();
  if (given) return given.slice(0, TOUR_TITLE_MAX);
  const caption = scenes.find((scene) => scene.caption?.trim())?.caption?.trim() ?? '';
  const sentence = caption.split(/[。.!?！？\n]/)[0].trim();
  if (sentence) return sentence.length > CAPTION_TITLE_MAX ? `${sentence.slice(0, CAPTION_TITLE_MAX - 1)}…` : sentence;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `ツアー ${now.getMonth() + 1}/${now.getDate()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

// 保存の id。英数字とハイフンだけ (server/api.py の SavedTour の id の形)
export function newTourId(now = Date.now(), random = Math.random): string {
  return `tour-${now.toString(36)}-${Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')}`;
}
