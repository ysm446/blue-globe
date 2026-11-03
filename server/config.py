"""パスと設定ファイルの読み書き。"""
import json
import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 動作検証時に実際の設定を汚さないよう、環境変数で差し替えられる
DATA_DIR = Path(os.environ.get("WEATHER_NEWS_DATA_DIR", ROOT / "data"))
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULT_SETTINGS = {
    "location": None,
    "mode": "normal",
    "graphics": {
        "fps_limit": 0,  # 0 はモニターのリフレッシュレートに合わせる
        "render_scale": 100,
        "bloom": True,
        "auto_exposure": True,
        "exposure_compensation": 0.0,
        "focal_length": 24,  # フルサイズ換算 (mm)。camera-lens.ts と合わせる
        "show_fps": False,
        "show_map_lines": True,
        "show_city_labels": True,
        "star_brightness": 1.0,
        "cloud_shadow": 0.55,
        "region_bloom": 0.5,
        "glint_strength": 1.3,  # 1 が地球の写真に合わせた強さ
        "region_detail": True,
        "volume_clouds": True,
    },
    "panels": {"news": True, "hourly": True, "weekly": True, "details": True},  # True で開いている
    "audio_file": None,  # 設定画面で選んだ音源のパス
    "audio_volume": 0.5,  # スライダーの位置 (0〜1)
}


_settings_lock = threading.Lock()


def load_settings() -> dict:
    try:
        saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    # 項目を増やしても以前の設定ファイルが読めるよう、描画とパネルの設定は項目ごとに既定値で補う
    graphics = {**DEFAULT_SETTINGS["graphics"], **saved.get("graphics", {})}
    panels = {**DEFAULT_SETTINGS["panels"], **saved.get("panels", {})}
    return {**DEFAULT_SETTINGS, **saved, "graphics": graphics, "panels": panels}


def atomic_write(path: Path, data: bytes) -> None:
    """書き込みの途中で落ちても、壊れたファイルを残さない。"""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def save_settings(settings: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    atomic_write(SETTINGS_FILE, json.dumps(settings, ensure_ascii=False, indent=2).encode("utf-8"))


def update_settings(changes: dict) -> dict:
    """設定の一部を変えて保存する。

    API は複数のスレッドで動くので、読み込みから保存までを 1 つずつ行う。
    同時に書くと一時ファイルが壊れたり、片方の変更が失われたりする。
    """
    with _settings_lock:
        settings = {**load_settings(), **changes}
        save_settings(settings)
        return settings
