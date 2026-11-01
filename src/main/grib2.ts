// 最小限の GRIB2 デコーダ。
// GFS pgrb2 ファイルで使われる範囲のみ対応する:
//   - 格子: テンプレート 3.0 (等間隔緯度経度格子)
//   - 圧縮: テンプレート 5.0 (単純) / 5.2 (複合) / 5.3 (複合 + 空間差分)
//   - ビットマップなし、欠損値管理なし
// 仕様: WMO FM 92 GRIB Edition 2

export interface Grib2Message {
  discipline: number;
  refTime: string; // ISO 8601
  forecastTime: number; // 時間 (hour) に正規化
  parameterCategory: number;
  parameterNumber: number;
  levelType: number;
  levelValue: number;
  nx: number;
  ny: number;
  la1: number; // 度
  lo1: number;
  dx: number;
  dy: number;
  scanMode: number;
  data: Float32Array;
}

class BitReader {
  private bitPos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(bits: number): number {
    let result = 0;
    let remaining = bits;
    while (remaining > 0) {
      const byte = this.bytes[this.bitPos >> 3];
      const bitOffset = this.bitPos & 7;
      const take = Math.min(8 - bitOffset, remaining);
      const chunk = (byte >> (8 - bitOffset - take)) & ((1 << take) - 1);
      result = result * (1 << take) + chunk; // 32bit 超でも精度が落ちないよう乗算で結合
      this.bitPos += take;
      remaining -= take;
    }
    return result;
  }

  alignToByte(): void {
    this.bitPos = (this.bitPos + 7) & ~7;
  }
}

// GRIB2 の符号付き整数は符号-絶対値表現(先頭ビットが符号)
function readSignMagnitude(bytes: Uint8Array, offset: number, length: number): number {
  const negative = (bytes[offset] & 0x80) !== 0;
  let value = bytes[offset] & 0x7f;
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i];
  return negative ? -value : value;
}

function readUint(bytes: Uint8Array, offset: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[offset + i];
  return value;
}

function readFloat32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0);
}

// 予報時間を hour に正規化する(GRIB2 Code Table 4.4)
function forecastTimeToHours(unit: number, value: number): number {
  switch (unit) {
    case 0: return value / 60; // minute
    case 1: return value; // hour
    case 2: return value * 24; // day
    case 10: return value * 3;
    case 11: return value * 6;
    case 12: return value * 12;
    case 13: return value / 3600; // second
    default: throw new Error(`unsupported time unit: ${unit}`);
  }
}

interface Drs {
  template: number;
  reference: number; // R
  binaryScale: number; // E
  decimalScale: number; // D
  nbits: number;
  // 複合パッキング (5.2/5.3) 用
  numGroups: number;
  refGroupWidth: number;
  bitsGroupWidth: number;
  refGroupLength: number;
  lengthIncrement: number;
  lastGroupLength: number;
  bitsGroupLength: number;
  spatialOrder: number; // 5.3 のみ (1 or 2)
  spatialOctets: number; // 5.3 のみ
}

function parseDrs(sec: Uint8Array): Drs {
  const template = readUint(sec, 9, 2);
  const drs: Drs = {
    template,
    reference: readFloat32(sec, 11),
    binaryScale: readSignMagnitude(sec, 15, 2),
    decimalScale: readSignMagnitude(sec, 17, 2),
    nbits: sec[19],
    numGroups: 0,
    refGroupWidth: 0,
    bitsGroupWidth: 0,
    refGroupLength: 0,
    lengthIncrement: 0,
    lastGroupLength: 0,
    bitsGroupLength: 0,
    spatialOrder: 0,
    spatialOctets: 0,
  };
  if (template === 0) return drs;
  if (template !== 2 && template !== 3) {
    throw new Error(`unsupported DRS template: 5.${template}`);
  }
  const missingMgmt = sec[22];
  if (missingMgmt !== 0) {
    throw new Error(`missing value management not supported: ${missingMgmt}`);
  }
  drs.numGroups = readUint(sec, 31, 4);
  drs.refGroupWidth = sec[35];
  drs.bitsGroupWidth = sec[36];
  drs.refGroupLength = readUint(sec, 37, 4);
  drs.lengthIncrement = sec[41];
  drs.lastGroupLength = readUint(sec, 42, 4);
  drs.bitsGroupLength = sec[46];
  if (template === 3) {
    drs.spatialOrder = sec[47];
    drs.spatialOctets = sec[48];
  }
  return drs;
}

// テンプレート 7.0: 単純パッキング
function unpackSimple(data: Uint8Array, drs: Drs, npoints: number): Float32Array {
  const out = new Float32Array(npoints);
  const scale = Math.pow(2, drs.binaryScale) / Math.pow(10, drs.decimalScale);
  const base = drs.reference / Math.pow(10, drs.decimalScale);
  if (drs.nbits === 0) {
    out.fill(base);
    return out;
  }
  const reader = new BitReader(data);
  for (let i = 0; i < npoints; i++) {
    out[i] = base + reader.read(drs.nbits) * scale;
  }
  return out;
}

// テンプレート 7.2 / 7.3: 複合パッキング(+ 空間差分)
function unpackComplex(data: Uint8Array, drs: Drs, npoints: number): Float32Array {
  let offset = 0;
  let ival1 = 0;
  let ival2 = 0;
  let gmin = 0;
  if (drs.template === 3) {
    const ds = drs.spatialOctets;
    ival1 = readSignMagnitude(data, offset, ds);
    offset += ds;
    if (drs.spatialOrder === 2) {
      ival2 = readSignMagnitude(data, offset, ds);
      offset += ds;
    }
    gmin = readSignMagnitude(data, offset, ds);
    offset += ds;
  }

  const reader = new BitReader(data.subarray(offset));
  const ng = drs.numGroups;

  // グループ参照値 → グループ幅 → グループ長。各配列はオクテット境界まで詰められている
  const refs = new Int32Array(ng);
  for (let g = 0; g < ng; g++) refs[g] = drs.nbits > 0 ? reader.read(drs.nbits) : 0;
  reader.alignToByte();

  const widths = new Int32Array(ng);
  for (let g = 0; g < ng; g++) {
    widths[g] = drs.refGroupWidth + (drs.bitsGroupWidth > 0 ? reader.read(drs.bitsGroupWidth) : 0);
  }
  reader.alignToByte();

  const lengths = new Int32Array(ng);
  for (let g = 0; g < ng; g++) {
    lengths[g] =
      drs.refGroupLength +
      drs.lengthIncrement * (drs.bitsGroupLength > 0 ? reader.read(drs.bitsGroupLength) : 0);
  }
  if (ng > 0) lengths[ng - 1] = drs.lastGroupLength;
  reader.alignToByte();

  const x = new Int32Array(npoints);
  let n = 0;
  for (let g = 0; g < ng; g++) {
    const width = widths[g];
    const ref = refs[g];
    for (let k = 0; k < lengths[g]; k++) {
      if (n >= npoints) throw new Error('complex packing: too many points');
      x[n++] = ref + (width > 0 ? reader.read(width) : 0);
    }
  }
  if (n !== npoints) throw new Error(`complex packing: point count mismatch (${n}/${npoints})`);

  // 空間差分の復元
  if (drs.template === 3) {
    if (drs.spatialOrder === 1) {
      x[0] = ival1;
      for (let i = 1; i < npoints; i++) x[i] = x[i] + gmin + x[i - 1];
    } else if (drs.spatialOrder === 2) {
      x[0] = ival1;
      x[1] = ival2;
      for (let i = 2; i < npoints; i++) x[i] = x[i] + gmin + 2 * x[i - 1] - x[i - 2];
    } else {
      throw new Error(`unsupported spatial differencing order: ${drs.spatialOrder}`);
    }
  }

  const out = new Float32Array(npoints);
  const scale = Math.pow(2, drs.binaryScale) / Math.pow(10, drs.decimalScale);
  const base = drs.reference / Math.pow(10, drs.decimalScale);
  for (let i = 0; i < npoints; i++) out[i] = base + x[i] * scale;
  return out;
}

export function decodeGrib2(buffer: Uint8Array): Grib2Message[] {
  const messages: Grib2Message[] = [];
  let offset = 0;

  while (offset + 16 <= buffer.length) {
    if (
      buffer[offset] !== 0x47 || // G
      buffer[offset + 1] !== 0x52 || // R
      buffer[offset + 2] !== 0x49 || // I
      buffer[offset + 3] !== 0x42 // B
    ) {
      break;
    }
    if (buffer[offset + 7] !== 2) throw new Error(`unsupported GRIB edition: ${buffer[offset + 7]}`);
    const totalLength = readUint(buffer, offset + 8, 8);
    const discipline = buffer[offset + 6];

    let refTime = '';
    let forecastTime = 0;
    let parameterCategory = -1;
    let parameterNumber = -1;
    let levelType = -1;
    let levelValue = 0;
    let nx = 0;
    let ny = 0;
    let la1 = 0;
    let lo1 = 0;
    let dx = 0;
    let dy = 0;
    let scanMode = 0;
    let npoints = 0;
    let drs: Drs | null = null;
    let bitmapIndicator = 255;

    let p = offset + 16;
    while (p < offset + totalLength - 4) {
      const secLength = readUint(buffer, p, 4);
      const secNumber = buffer[p + 4];
      const sec = buffer.subarray(p, p + secLength);

      if (secNumber === 1) {
        const year = readUint(sec, 12, 2);
        const pad = (v: number) => String(v).padStart(2, '0');
        refTime = `${year}-${pad(sec[14])}-${pad(sec[15])}T${pad(sec[16])}:${pad(sec[17])}:${pad(sec[18])}Z`;
      } else if (secNumber === 3) {
        const gridTemplate = readUint(sec, 12, 2);
        if (gridTemplate !== 0) throw new Error(`unsupported grid template: 3.${gridTemplate}`);
        nx = readUint(sec, 30, 4);
        ny = readUint(sec, 34, 4);
        la1 = readSignMagnitude(sec, 46, 4) / 1e6;
        lo1 = readSignMagnitude(sec, 50, 4) / 1e6;
        dx = readUint(sec, 63, 4) / 1e6;
        dy = readUint(sec, 67, 4) / 1e6;
        scanMode = sec[71];
      } else if (secNumber === 4) {
        parameterCategory = sec[9];
        parameterNumber = sec[10];
        forecastTime = forecastTimeToHours(sec[17], readUint(sec, 18, 4));
        levelType = sec[22];
        const levelScale = sec[23];
        levelValue = readUint(sec, 24, 4) / Math.pow(10, levelScale === 255 ? 0 : levelScale);
      } else if (secNumber === 5) {
        npoints = readUint(sec, 5, 4);
        drs = parseDrs(sec);
      } else if (secNumber === 6) {
        bitmapIndicator = sec[5];
        if (bitmapIndicator !== 255) {
          throw new Error(`bitmap not supported (indicator: ${bitmapIndicator})`);
        }
      } else if (secNumber === 7) {
        if (!drs) throw new Error('section 7 before section 5');
        const dataBytes = sec.subarray(5);
        const data =
          drs.template === 0
            ? unpackSimple(dataBytes, drs, npoints)
            : unpackComplex(dataBytes, drs, npoints);
        messages.push({
          discipline,
          refTime,
          forecastTime,
          parameterCategory,
          parameterNumber,
          levelType,
          levelValue,
          nx,
          ny,
          la1,
          lo1,
          dx,
          dy,
          scanMode,
          data,
        });
      }

      p += secLength;
    }

    offset += totalLength;
  }

  return messages;
}
