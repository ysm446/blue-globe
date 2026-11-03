"""Electron から呼ばれるローカル API。"""
import os
import sys
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel, Field

from . import clouds, news, sources
from .config import DEFAULT_SETTINGS, load_settings, update_settings


def _watch_parent() -> None:
    """親 (Electron) が終了すると stdin が閉じるので、確実に止まる。"""
    sys.stdin.buffer.read()
    os._exit(0)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if os.environ.get("WEATHER_NEWS_WATCH_STDIN"):
        threading.Thread(target=_watch_parent, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)

PAST_LIMIT = timedelta(hours=25)  # 画面は 24 時間まで。操作の間に少し過ぎても受け付ける
PAST_NOTE = "過去の時刻の値です。Open-Meteo の時間別データで、観測値そのものとは限りません"


def _past_time(at: datetime | None) -> datetime | None:
    """at を確かめる。過去の時刻だけを受け付ける。"""
    if at is None:
        return None
    if at.tzinfo is None:
        raise HTTPException(400, "時刻にはタイムゾーンが必要です")
    age = datetime.now(timezone.utc) - at
    if age < timedelta(minutes=-1) or age > PAST_LIMIT:
        raise HTTPException(400, "見られるのは過去 24 時間までです")
    return at


class Location(BaseModel):
    name: str
    admin1: str | None = None
    country: str | None = None
    country_code: str | None = None
    latitude: float
    longitude: float


class SettingsUpdate(BaseModel):
    location: Location | None = None


class ModeUpdate(BaseModel):
    mode: Literal["normal", "weather", "wind"]


class PanelsUpdate(BaseModel):
    news: bool
    hourly: bool
    weekly: bool
    details: bool
    camera: bool


class AudioFileUpdate(BaseModel):
    file: str | None


class AudioVolumeUpdate(BaseModel):
    volume: float = Field(ge=0, le=1)


class GraphicsUpdate(BaseModel):
    fps_limit: Literal[0, 30, 60, 120]
    render_scale: Literal[50, 75, 100]
    bloom: bool
    auto_exposure: bool
    exposure_compensation: float = Field(ge=-2, le=2)
    focal_length: float = Field(ge=14, le=70)
    show_fps: bool
    show_map_lines: bool
    show_city_labels: bool
    show_planet_labels: bool
    star_brightness: float = Field(ge=0.125, le=8)
    cloud_shadow: float = Field(ge=0, le=1)
    region_bloom: float = Field(ge=0, le=1)
    city_glow: float = Field(ge=0, le=2)
    glint_strength: float = Field(ge=0, le=3)
    region_detail: bool
    volume_clouds: bool
    cloud_resolution: Literal[50, 75, 100]
    cloud_edge_detail: float = Field(ge=0, le=1)
    cloud_edge_sharpness: float = Field(ge=0, le=1)
    cloud_puffiness: float = Field(ge=0, le=2)
    cloud_height: float = Field(ge=0.5, le=3)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/settings")
def get_settings() -> dict:
    return load_settings()


@app.put("/settings")
def put_settings(update: SettingsUpdate) -> dict:
    return update_settings(update.model_dump())


@app.put("/settings/mode")
def put_mode(update: ModeUpdate) -> dict:
    return update_settings({"mode": update.mode})


@app.put("/settings/graphics")
def put_graphics(update: GraphicsUpdate) -> dict:
    return update_settings({"graphics": update.model_dump()})


@app.put("/settings/panels")
def put_panels(update: PanelsUpdate) -> dict:
    return update_settings({"panels": update.model_dump()})


@app.put("/settings/audio-file")
def put_audio_file(update: AudioFileUpdate) -> dict:
    return update_settings({"audio_file": update.file})


@app.put("/settings/audio-volume")
def put_audio_volume(update: AudioVolumeUpdate) -> dict:
    return update_settings({"audio_volume": update.volume})


@app.get("/settings/graphics/defaults")
def get_graphics_defaults() -> dict:
    return DEFAULT_SETTINGS["graphics"]


@app.get("/clouds/satellite")
def get_satellite_clouds(
    at: datetime | None = None,
    gfs: str | None = Query(default=None, pattern=r"^gfs-\d{10}$"),
) -> dict:
    target = _past_time(at)
    try:
        return clouds.past_satellite_map(target, gfs) if target else clouds.update_satellite_map()
    except clouds.CloudError as e:
        raise HTTPException(502, str(e)) from e


@app.get("/locations")
def get_locations(q: str) -> list[dict]:
    try:
        return sources.search_locations(q)
    except httpx.HTTPError as e:
        raise HTTPException(502, str(e)) from e


def _outlook(location: dict, now: datetime) -> tuple[dict | None, str | None]:
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

    outlook = news.compose_outlook(segment)
    return (
        {
            "text": outlook.text,
            "method": outlook.method,
            "original": outlook.original,
            "reported_at": overview.get("reportDatetime"),
        },
        None,
    )


def _fetch_forecast(latitude: float, longitude: float, at: datetime | None = None) -> dict:
    try:
        if at:
            return sources.fetch_forecast(latitude, longitude, past=True)
        return sources.fetch_forecast(latitude, longitude)
    except (httpx.HTTPError, ValueError) as e:
        raise HTTPException(502, f"天気データを取得できませんでした: {e}") from e


@app.get("/news")
def get_news(at: datetime | None = None) -> dict:
    target = _past_time(at)
    location = load_settings()["location"]
    if not location:
        raise HTTPException(409, "地点が設定されていません")
    forecast = _fetch_forecast(location["latitude"], location["longitude"], target)
    if target:  # 気象庁の文は今の発表しかない
        return _report(location, forecast, None, PAST_NOTE, target)
    now = datetime.fromisoformat(forecast["current"]["time"])
    outlook, note = _outlook(location, now)
    return _report(location, forecast, outlook, note)


# デモで選ばれた都市の天気。設定は変えない。見通しは作らない
@app.get("/news/place")
def get_place_news(
    name: str,
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
    at: datetime | None = None,
) -> dict:
    target = _past_time(at)
    location = {
        "name": name,
        "admin1": None,
        "country": None,
        "country_code": None,
        "latitude": latitude,
        "longitude": longitude,
    }
    forecast = _fetch_forecast(latitude, longitude, target)
    return _report(location, forecast, None, PAST_NOTE if target else None, target)


def _report(
    location: dict, forecast: dict, outlook: dict | None, note: str | None, at: datetime | None = None
) -> dict:
    current = forecast["current"]
    real_now = datetime.fromisoformat(current["time"])
    # 週間予報はいつの時刻を見ていても今の予報を出す
    daily = news.daily_from_now(news.from_today(forecast["daily"], real_now), forecast["hourly"], real_now)
    now = real_now
    if at:
        now = news.local_hour(at, forecast["utc_offset_seconds"])
        current = news.past_current(forecast["hourly"], now)
        if current is None:
            raise HTTPException(502, "この時刻の天気データがありません")
    return {
        "location": location,
        "utc_offset_seconds": forecast["utc_offset_seconds"],
        "at": at.isoformat() if at else None,
        "headline": news.headline(location["name"], now),
        "current_text": news.current_sentence(current, now if at else None),
        "day_text": "" if at else news.day_sentence(daily, news.focus_index(now)),
        "outlook": outlook,
        "note": note,
        "current": {
            **news.weather_fields(current["weather_code"]),
            "is_day": bool(current["is_day"]),
            "temperature": current["temperature_2m"],
            "apparent": current["apparent_temperature"],
            "humidity": current["relative_humidity_2m"],
            "wind_speed": current["wind_speed_10m"],
            "wind_direction": news.wind_direction(current["wind_direction_10m"]),
            "gust": current["wind_gusts_10m"],
            "rain": news.rain_now(forecast["hourly"], now),
            **news.sun_times(forecast["daily"], now),
        },
        "hourly": news.hourly_rows(forecast["hourly"], now),
        "weekly": news.weekly_rows(daily),
    }
