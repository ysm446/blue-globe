"""GHS-POP の人口の格子を、地球に重ねる人口密度の画像 (assets/textures/population.png) に変換する。

使い方 (手元で 1 回だけ実行する。アプリの実行には要らない):
  1. https://ghsl.jrc.ec.europa.eu/download.php から
     GHS_POP_E2025_GLOBE_R2023A_4326_30ss_V1_0.zip (2025 年推計、経緯度 30 秒角) を落として展開する
  2. pip install numpy tifffile imagecodecs pillow
  3. python scripts/build-population.py <展開した .tif> assets/textures/population.png

出力は経緯度をそのまま縦横に並べた 8192x4096 の画像で、earth-day.jpg と同じ座標で貼れる。
各セルの人口を合計し、セルの面積 (球の上の面積) で割った人口密度 (人/km²) を対数で 0〜255 に詰める。
  R: 0 は 10^LOG_MIN 未満 (ほぼ無人)。1〜255 は log10(密度) を LOG_MIN〜LOG_MAX の範囲で直線に割り当てる
  G: 人が住んでいるセルは 255、無人は 0
  B: 使わない (0)
縮小画像 (ミップマップ) では R も G も平均されるので、R / G が人の住んでいるセルだけの平均になる。
R だけだと海の 0 と平均され、細い島や海岸が実際より疎に見える
読む側の定数は src/renderer/population.ts と揃える。
"""

import math
import sys

import numpy as np
import tifffile
from PIL import Image

WIDTH = 8192
HEIGHT = 4096
LOG_MIN = -2.0  # 0.01 人/km²
LOG_MAX = 5.0  # 10 万人/km²
EARTH_RADIUS_KM = 6371.0


def main(src: str, dst: str) -> None:
    tif = tifffile.TiffFile(src)
    page = tif.pages[0]
    scale_x, scale_y, _ = page.tags['ModelPixelScaleTag'].value
    _, _, _, lon0, lat0, _ = page.tags['ModelTiepointTag'].value
    pop = page.asarray()  # float64、行は北から南
    rows, cols = pop.shape
    print(f'source {cols}x{rows}, lon0 {lon0}, lat0 {lat0}, step {scale_x}')

    # 欠測は負の値で入っているので 0 にする
    pop[~(pop > 0)] = 0.0
    print(f'total population {pop.sum() / 1e9:.3f} billion')

    # 元の画素の中心が、出力のどのセルに入るか
    lon = lon0 + (np.arange(cols) + 0.5) * scale_x
    lat = lat0 - (np.arange(rows) + 0.5) * scale_y
    col_idx = np.clip(np.floor((lon + 180.0) / 360.0 * WIDTH).astype(np.int64), 0, WIDTH - 1)
    row_idx = np.clip(np.floor((90.0 - lat) / 180.0 * HEIGHT).astype(np.int64), 0, HEIGHT - 1)

    total = np.zeros(HEIGHT * WIDTH, dtype=np.float64)
    for r in range(rows):
        line = pop[r]
        nz = np.nonzero(line)[0]
        if nz.size:
            np.add.at(total, row_idx[r] * WIDTH + col_idx[nz], line[nz])
    total = total.reshape(HEIGHT, WIDTH)
    print(f'binned population {total.sum() / 1e9:.3f} billion')

    # 出力のセルの面積 (km²)。行ごとに変わる
    edges = np.radians(90.0 - np.arange(HEIGHT + 1) * 180.0 / HEIGHT)
    dlon = 2.0 * math.pi / WIDTH
    area = EARTH_RADIUS_KM**2 * dlon * (np.sin(edges[:-1]) - np.sin(edges[1:]))
    density = total / area[:, None]

    out = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    lived = density >= 10.0**LOG_MIN
    t = (np.log10(density[lived]) - LOG_MIN) / (LOG_MAX - LOG_MIN)
    out[lived] = np.clip(np.round(1 + t * 254), 1, 255).astype(np.uint8)
    print(f'max density {density.max():.0f} /km2, cells lived {lived.mean() * 100:.1f}%')

    rgb = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    rgb[..., 0] = out
    rgb[..., 1] = np.where(lived, 255, 0)
    Image.fromarray(rgb, mode='RGB').save(dst, optimize=True)
    print(f'wrote {dst}')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
