// デモの場面の順番と行き先。画面の計算から切り離して検証できるよう、DOM に依存しない
export interface DemoPlace {
  name: string;
  lat: number;
  lon: number;
}

export interface DemoScene {
  mode: 'normal' | 'weather' | 'wind';
  view: 'globe' | 'region';
  place?: 'home' | 'day' | 'night';
  dayside?: boolean; // 雲や海の反射が見えるよう、地域ビューから昼側へ移って回る
  seconds: number;
}

export const DEMO_SCENES: DemoScene[] = [
  { mode: 'normal', view: 'globe', seconds: 40 },
  { mode: 'normal', view: 'region', place: 'home', seconds: 40 },
  { mode: 'weather', view: 'globe', dayside: true, seconds: 30 },
  { mode: 'normal', view: 'region', place: 'day', seconds: 40 },
  { mode: 'normal', view: 'globe', dayside: true, seconds: 25 },
  { mode: 'normal', view: 'region', place: 'night', seconds: 40 },
  { mode: 'wind', view: 'globe', seconds: 40 },
];

// 昼に見て面白い地形
export const DAY_PLACES: DemoPlace[] = [
  { name: 'ヒマラヤ山脈', lat: 28, lon: 86 },
  { name: 'サハラ砂漠', lat: 24, lon: 12 },
  { name: 'アルプス山脈', lat: 46, lon: 10 },
  { name: 'アマゾン川の河口', lat: -1, lon: -50 },
  { name: 'バハマの浅瀬', lat: 24, lon: -77 },
  { name: 'グランドキャニオン', lat: 36, lon: -112 },
  { name: 'グレートバリアリーフ', lat: -18, lon: 148 },
  { name: 'ナイル川', lat: 27, lon: 32 },
];

// 夜に街明かりが広がる場所
export const NIGHT_PLACES: DemoPlace[] = [
  { name: '東京', lat: 35.7, lon: 139.7 },
  { name: 'ニューヨーク', lat: 40.7, lon: -74 },
  { name: 'パリ', lat: 48.9, lon: 2.4 },
  { name: 'カイロ', lat: 30, lon: 31.2 },
  { name: 'デリー', lat: 28.6, lon: 77.2 },
  { name: 'サンパウロ', lat: -23.5, lon: -46.6 },
  { name: 'ソウル', lat: 37.6, lon: 127 },
  { name: 'ロサンゼルス', lat: 34, lon: -118.2 },
];

const DAY_MIN_ELEVATION = 15; // 太陽がこれより高ければ、地形がよく見える
const NIGHT_MAX_ELEVATION = -6; // 太陽がこれより低ければ、街明かりがはっきり見える
const DEG = Math.PI / 180;

export function sunElevation(place: { lat: number; lon: number }, sun: { lat: number; lon: number }): number {
  const cosine =
    Math.sin(place.lat * DEG) * Math.sin(sun.lat * DEG) +
    Math.cos(place.lat * DEG) * Math.cos(sun.lat * DEG) * Math.cos((place.lon - sun.lon) * DEG);
  return Math.asin(Math.max(-1, Math.min(1, cosine))) / DEG;
}

// start の次から順に、今の太陽で見頃の場所を探す。なければ順番どおりの場所にする
export function pickDemoPlace(
  kind: 'day' | 'night',
  sun: { lat: number; lon: number },
  start: number,
): { place: DemoPlace; next: number } {
  const places = kind === 'day' ? DAY_PLACES : NIGHT_PLACES;
  for (let offset = 0; offset < places.length; offset++) {
    const index = (start + offset) % places.length;
    const elevation = sunElevation(places[index], sun);
    if (kind === 'day' ? elevation >= DAY_MIN_ELEVATION : elevation <= NIGHT_MAX_ELEVATION) {
      return { place: places[index], next: index + 1 };
    }
  }
  return { place: places[start % places.length], next: start + 1 };
}
