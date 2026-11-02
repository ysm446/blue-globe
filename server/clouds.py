"""天気モードの雲マップを作る。

NOAA の全球衛星合成画像 (GMGSI、赤外) から、薄い雲も濃い雲も同じデータで作る。
別のデータを混ぜると、薄い雲と濃い雲の形がつながらないため。GFS の雲量は次の 3 点の補助に使う。
- 晴れた場所の値は緯度で大きく違うので、GFS が晴れとする場所から緯度ごとの基準を求める
- 赤外は冷たいほど明るいので、冷たい地面も雲に見える。GFS が晴れとする場所では抑える
- 衛星のない極付近は GFS で埋める
赤外は暖かい低い雲が写りにくいので、海面近くの雲は実際より少なく見える。
GFS の取得はメインプロセスが行い、data/cloud-cache/ に置く。
"""
import json
import re
from datetime import datetime, timedelta, timezone
import threading

import h5py
import httpx
import numpy as np

from .config import DATA_DIR, atomic_write

GMGSI_BASE = "https://noaa-gmgsi-pds.s3.amazonaws.com"
TIMEOUT_SECONDS = 90
WIDTH = 4096
HEIGHT = 2048

MAP_VERSION = 2  # 作り方を変えたら増やす。同じ時刻のデータでも作り直す

# 赤外の値を雲の濃さへ直す。2026-11-01 の実測で、晴れた場所の値は熱帯で約 73、南緯 60 度で約 136
IR_THICK = 215.0  # 台風の中心は約 205
IR_CLEAR_MARGIN = 8.0  # 晴れた場所の値のばらつき分。これより上から雲とする
DENSITY_GAMMA = 1.15
BACKGROUND_BAND_DEGREES = 5.0
BACKGROUND_MIN_SAMPLES = 200
BACKGROUND_MAX = 160.0  # これより高いと雲そのものを基準にしている
GFS_CLEAR_COVER = 0.1
POLE_FADE_START = 68.0  # 衛星のある範囲 (約 ±72.7°) の内側から GFS へ切り替える
POLE_FADE_END = 72.0
POLE_COVER = 0.75


class CloudError(Exception):
    pass


def _cache_dir():
    return DATA_DIR / "cloud-cache"


def _keys_of(listing: str) -> list[str]:
    return re.findall(r"<Key>([^<]+\.nc)</Key>", listing)


def _list_keys(day: datetime) -> list[str]:
    response = httpx.get(
        GMGSI_BASE,
        params={"list-type": "2", "prefix": f"GMGSI_LW/{day:%Y/%m/%d}/"},
        timeout=TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return _keys_of(response.text)


def latest_key(now: datetime) -> str:
    """最新のファイルを探す。日付が変わった直後は前日分になる。"""
    for offset in (0, 1):
        keys = _list_keys(now - timedelta(days=offset))
        if keys:
            return max(keys)
    raise CloudError("衛星画像が見つかりませんでした")


def nearest_key(target: datetime) -> str:
    """target に最も近い時刻のファイルを探す。日付の境目では隣の日のファイルが近いことがある。"""
    keys = [key for offset in (-1, 0, 1) for key in _list_keys(target + timedelta(days=offset))]
    if not keys:
        raise CloudError("衛星画像が見つかりませんでした")
    return min(keys, key=lambda key: abs(datetime.fromisoformat(valid_time_of(key)) - target))


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


def _typical_clear_ir(lats: np.ndarray) -> np.ndarray:
    """晴れた場所の典型的な値。GFS から求められない緯度で使う。"""
    return 72.0 + 0.012 * lats * lats


def clear_background(ir: np.ndarray, target: np.ndarray | None) -> np.ndarray:
    """緯度ごとの晴れた場所の赤外の値を、行ごとの配列で返す。"""
    lats = target_latitudes(ir.shape[0])
    typical = _typical_clear_ir(lats)
    if target is None:
        return typical
    centers, values = [], []
    clear = (target < GFS_CLEAR_COVER) & ~np.isnan(ir)
    for center in np.arange(-90 + BACKGROUND_BAND_DEGREES / 2, 90, BACKGROUND_BAND_DEGREES):
        rows = np.abs(lats - center) < BACKGROUND_BAND_DEGREES / 2
        samples = ir[rows][clear[rows]]
        if samples.size >= BACKGROUND_MIN_SAMPLES:
            median = float(np.median(samples))
            if median <= BACKGROUND_MAX:
                centers.append(center)
                values.append(median)
    if not centers:
        return typical
    # np.interp は昇順の座標を求める。データのない緯度は端の値を延ばさず典型値に戻す
    measured = np.interp(lats, centers, values)
    outside = (lats < centers[0] - BACKGROUND_BAND_DEGREES) | (lats > centers[-1] + BACKGROUND_BAND_DEGREES)
    return np.where(outside, typical, measured)


def compose(ir: np.ndarray, gfs: np.ndarray | None) -> np.ndarray:
    """赤外の値 (0〜255) と GFS 雲量 (0〜1、元の格子) から雲の濃さ (0〜1) を作る。"""
    height, width = ir.shape
    target = None if gfs is None else gfs_to_target(gfs, width, height)
    start = (clear_background(ir, target) + IR_CLEAR_MARGIN)[:, None]
    t = np.clip((np.nan_to_num(ir, nan=0.0) - start) / (IR_THICK - start), 0, 1)
    density = t**DENSITY_GAMMA
    if gfs is None:
        return density
    mask = gfs_to_target(_dilate_and_blur(gfs, 3), width, height)
    density = density * np.clip((mask - GFS_CLEAR_COVER) / 0.5, 0, 1)
    lats = np.abs(target_latitudes(height))
    edge = np.clip((lats - POLE_FADE_START) / (POLE_FADE_END - POLE_FADE_START), 0, 1)[:, None]
    return density * (1 - edge) + target * POLE_COVER * edge


def _read_gfs(name: str = "current-cloud") -> np.ndarray | None:
    meta_path = _cache_dir() / f"{name}.json"
    bin_path = _cache_dir() / f"{name}.bin"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        raw = np.frombuffer(bin_path.read_bytes(), dtype=np.uint8)
        return raw.reshape(meta["ny"], meta["nx"]).astype(np.float32) / 255
    except (OSError, ValueError, KeyError):
        return None


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
        if previous and previous.get("key") == key and previous.get("version") == MAP_VERSION and bin_path.exists():
            return {**previous, "stale": False}
        response = httpx.get(f"{GMGSI_BASE}/{key}", timeout=TIMEOUT_SECONDS)
        response.raise_for_status()
        download = cache / "gmgsi.nc"
        atomic_write(download, response.content)
        density = compose(read_gmgsi(download), _read_gfs())
    except (httpx.HTTPError, OSError, ValueError, KeyError, CloudError) as e:
        if previous and bin_path.exists():
            return {**previous, "stale": True}
        raise CloudError(f"衛星画像を取得できませんでした: {e}") from e

    atomic_write(bin_path, (np.clip(density, 0, 1) * 255).astype(np.uint8).tobytes())
    meta = {"version": MAP_VERSION, "key": key, "nx": density.shape[1], "ny": density.shape[0], "valid_time": valid_time_of(key)}
    atomic_write(meta_path, json.dumps(meta).encode("utf-8"))
    return {**meta, "stale": False}


# 同じ時刻を続けて頼まれても、取得と変換を一度で済ませる
_past_lock = threading.Lock()


def past_satellite_map(target: datetime, gfs_name: str | None = None) -> dict:
    """target に最も近い時刻の雲マップを data/cloud-cache/past/ に作り、メタ情報を返す。

    中身は変わらないので、作ったものは取り直さない。古いものはメインプロセスが消す。
    """
    past = _cache_dir() / "past"
    hour = (target.astimezone(timezone.utc) + timedelta(minutes=30)).strftime("%Y%m%d%H")
    meta_path = past / f"sat-{hour}.json"
    bin_path = past / f"sat-{hour}.bin"
    with _past_lock:
        if meta_path.exists() and bin_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if meta.get("version") == MAP_VERSION:
                return meta
        past.mkdir(parents=True, exist_ok=True)
        download = past / f"sat-{hour}.nc"
        try:
            key = nearest_key(target)
            response = httpx.get(f"{GMGSI_BASE}/{key}", timeout=TIMEOUT_SECONDS)
            response.raise_for_status()
            atomic_write(download, response.content)
            gfs = _read_gfs(f"past/{gfs_name}") if gfs_name else None
            density = compose(read_gmgsi(download), gfs)
        except (httpx.HTTPError, OSError, ValueError, KeyError) as e:
            raise CloudError(f"衛星画像を取得できませんでした: {e}") from e
        finally:
            download.unlink(missing_ok=True)
        atomic_write(bin_path, (np.clip(density, 0, 1) * 255).astype(np.uint8).tobytes())
        meta = {
            "version": MAP_VERSION,
            "key": key,
            "nx": density.shape[1],
            "ny": density.shape[0],
            "valid_time": valid_time_of(key),
            "file": bin_path.name,
        }
        atomic_write(meta_path, json.dumps(meta).encode("utf-8"))
        return meta
