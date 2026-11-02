// デモの場面の順番と行き先。画面の計算から切り離して検証できるよう、DOM に依存しない
export interface DemoPlace {
  name: string;
  lat: number;
  lon: number;
}

export interface DemoScene {
  mode: 'normal' | 'weather' | 'wind';
  view: 'globe' | 'region';
  place?: 'home' | DemoPlaceKind;
  dayside?: boolean; // 雲や海の反射が見えるよう、地域ビューから昼側へ移って回る
  seconds: number;
}

export type DemoPlaceKind = 'day' | 'night' | 'city';

// 今の様子を見せたいので、風の場面のほかは雲を出す
export const DEMO_SCENES: DemoScene[] = [
  { mode: 'weather', view: 'globe', seconds: 40 },
  { mode: 'weather', view: 'region', place: 'home', seconds: 40 },
  { mode: 'weather', view: 'globe', dayside: true, seconds: 30 },
  { mode: 'weather', view: 'region', place: 'day', seconds: 40 },
  { mode: 'weather', view: 'globe', dayside: true, seconds: 25 },
  { mode: 'weather', view: 'region', place: 'night', seconds: 40 },
  { mode: 'wind', view: 'globe', seconds: 40 },
  { mode: 'weather', view: 'region', place: 'city', seconds: 40 },
];

// 世界の都市。選ばれると、その都市の天気をパネルに出す
export const CITIES: DemoPlace[] = [
  { name: '東京', lat: 35.7, lon: 139.7 },
  { name: 'ソウル', lat: 37.6, lon: 127 },
  { name: '上海', lat: 31.2, lon: 121.5 },
  { name: '香港', lat: 22.3, lon: 114.2 },
  { name: 'シンガポール', lat: 1.4, lon: 103.8 },
  { name: 'バンコク', lat: 13.8, lon: 100.5 },
  { name: 'デリー', lat: 28.6, lon: 77.2 },
  { name: 'ムンバイ', lat: 19.1, lon: 72.9 },
  { name: 'ドバイ', lat: 25.2, lon: 55.3 },
  { name: 'イスタンブール', lat: 41, lon: 29 },
  { name: 'カイロ', lat: 30, lon: 31.2 },
  { name: 'モスクワ', lat: 55.8, lon: 37.6 },
  { name: 'パリ', lat: 48.9, lon: 2.4 },
  { name: 'ロンドン', lat: 51.5, lon: -0.1 },
  { name: 'ローマ', lat: 41.9, lon: 12.5 },
  { name: 'ベルリン', lat: 52.5, lon: 13.4 },
  { name: 'ラゴス', lat: 6.5, lon: 3.4 },
  { name: 'ナイロビ', lat: -1.3, lon: 36.8 },
  { name: 'ケープタウン', lat: -33.9, lon: 18.4 },
  { name: 'ニューヨーク', lat: 40.7, lon: -74 },
  { name: 'シカゴ', lat: 41.9, lon: -87.6 },
  { name: 'ロサンゼルス', lat: 34, lon: -118.2 },
  { name: 'バンクーバー', lat: 49.3, lon: -123.1 },
  { name: 'メキシコシティ', lat: 19.4, lon: -99.1 },
  { name: 'ハバナ', lat: 23.1, lon: -82.4 },
  { name: 'リマ', lat: -12, lon: -77 },
  { name: 'サンパウロ', lat: -23.5, lon: -46.6 },
  { name: 'ブエノスアイレス', lat: -34.6, lon: -58.4 },
  { name: 'シドニー', lat: -33.9, lon: 151.2 },
  { name: 'オークランド', lat: -36.9, lon: 174.8 },
  { name: 'ホノルル', lat: 21.3, lon: -157.9 },
];

const DAY_MIN_ELEVATION = 15; // 太陽がこれより高ければ、地表がよく見える
const NIGHT_MAX_ELEVATION = -6; // 太陽がこれより低ければ、街明かりがはっきり見える
const RECENT_LIMIT = 5; // 同じ場所が続かないよう、最近行った場所を避ける
const DEG = Math.PI / 180;

export function sunElevation(place: { lat: number; lon: number }, sun: { lat: number; lon: number }): number {
  const cosine =
    Math.sin(place.lat * DEG) * Math.sin(sun.lat * DEG) +
    Math.cos(place.lat * DEG) * Math.cos(sun.lat * DEG) * Math.cos((place.lon - sun.lon) * DEG);
  return Math.asin(Math.max(-1, Math.min(1, cosine))) / DEG;
}

// 昼や夜の都市は、今の太陽で見頃の都市からランダムに選ぶ。recent は新しい順で、選んだ場所を先頭に足す
export function pickDemoPlace(
  kind: DemoPlaceKind,
  sun: { lat: number; lon: number },
  recent: string[],
  random: () => number = Math.random,
): DemoPlace {
  const suitable = CITIES.filter((place) => {
    if (kind === 'day') return sunElevation(place, sun) >= DAY_MIN_ELEVATION;
    return kind === 'city' || sunElevation(place, sun) <= NIGHT_MAX_ELEVATION;
  });
  const candidates = suitable.length > 0 ? suitable : CITIES;
  const fresh = candidates.filter((place) => !recent.includes(place.name));
  const pool = fresh.length > 0 ? fresh : candidates;
  const place = pool[Math.floor(random() * pool.length)];
  recent.unshift(place.name);
  recent.length = Math.min(recent.length, RECENT_LIMIT);
  return place;
}
