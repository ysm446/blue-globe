// ボリューム雲の形に使う 3D ノイズ。端がつながるので、繰り返して貼っても継ぎ目が出ない
export const CLOUD_NOISE_SIZE = 64;

const OCTAVE_WEIGHTS = [0.625, 0.25, 0.125];
const SHAPE_CELLS = 4; // 大きなかたまりの、1 辺あたりの数
const DETAIL_CELLS = 8; // 縁を削る細かいかたまりの、1 辺あたりの数

// 結果が毎回同じになるよう、種を決められる乱数を使う
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 格子ごとに 1 点を置き、最も近い点までの距離を求める。点の近くほど大きい値にして、丸いかたまりを作る
function* addWorley(out: Float32Array, size: number, cells: number, weight: number, random: () => number): Generator<void> {
  const points = new Float32Array(cells * cells * cells * 3);
  for (let i = 0; i < points.length; i++) points[i] = random();
  const scale = cells / size;
  let index = 0;
  for (let z = 0; z < size; z++) {
    const pz = (z + 0.5) * scale;
    const cz = Math.floor(pz);
    for (let y = 0; y < size; y++) {
      const py = (y + 0.5) * scale;
      const cy = Math.floor(py);
      for (let x = 0; x < size; x++) {
        const px = (x + 0.5) * scale;
        const cx = Math.floor(px);
        let nearest = Infinity;
        for (let dz = -1; dz <= 1; dz++) {
          const gz = cz + dz;
          const wz = (gz + cells) % cells;
          for (let dy = -1; dy <= 1; dy++) {
            const gy = cy + dy;
            const wy = (gy + cells) % cells;
            for (let dx = -1; dx <= 1; dx++) {
              const gx = cx + dx;
              const point = (((gx + cells) % cells) + cells * (wy + cells * wz)) * 3;
              const ax = gx + points[point] - px;
              const ay = gy + points[point + 1] - py;
              const az = gz + points[point + 2] - pz;
              const distance = ax * ax + ay * ay + az * az;
              if (distance < nearest) nearest = distance;
            }
          }
        }
        out[index++] += (1 - Math.min(1, Math.sqrt(nearest))) * weight;
      }
    }
    yield;
  }
}

function* layer(size: number, baseCells: number, random: () => number): Generator<void, Float32Array> {
  const out = new Float32Array(size * size * size);
  for (const [octave, weight] of OCTAVE_WEIGHTS.entries()) {
    yield* addWorley(out, size, baseCells * 2 ** octave, weight, random);
  }
  return out;
}

// 値の幅を 0〜255 いっぱいに広げ、2 つ目の成分の位置へ書き込めるよう 1 つおきに並べる
function writeChannel(target: Uint8Array, channel: number, values: Float32Array): void {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const scale = 255 / Math.max(max - min, 1e-6);
  values.forEach((value, i) => {
    target[i * 2 + channel] = Math.round((value - min) * scale);
  });
}

// 1 成分目が大きなかたまり、2 つ目が細かいかたまり。描画を止めないよう、1 面ごとに手を止めながら作る
export function* generateCloudNoise(size: number = CLOUD_NOISE_SIZE): Generator<void, Uint8Array<ArrayBuffer>> {
  const random = seededRandom(20261102);
  const data = new Uint8Array(size * size * size * 2);
  writeChannel(data, 0, yield* layer(size, SHAPE_CELLS, random));
  writeChannel(data, 1, yield* layer(size, DETAIL_CELLS, random));
  return data;
}

export function createCloudNoise(size: number = CLOUD_NOISE_SIZE): Uint8Array<ArrayBuffer> {
  const steps = generateCloudNoise(size);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
