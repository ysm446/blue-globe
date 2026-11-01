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
}

interface AppSettings {
  location: WeatherLocation | null;
  models_dir: string;
  model: string | null;
  mode?: MapMode;
  graphics?: GraphicsSettings;
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
    getTexture(name: 'earth-day' | 'earth-night'): Promise<Uint8Array>;
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
