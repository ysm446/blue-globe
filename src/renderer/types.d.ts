interface WindResult {
  source: 'cache' | 'nomads' | 'stale' | 'sample';
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

type GlobeView = 'globe' | 'region';

type EarthTileLayer = 'day' | 'night' | 'water';

interface WeatherLocation {
  name: string;
  admin1: string | null;
  country: string | null;
  country_code: string | null;
  latitude: number;
  longitude: number;
}

interface GraphicsSettings {
  fps_limit: number; // 0 はモニターのリフレッシュレートに合わせる
  render_scale: number; // 描画解像度 (%)
  bloom: boolean;
  auto_exposure: boolean;
  show_fps: boolean;
  show_map_lines: boolean; // 海岸線と国境線 (通常・天気モード。風速モードでは常に描く)
  star_brightness: number; // 星全体の明るさの倍率
  cloud_shadow: number; // 雲の影の濃さ (0〜1)
  glint_strength: number; // 海の太陽の反射の強さ。1 が地球の写真に合わせた強さ (0〜3)
  region_bloom: number; // 地域ビューの光のにじみの強さ。地球ビューを 1 とした倍率 (0〜1)
  region_detail: boolean; // 地域ビューで高解像度の画像を取得して使う
}

interface PanelSettings {
  news: boolean; // true で開いている
  hourly: boolean;
  weekly: boolean;
}

interface AppSettings {
  location: WeatherLocation | null;
  models_dir: string;
  model: string | null;
  mode?: MapMode;
  graphics?: GraphicsSettings;
  panels?: PanelSettings;
}

interface ModelEntry {
  path: string;
  name: string;
  size_gb: number;
}

interface ModelList {
  models: ModelEntry[];
  error: string | null;
}

interface NewsOutlook {
  text: string;
  method: 'rule' | 'llm' | 'verbatim';
  original: string | null;
  model: string | null;
  reported_at: string | null;
}

interface NewsReport {
  location: WeatherLocation;
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
  weatherApi: {
    getWind(): Promise<WindResult>;
    getClouds(): Promise<CloudResult | null>;
    setMode(mode: MapMode): Promise<unknown>;
    setGraphics(graphics: GraphicsSettings): Promise<AppSettings>;
    setPanels(panels: PanelSettings): Promise<AppSettings>;
    getGraphicsDefaults(): Promise<GraphicsSettings>;
    getTexture(name: 'earth-day' | 'earth-night' | 'earth-water'): Promise<Uint8Array>;
    getEarthTile(layer: EarthTileLayer, col: number, row: number): Promise<Uint8Array | null>; // 取得できないときは null
    getNews(): Promise<NewsReport>;
    getSettings(): Promise<AppSettings>;
    saveSettings(settings: AppSettings): Promise<AppSettings>;
    searchLocations(query: string): Promise<WeatherLocation[]>;
    listModels(modelsDir: string): Promise<ModelList>;
    pickFolder(defaultPath: string): Promise<string | null>;
    revealScreenshot(filePath: string): Promise<void>;
    onScreenshot(callback: (filePath: string | null) => void): void; // 保存に失敗したときは null
  };
}
