"""Electron から呼ばれるローカル API。"""
import os
import sys
import threading
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import clouds, news, sources
from .config import DEFAULT_SETTINGS, load_settings, update_settings
from .llm import LlamaServer, LlmError, list_models

HOURLY_STEP = 3
HOURLY_COUNT = 8

llama = LlamaServer()
summary_cache: dict[tuple[str, str, str], str] = {}


def _watch_parent() -> None:
    """親 (Electron) が終了すると stdin が閉じるので、LLM ごと確実に止める。"""
    sys.stdin.buffer.read()
    llama.stop()
    os._exit(0)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if os.environ.get("WEATHER_NEWS_WATCH_STDIN"):
        threading.Thread(target=_watch_parent, daemon=True).start()
    yield
    llama.stop()


app = FastAPI(lifespan=lifespan)


class Location(BaseModel):
    name: str
    admin1: str | None = None
    country: str | None = None
    country_code: str | None = None
    latitude: float
    longitude: float


class SettingsUpdate(BaseModel):
    location: Location | None = None
    models_dir: str
    model: str | None = None


class ModeUpdate(BaseModel):
    mode: Literal["normal", "weather", "wind"]


class PanelsUpdate(BaseModel):
    news: bool
    hourly: bool
    weekly: bool


class GraphicsUpdate(BaseModel):
    fps_limit: Literal[0, 30, 60, 120]
    render_scale: Literal[50, 75, 100]
    bloom: bool
    auto_exposure: bool
    show_fps: bool
    show_map_lines: bool
    star_brightness: float = Field(ge=0.125, le=8)
    cloud_shadow: float = Field(ge=0, le=1)
    region_bloom: float = Field(ge=0, le=1)
    glint_strength: float = Field(ge=0, le=3)
    region_detail: bool


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/settings")
def get_settings() -> dict:
    return load_settings()


@app.put("/settings")
def put_settings(update: SettingsUpdate) -> dict:
    if update.model is not None:
        try:
            available = {m["path"] for m in list_models(update.models_dir)}
        except LlmError as e:
            raise HTTPException(400, str(e)) from e
        if update.model not in available:
            raise HTTPException(400, f"フォルダ内にないモデルは選べません: {update.model}")
    return update_settings(update.model_dump())


# モデルの検証を通さず、モードだけを保存する (モデルが消えていても切り替えられるように)
@app.put("/settings/mode")
def put_mode(update: ModeUpdate) -> dict:
    return update_settings({"mode": update.mode})


@app.put("/settings/graphics")
def put_graphics(update: GraphicsUpdate) -> dict:
    return update_settings({"graphics": update.model_dump()})


@app.put("/settings/panels")
def put_panels(update: PanelsUpdate) -> dict:
    return update_settings({"panels": update.model_dump()})


@app.get("/settings/graphics/defaults")
def get_graphics_defaults() -> dict:
    return DEFAULT_SETTINGS["graphics"]


@app.get("/clouds/satellite")
def get_satellite_clouds() -> dict:
    try:
        return clouds.update_satellite_map()
    except clouds.CloudError as e:
        raise HTTPException(502, str(e)) from e


@app.get("/models")
def get_models(models_dir: str) -> dict:
    try:
        return {"models": list_models(models_dir), "error": None}
    except LlmError as e:
        return {"models": [], "error": str(e)}


@app.get("/locations")
def get_locations(q: str) -> list[dict]:
    try:
        return sources.search_locations(q)
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e)) from e


def _summarizer(settings: dict, outcome: dict):
    """選択中のモデルで要約する関数を返す。モデルがなければ None。"""
    if not settings["model"]:
        return None
    model = Path(settings["models_dir"]) / settings["model"]
    if not model.is_file():
        outcome["note"] = f"選択中のモデルが見つからないため、原文を表示しています: {settings['model']}"
        return None

    def summarize(system: str, user: str) -> str:
        key = (settings["model"], system, user)
        if key not in summary_cache:
            summary_cache[key] = llama.chat(model, system, user)
        outcome["model"] = model.stem
        return summary_cache[key]

    return summarize


def _outlook(location: dict, settings: dict, now: datetime) -> tuple[dict | None, str | None]:
    """気象庁の文から見通しを作る。文がない地点や日は見通しなしで返す。"""
    office = sources.office_for(location)
    if not office:
        return None, None
    try:
        overview = sources.fetch_overview(office)
        text = overview["text"]
    except (httpx.HTTPError, ValueError, KeyError):
        return None, "気象庁の文を取得できませんでした"

    for target in news.target_days(now):
        segment = news.target_segment(text, target.day)
        if segment:
            break
    else:
        return None, None

    outcome: dict = {"model": None, "note": None}
    outlook = news.compose_outlook(segment, target.day, _summarizer(settings, outcome))
    return (
        {
            "text": outlook.text,
            "method": outlook.method,
            "original": outlook.original,
            "model": outcome["model"] if outlook.method == "llm" else None,
            "reported_at": overview.get("reportDatetime"),
        },
        outlook.note or outcome["note"],
    )


def _hourly(forecast: dict, now: datetime) -> list[dict]:
    hourly = forecast["hourly"]
    start = now.replace(minute=0)
    rows = []
    for index, value in enumerate(hourly["time"]):
        time = datetime.fromisoformat(value)
        if time <= start or (time - start).total_seconds() % (HOURLY_STEP * 3600):
            continue
        rows.append(
            {
                "time": f"{time.hour}時",
                "temperature": round(hourly["temperature_2m"][index]),
                "rain": hourly["precipitation_probability"][index],
                "weather": news.weather_label(hourly["weather_code"][index]),
                "icon": news.weather_icon(hourly["weather_code"][index]),
                "is_day": bool(hourly["is_day"][index]),
            }
        )
        if len(rows) == HOURLY_COUNT:
            break
    return rows


@app.get("/news")
def get_news() -> dict:
    settings = load_settings()
    location = settings["location"]
    if not location:
        raise HTTPException(409, "地点が設定されていません")
    try:
        forecast = sources.fetch_forecast(location["latitude"], location["longitude"])
    except (httpx.HTTPError, ValueError) as e:
        raise HTTPException(502, f"天気データを取得できませんでした: {e}") from e

    current = forecast["current"]
    now = datetime.fromisoformat(current["time"])
    outlook, note = _outlook(location, settings, now)
    daily = news.daily_from_now(forecast["daily"], forecast["hourly"], now)
    return {
        "location": location,
        "headline": news.headline(location["name"], now),
        "current_text": news.current_sentence(current),
        "day_text": news.day_sentence(daily, news.focus_index(now)),
        "outlook": outlook,
        "note": note,
        "current": {
            "weather": news.weather_label(current["weather_code"]),
            "icon": news.weather_icon(current["weather_code"]),
            "is_day": bool(current["is_day"]),
            "temperature": current["temperature_2m"],
            "apparent": current["apparent_temperature"],
            "humidity": current["relative_humidity_2m"],
            "wind_speed": current["wind_speed_10m"],
            "wind_direction": news.wind_direction(current["wind_direction_10m"]),
            "gust": current["wind_gusts_10m"],
        },
        "hourly": _hourly(forecast, now),
        "weekly": news.weekly_rows(daily),
    }
