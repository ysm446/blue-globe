// 惑星の方向と明るさを日時から求める。画面の計算から切り離して検証できるよう、DOM と Three.js に依存しない。
// 位置は JPL の近似軌道要素 (Standish、1800〜2050 年用の表)、明るさは天体暦の補遺 (1992) の式 (水星を除く)。
// 星のデータに合わせて J2000 の赤道座標で返し、光の届く時間は無視する。表示には十分な精度
import { DEG } from './math.ts';

const J2000_MS = Date.UTC(2000, 0, 1, 12);
const CENTURY_MS = 36525 * 86_400_000;
const OBLIQUITY = 23.43928 * DEG; // J2000 の黄道傾斜角

// 軌道長半径 (AU)、離心率、軌道傾斜角、平均黄経、近日点黄経、昇交点黄経 (度)。後半は 1 世紀あたりの変化
type Elements = readonly [number, number, number, number, number, number];

interface PlanetData {
  name: string;
  elements: Elements;
  rates: Elements;
  bv: number; // 色指数。星と同じ式で色にする
  magnitude: (phase: number) => number; // 太陽と地球から 1 AU のときの等級。phase は位相角 (度)
}

const EARTH = {
  elements: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0] as Elements,
  rates: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0] as Elements,
};

const SATURN_POLE: readonly [number, number, number] = (() => {
  // 環の面の北極 (J2000 の赤経 40.589°、赤緯 83.537°)
  const ra = 40.589 * DEG;
  const dec = 83.537 * DEG;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
})();

export const PLANETS: readonly PlanetData[] = [
  {
    name: '水星',
    elements: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    rates: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.1253408],
    bv: 0.93,
    // 細い三日月になる大きな位相角でも合うよう、Mallama と Hilton (2018) の式を使う
    magnitude: (i) =>
      -0.613 + 6.328e-2 * i - 1.6336e-3 * i ** 2 + 3.3644e-5 * i ** 3 - 3.4265e-7 * i ** 4 + 1.6893e-9 * i ** 5 - 3.0334e-12 * i ** 6,
  },
  {
    name: '金星',
    elements: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    rates: [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
    bv: 0.82,
    magnitude: (i) => -4.4 + 0.0009 * i + 0.000239 * i ** 2 - 0.00000065 * i ** 3,
  },
  {
    name: '火星',
    elements: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    rates: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
    bv: 1.36,
    magnitude: (i) => -1.52 + 0.016 * i,
  },
  {
    name: '木星',
    elements: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    rates: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
    bv: 0.83,
    magnitude: (i) => -9.4 + 0.005 * i,
  },
  {
    name: '土星',
    elements: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    rates: [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
    bv: 1.04,
    // 環の傾きの分は別に足す (planetSky)。太陽と地球から見た環の経度の差は、位相角で近似する
    magnitude: (i) => -8.88 + 0.044 * i,
  },
  {
    name: '天王星',
    elements: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
    rates: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
    bv: 0.56,
    magnitude: () => -7.19,
  },
  {
    name: '海王星',
    elements: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    rates: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
    bv: 0.41,
    magnitude: () => -6.87,
  },
];

type Vec = [number, number, number];

// 太陽を中心とした J2000 の赤道座標 (AU)
function heliocentric(elements: Elements, rates: Elements, t: number): Vec {
  const [a, e, inclination, meanLon, periLon, nodeLon] = elements.map((value, i) => value + rates[i] * t);
  const peri = (periLon - nodeLon) * DEG;
  const node = nodeLon * DEG;
  const inc = inclination * DEG;
  const anomaly = ((((meanLon - periLon) % 360) + 540) % 360 - 180) * DEG;
  // ケプラー方程式をニュートン法で解く
  let ecc = anomaly + e * Math.sin(anomaly);
  for (let i = 0; i < 8; i++) ecc -= (ecc - e * Math.sin(ecc) - anomaly) / (1 - e * Math.cos(ecc));
  const px = a * (Math.cos(ecc) - e);
  const py = a * Math.sqrt(1 - e * e) * Math.sin(ecc);
  const [cw, sw, cn, sn, ci, si] = [Math.cos(peri), Math.sin(peri), Math.cos(node), Math.sin(node), Math.cos(inc), Math.sin(inc)];
  const x = (cw * cn - sw * sn * ci) * px + (-sw * cn - cw * sn * ci) * py;
  const y = (cw * sn + sw * cn * ci) * px + (-sw * sn + cw * cn * ci) * py;
  const z = sw * si * px + cw * si * py;
  return [x, y * Math.cos(OBLIQUITY) - z * Math.sin(OBLIQUITY), y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY)];
}

export interface PlanetSky {
  name: string;
  ra: number; // 地球の中心から見た J2000 の赤経と赤緯 (度)
  dec: number;
  magnitude: number;
  bv: number;
}

export function planetSky(date: Date): PlanetSky[] {
  const t = (date.getTime() - J2000_MS) / CENTURY_MS;
  const earth = heliocentric(EARTH.elements, EARTH.rates, t);
  const sunDistance = Math.hypot(...earth);
  return PLANETS.map((planet) => {
    const helio = heliocentric(planet.elements, planet.rates, t);
    const geo: Vec = [helio[0] - earth[0], helio[1] - earth[1], helio[2] - earth[2]];
    const r = Math.hypot(...helio);
    const delta = Math.hypot(...geo);
    const phase = Math.acos(Math.min(1, Math.max(-1, (r * r + delta * delta - sunDistance * sunDistance) / (2 * r * delta)))) / DEG;
    let magnitude = planet.magnitude(phase) + 5 * Math.log10(r * delta);
    if (planet.name === '土星') {
      // 環が開いているほど明るい。B は土星から見た地球の、環の面からの角度
      const sinB = Math.abs(-(geo[0] * SATURN_POLE[0] + geo[1] * SATURN_POLE[1] + geo[2] * SATURN_POLE[2]) / delta);
      magnitude += -2.6 * sinB + 1.25 * sinB * sinB;
    }
    return {
      name: planet.name,
      ra: ((Math.atan2(geo[1], geo[0]) / DEG) + 360) % 360,
      dec: Math.asin(geo[2] / delta) / DEG,
      magnitude,
      bv: planet.bv,
    };
  });
}
