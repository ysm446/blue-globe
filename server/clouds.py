"""天気モードの雲マップを作る。

NOAA の全球衛星合成画像 (GMGSI、赤外) を主に使い、GFS の雲量で補う。
- 赤外は冷たいほど明るいので、冷たい地面も雲に見える。GFS が晴れとする場所では抑える
- 赤外は暖かい低い雲が写りにくい。GFS の雲を薄い層として足す
- 衛星のない極付近は GFS で埋める
GFS の取得はメインプロセスが行い、data/cloud-cache/ に置く。
"""
import json
import os
import re
from datetime import datetime, timedelta, timezone

import h5py
import httpx
import numpy as np

from .config import DATA_DIR

GMGSI_BASE = "https://noaa-gmgsi-pds.s3.amazonaws.com"
TIMEOUT_SECONDS = 90
WIDTH = 4096
HEIGHT = 2048

# 赤外の値を雲の濃さへ直す範囲。2026-11-01 の実測: 晴れた海 76、砂漠 83、台風の中心 205
IR_CLEAR = 110.0
IR_THICK = 215.0
LOW_CLOUD_VEIL = 0.11  # GFS を薄い層として足す割合。格子が粗いので、濃いと陸の上で模様に見える
POLE_FADE_START = 68.0  # 衛星のある範囲 (約 ±72.7°) の内側から GFS へ切り替える
POLE_FADE_END = 72.0
POLE_COVER = 0.75


class CloudError(Exception):
    pass


def _cache_dir():
    return DATA_DIR / "cloud-cache"


def _keys_of(listing: str) -> list[str]:
    return re.findall(r"<Key>([^<]+\.nc)</Key>", listing)


def latest_key(now: datetime) -> str:
    """最新のファイルを探す。日付が変わった直後は前日分になる。"""
    for offset in (0, 1):
        day = now - timedelta(days=offset)
        response = httpx.get(
            GMGSI_BASE,
            params={"list-type": "2", "prefix": f"GMGSI_LW/{day:%Y/%m/%d}/"},
            timeout=TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        keys = _keys_of(response.text)
        if keys:
            return max(keys)
    raise CloudError("衛星画像が見つかりませんでした")


def valid_time_of(key: str) -> str:
    match = re.search(r"_s(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})", key)
    if not match:
        raise CloudError(f"ファイル名から時刻を読めません: {key}")
    year, month, day, hour, minute = (int(v) for v in match.groups())
    return datetime(year, month, day, hour, minute, tzinfo=timezone.utc).isoformat()


def _bilinear(data: np.ndarray, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    r0 = np.clip(np.floor(rows).astype(int), 0, data.shape[0] - 2)
    c0 = np.clip(np.floor(cols).astype(int), 0, data.shape[1] - 2)
    tr = np.clip(rows - r0, 0, 1)[:, None]
    tc = np.clip(cols - c0, 0, 1)[None, :]
    return (
        data[np.ix_(r0, c0)] * (1 - tr) * (1 - tc)
        + data[np.ix_(r0 + 1, c0)] * tr * (1 - tc)
        + data[np.ix_(r0, c0 + 1)] * (1 - tr) * tc
        + data[np.ix_(r0 + 1, c0 + 1)] * tr * tc
    )


def target_latitudes(height: int = HEIGHT) -> np.ndarray:
    return 90 - (np.arange(height) + 0.5) * 180 / height


def target_longitudes(width: int = WIDTH) -> np.ndarray:
    return -180 + (np.arange(width) + 0.5) * 360 / width


def reproject(
    data: np.ndarray, lat_rows: np.ndarray, lon_cols: np.ndarray, width: int = WIDTH, height: int = HEIGHT
) -> np.ndarray:
    """緯度が行ごと、経度が列ごとに一定の格子を、等距円筒図法 (左端 -180 度、上端が北) へ直す。範囲外は NaN。"""
    order = np.argsort(lon_cols)
    lon_sorted = lon_cols[order]
    sorted_data = data[:, order]
    ascending = lat_rows[0] < lat_rows[-1]
    lat_asc = lat_rows if ascending else lat_rows[::-1]
    row_index = np.arange(len(lat_rows)) if ascending else np.arange(len(lat_rows))[::-1]
    lats = target_latitudes(height)
    rows = np.interp(lats, lat_asc, row_index)
    cols = np.interp(target_longitudes(width), lon_sorted, np.arange(len(lon_sorted)))
    result = _bilinear(sorted_data, rows, cols)
    result[(lats < lat_asc[0]) | (lats > lat_asc[-1]), :] = np.nan
    return result


def read_gmgsi(path) -> np.ndarray:
    with h5py.File(path, "r") as f:
        data = f["data"][()].squeeze().astype(np.float32)
        lat = f["lat"][()]
        lon = f["lon"][()]
        fill = f["data"].attrs["_FillValue"]
    data[data == fill] = np.nan
    return reproject(data, lat[:, lat.shape[1] // 2], lon[lat.shape[0] // 2, :])


def _dilate_and_blur(a: np.ndarray, radius: int) -> np.ndarray:
    """晴れと曇りの境目のずれを許すため、GFS を少し膨らませてぼかす (経度方向は循環)。"""
    result = a
    for _ in range(radius):
        result = np.maximum.reduce(
            [
                result,
                np.roll(result, 1, axis=1),
                np.roll(result, -1, axis=1),
                np.vstack([result[1:], result[-1:]]),
                np.vstack([result[:1], result[:-1]]),
            ]
        )
    for _ in range(radius):
        result = (
            result * 2
            + np.roll(result, 1, axis=1)
            + np.roll(result, -1, axis=1)
            + np.vstack([result[1:], result[-1:]])
            + np.vstack([result[:1], result[:-1]])
        ) / 6
    return result


def gfs_to_target(gfs: np.ndarray, width: int = WIDTH, height: int = HEIGHT) -> np.ndarray:
    """経度 0 度始まりの GFS 格子を、左端 -180 度へ回して拡大する。"""
    ny, nx = gfs.shape
    rolled = np.roll(gfs, nx // 2, axis=1)
    rows = (90 - target_latitudes(height)) / 180 * (ny - 1)
    cols = (target_longitudes(width) + 180) / 360 * nx - 0.5
    return _bilinear(rolled, rows, np.clip(cols, 0, nx - 1))


def compose(ir: np.ndarray, gfs: np.ndarray | None) -> np.ndarray:
    """赤外の値 (0〜255) と GFS 雲量 (0〜1、元の格子) から雲の濃さ (0〜1) を作る。"""
    t = np.clip((np.nan_to_num(ir, nan=0.0) - IR_CLEAR) / (IR_THICK - IR_CLEAR), 0, 1)
    density = t * t * (3 - 2 * t)
    if gfs is None:
        return density
    height, width = ir.shape
    target = gfs_to_target(gfs, width, height)
    mask = gfs_to_target(_dilate_and_blur(gfs, 3), width, height)
    density = density * np.clip((mask - 0.1) / 0.5, 0, 1)
    density = np.maximum(density, target * LOW_CLOUD_VEIL)
    lats = np.abs(target_latitudes(height))
    edge = np.clip((lats - POLE_FADE_START) / (POLE_FADE_END - POLE_FADE_START), 0, 1)[:, None]
    return density * (1 - edge) + target * POLE_COVER * edge


def _read_gfs() -> np.ndarray | None:
    meta_path = _cache_dir() / "current-cloud.json"
    bin_path = _cache_dir() / "current-cloud.bin"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        raw = np.frombuffer(bin_path.read_bytes(), dtype=np.uint8)
        return raw.reshape(meta["ny"], meta["nx"]).astype(np.float32) / 255
    except (OSError, ValueError, KeyError):
        return None


def _atomic_write(path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def update_satellite_map(now: datetime | None = None) -> dict:
    """最新の雲マップを data/cloud-cache/current-sat.bin に作り、メタ情報を返す。

    取得に失敗して前回の結果があれば、それを古いデータとして返す。
    """
    cache = _cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    meta_path = cache / "current-sat.json"
    bin_path = cache / "current-sat.bin"
    previous = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else None
    try:
        key = latest_key(now or datetime.now(timezone.utc))
        if previous and previous.get("key") == key and bin_path.exists():
            return {**previous, "stale": False}
        response = httpx.get(f"{GMGSI_BASE}/{key}", timeout=TIMEOUT_SECONDS)
        response.raise_for_status()
        download = cache / "gmgsi.nc"
        _atomic_write(download, response.content)
        density = compose(read_gmgsi(download), _read_gfs())
    except (httpx.HTTPError, OSError, ValueError, KeyError, CloudError) as e:
        if previous and bin_path.exists():
            return {**previous, "stale": True}
        raise CloudError(f"衛星画像を取得できませんでした: {e}") from e

    _atomic_write(bin_path, (np.clip(density, 0, 1) * 255).astype(np.uint8).tobytes())
    meta = {"key": key, "nx": density.shape[1], "ny": density.shape[0], "valid_time": valid_time_of(key)}
    _atomic_write(meta_path, json.dumps(meta).encode("utf-8"))
    return {**meta, "stale": False}
