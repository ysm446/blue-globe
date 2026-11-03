interface WindResult {
  source: 'cache' | 'nomads' | 'stale' | 'sample' | 'unavailable'; // unavailable は過去の風を取得できなかったとき
  records: unknown;
}

interface CloudResult {
  source: 'satellite' | 'gfs';
  nx: number;
  ny: number;
  validTime: string;
  stale: boolean; // 取得に失敗して前回の衛星データを使っている
  data: Uint8Array; // 1 行目が北端、左端が経度 -180 度
}

type MapMode = 'normal' | 'weather' | 'wind';

type GlobeView = 'solar' | 'globe' | 'region';

type EarthTileLayer = 'day' | 'night' | 'water';

type EarthTextureName = 'earth-day' | 'earth-night' | 'earth-water';

interface WeatherLocation {
  name: string;
  admin1: string | null;
  country: string | null;
  country_code: string | null;
  latitude: number;
  longitude: number;
}

type UiFont = 'noto-sans-jp' | 'yu-gothic-ui' | 'meiryo-ui' | 'biz-udp-gothic' | 'yu-mincho';
type CruiseMode = 'analog' | 'stepped'; // analog は押している間に速さが変わり、stepped は 1 回押すごとに 1 段変わる

interface GraphicsSettings {
  fps_limit: number; // 0 はモニターのリフレッシュレートに合わせる
  render_scale: number; // 描画解像度 (%)
  bloom: boolean;
  auto_exposure: boolean;
  exposure_compensation: number; // 露出補正 (EV。-2〜2)
  focal_length: number; // カメラの焦点距離。フルサイズ換算 (mm。14〜70。0.1 刻み)
  depth_of_field: boolean; // 被写界深度 (通常・天気モード)
  f_number: number; // レンズの F 値 (1.4〜22。1/3 段の値)。被写界深度のぼけの強さに効く
  globe_size: number; // 被写界深度で地球を見立てる地球儀の直径 (m。0.3〜32)
  show_fps: boolean;
  show_map_lines: boolean; // 海岸線と国境線 (通常・天気モード。風速モードでは常に描く)
  show_city_labels: boolean; // 地球儀の上の都市のラベル
  show_planet_labels: boolean; // 惑星の点の横の名前
  show_constellations: boolean; // 星座の線
  star_brightness: number; // 星全体の明るさの倍率
  space_tint: number; // 背景の宇宙の青み。0 で真っ黒、1 が従来の濃さ (0〜1)
  cloud_shadow: number; // 雲の影の濃さ (0〜1)
  glint_strength: number; // 海の太陽の反射の強さ。1 が地球の写真に合わせた強さ (0〜3)
  region_bloom: number; // 地域ビューの光のにじみの強さ。地球ビューを 1 とした倍率 (0〜1)
  city_glow: number; // 街明かりのまわりの淡い光 (暈) の強さ。1 が既定 (0〜2)
  moonlight: boolean; // 夜側の雲と地表を、月の位置と満ち欠けに合わせて照らす
  region_detail: boolean; // 地域ビューで高解像度の画像を取得して使う
  volume_clouds: boolean; // 近づいたときに雲を立体で描く
  cloud_resolution: number; // 立体の雲を描く解像度 (画面に対する %。50, 75, 100)
  cloud_edge_detail: number; // 立体の雲の縁の細かさ (0〜1)
  cloud_edge_sharpness: number; // 立体の雲の縁の鋭さ (0〜1)
  cloud_puffiness: number; // 立体の雲のかたまりの起伏。1 がもとの強さ (0〜2)
  cloud_height: number; // 立体の雲の層の厚さの倍率。1 で上端が約 16km (0.5〜3)
  ui_font: UiFont; // 画面の文字のフォント
  cruise_mode: CruiseMode; // 地域ビューの巡航の操作
  cruise_bank: boolean; // 巡航で A/D で曲がるときに、曲がる向きへ画面を傾ける
  lens_flare: boolean; // 太陽が見えるときの、レンズの光の筋と画面のかぶり
}

interface PanelSettings {
  news: boolean; // true で開いている
  hourly: boolean;
  weekly: boolean;
  details: boolean;
  camera: boolean; // 右上のカメラのパネル。開いている間だけ計算する
}

interface AppSettings {
  location: WeatherLocation | null;
  mode?: MapMode;
  graphics?: GraphicsSettings;
  panels?: PanelSettings;
  audio_file?: string | null; // 設定画面で選んだ音源のパス
  audio_volume?: number; // スライダーの位置 (0〜1)
}

interface NewsOutlook {
  text: string;
  method: 'rule' | 'verbatim';
  original: string | null;
  reported_at: string | null;
}

interface NewsReport {
  location: WeatherLocation;
  utc_offset_seconds: number;
  at: string | null; // 過去の時刻を見ているときの時刻
  headline: string;
  current_text: string;
  day_text: string;
  outlook: NewsOutlook | null;
  note: string | null;
  current: {
    weather: string;
    icon: string;
    is_day: boolean;
    temperature: number;
    apparent: number;
    humidity: number;
    wind_speed: number;
    wind_direction: string;
    gust: number;
    rain: number | null; // 今の時間帯の降水確率
    sunrise: string | null; // 地点の現地時刻の HH:MM。白夜や極夜では null
    sunset: string | null;
  };
  hourly: Array<{
    time: string;
    temperature: number;
    rain: number | null;
    weather: string;
    icon: string;
    is_day: boolean;
  }>;
  weekly: Array<{
    label: string;
    weather: string;
    icon: string;
    high: number;
    low: number;
    rain: number | null;
  }>;
}

interface Window {
  __weatherNewsDebug: { demoTimeScale: number; [key: string]: unknown }; // 動作検証用
  weatherApi: {
    getWind(at?: string): Promise<WindResult>;
    getClouds(at?: string): Promise<CloudResult | null>;
    setMode(mode: MapMode): Promise<unknown>;
    setGraphics(graphics: GraphicsSettings): Promise<AppSettings>;
    setPanels(panels: PanelSettings): Promise<AppSettings>;
    getGraphicsDefaults(): Promise<GraphicsSettings>;
    getTexture(name: EarthTextureName): Promise<Uint8Array>;
    getEarthTile(layer: EarthTileLayer, col: number, row: number): Promise<Uint8Array | null>; // 取得できないときは null
    getNews(at?: string): Promise<NewsReport>;
    getPlaceNews(name: string, latitude: number, longitude: number, at?: string): Promise<NewsReport>;
    getSettings(): Promise<AppSettings>;
    saveSettings(settings: AppSettings): Promise<AppSettings>;
    chooseAudioFile(): Promise<AppSettings | null>; // キャンセルしたときは null
    clearAudioFile(): Promise<AppSettings>;
    setAudioVolume(volume: number): Promise<AppSettings>;
    searchLocations(query: string): Promise<WeatherLocation[]>;
    revealScreenshot(filePath: string): Promise<void>;
    onScreenshot(callback: (filePath: string | null) => void): void; // 保存に失敗したときは null
  };
}
