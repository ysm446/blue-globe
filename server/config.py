"""パスと設定ファイルの読み書き。"""
import json
import os
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
    "models_dir": r"D:\ai-models\llm",
    "model": r"lmstudio-community\gemma-4-E4B-it-GGUF\gemma-4-E4B-it-Q4_K_M.gguf",
}


def load_settings() -> dict:
    try:
        saved = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        saved = {}
    return {**DEFAULT_SETTINGS, **saved}


def save_settings(settings: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(SETTINGS_FILE)
