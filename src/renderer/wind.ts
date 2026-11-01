// 風場データ: cambecc/earth 互換の GFS JSON 形式を扱う。
// 等間隔緯度経度格子(北端から南へ、西端から東へ走査)を前提とする。

export interface WindSample {
  u: number;
  v: number;
  speed: number;
}

interface GfsHeader {
  parameterCategory: number;
  parameterNumber: number;
  nx: number;
  ny: number;
  lo1: number;
  la1: number;
  dx: number;
  dy: number;
  refTime?: string;
  forecastTime?: number;
}

interface GfsRecord {
  header: GfsHeader;
  data: number[];
}

export class WindField {
  readonly nx: number;
  readonly ny: number;
  readonly lo1: number;
  readonly la1: number;
  readonly dx: number;
  readonly dy: number;
  readonly refTime: string | null;
  readonly forecastTime: number | null; // 基準時刻からの予報時間 (hour)
  private readonly uData: Float32Array;
  private readonly vData: Float32Array;

  constructor(
    header: Pick<GfsHeader, 'nx' | 'ny' | 'lo1' | 'la1' | 'dx' | 'dy'>,
    uData: Float32Array,
    vData: Float32Array,
    refTime: string | null = null,
    forecastTime: number | null = null,
  ) {
    this.nx = header.nx;
    this.ny = header.ny;
    this.lo1 = header.lo1;
    this.la1 = header.la1;
    this.dx = header.dx;
    this.dy = header.dy;
    this.refTime = refTime;
    this.forecastTime = forecastTime;
    this.uData = uData;
    this.vData = vData;
  }

  static fromGfsJson(records: unknown): WindField | null {
    if (!Array.isArray(records)) return null;
    const recs = records as GfsRecord[];
    const uRec = recs.find(
      (r) => r.header?.parameterCategory === 2 && r.header?.parameterNumber === 2,
    );
    const vRec = recs.find(
      (r) => r.header?.parameterCategory === 2 && r.header?.parameterNumber === 3,
    );
    if (!uRec || !vRec) return null;
    const h = uRec.header;
    if (uRec.data.length !== h.nx * h.ny || vRec.data.length !== h.nx * h.ny) return null;
    return new WindField(
      h,
      Float32Array.from(uRec.data),
      Float32Array.from(vRec.data),
      h.refTime ?? null,
      h.forecastTime ?? null,
    );
  }

  // DB から読み出したフレーム (格子情報 + u/v 配列) から構築する
  static fromArrays(
    grid: Pick<GfsHeader, 'nx' | 'ny' | 'lo1' | 'la1' | 'dx' | 'dy'>,
    u: Float32Array,
    v: Float32Array,
    refTime: string | null = null,
    forecastTime: number | null = null,
  ): WindField | null {
    if (u.length !== grid.nx * grid.ny || v.length !== grid.nx * grid.ny) return null;
    return new WindField(grid, u, v, refTime, forecastTime);
  }

  // GPU テクスチャ生成用に格子データへの読み取りアクセスを提供する
  get uValues(): Float32Array {
    return this.uData;
  }

  get vValues(): Float32Array {
    return this.vData;
  }

  // lon: -180..180 または 0..360、lat: -90..90。格子外(極の外側)は null。
  sample(lon: number, lat: number): WindSample | null {
    const x = ((((lon - this.lo1) % 360) + 360) % 360) / this.dx;
    const y = (this.la1 - lat) / this.dy;
    if (y < 0 || y > this.ny - 1) return null;

    const x0 = Math.floor(x) % this.nx;
    const x1 = (x0 + 1) % this.nx;
    const y0 = Math.min(Math.floor(y), this.ny - 1);
    const y1 = Math.min(y0 + 1, this.ny - 1);
    const fx = x - Math.floor(x);
    const fy = y - y0;

    const i00 = y0 * this.nx + x0;
    const i10 = y0 * this.nx + x1;
    const i01 = y1 * this.nx + x0;
    const i11 = y1 * this.nx + x1;

    const u =
      (this.uData[i00] * (1 - fx) + this.uData[i10] * fx) * (1 - fy) +
      (this.uData[i01] * (1 - fx) + this.uData[i11] * fx) * fy;
    const v =
      (this.vData[i00] * (1 - fx) + this.vData[i10] * fx) * (1 - fy) +
      (this.vData[i01] * (1 - fx) + this.vData[i11] * fx) * fy;

    return { u, v, speed: Math.hypot(u, v) };
  }
}

// データが取得できないときのフォールバック: 偏西風・貿易風を模した合成風場。
export function makeSyntheticWind(): WindField {
  const nx = 360;
  const ny = 181;
  const u = new Float32Array(nx * ny);
  const v = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const lat = 90 - j;
    const latRad = (lat * Math.PI) / 180;
    for (let i = 0; i < nx; i++) {
      const lonRad = (i * Math.PI) / 180;
      const idx = j * nx + i;
      // 緯度帯ごとの東西流(ジェット気流風) + 経度方向の揺らぎ
      u[idx] =
        -20 * Math.cos(3 * latRad) * Math.cos(latRad) +
        5 * Math.sin(2 * lonRad + latRad * 4);
      v[idx] =
        6 * Math.sin(3 * lonRad) * Math.cos(2 * latRad) +
        3 * Math.cos(lonRad * 4 - latRad * 3);
    }
  }
  return new WindField({ nx, ny, lo1: 0, la1: 90, dx: 1, dy: 1 }, u, v, null);
}
