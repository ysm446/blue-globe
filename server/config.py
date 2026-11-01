"""パスと設定ファイルの読み書き。"""
import json
import os
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 動作検証時に実際の設定を汚さないよう、環境変数で差し替えられる
DATA_DIR = Path(os.environ.get("WEATHER_NEWS_DATA_DIR", ROOT / "data"))
LOG_DIR = DATA_DIR / "logs"
SETTINGS_FILE = DATA_DIR / "settings.json"
LLAMA_SERVER = ROOT / "runtime" / "llama.cpp" / "llama-server.exe"

DEFAULT_SETTINGS = {
    "location": None,
    "mode": "normal",
    "graphics": {
        "fps_limit": 0,  # 0 はモニターのリフレッシュレートに合わせる
        "render_scale": 100,
        "bloom": True,
        "auto_exposure": True,
        "show_fps": False,
        "show_map_lines": True,
        "star_brightness": 1.0,
        "cloud_shadow": 0.55,
        "region_bloom": 0.5,
        "glint_strength": 1.3,  # 1 が地球の写真に合わせた強さ
        "region_detail": True,
    },
    "panels": {"news": True, "hourly": True, "weekly": True},  # True で開いている
    "models_dir": r"D:\ai-models\llm",
    "model": r"lmstudio-community\gemma-4-E4B-it-GGUF\gemma-4-E4B-it-Q4_K_M.gguf",
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


def save_settings(settings: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(SETTINGS_FILE)


def update_settings(changes: dict) -> dict:
    """設定の一部を変えて保存する。

    API は複数のスレッドで動くので、読み込みから保存までを 1 つずつ行う。
    同時に書くと一時ファイルが壊れたり、片方の変更が失われたりする。
    """
    with _settings_lock:
        settings = {**load_settings(), **changes}
        save_settings(settings)
        return settings
