"""Electron から呼ばれるローカル API。"""
import os
import sys
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Path, Query
from pydantic import BaseModel, Field

from . import clouds, news, sources
from .config import DEFAULT_SETTINGS, delete_tour, load_settings, load_tours, put_tour, update_camera_bookmark, update_settings


def _watch_parent() -> None:
    """親 (Electron) が終了すると stdin が閉じるので、確実に止まる。"""
    sys.stdin.buffer.read()
    os._exit(0)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if os.environ.get("WEATHER_GLOBE_WATCH_STDIN"):
        threading.Thread(target=_watch_parent, daemon=True).start()
    yield


app = FastAPI(lifespan=lifespan)

PAST_LIMIT = timedelta(hours=97)  # 画面は 3 日前の 0 時まで (最長 96 時間前)。操作の間に少し過ぎても受け付ける


def _past_time(at: datetime | None) -> datetime | None:
    """at を確かめる。過去の時刻だけを受け付ける。"""
    if at is None:
        return None
    if at.tzinfo is None:
        raise HTTPException(400, "時刻にはタイムゾーンが必要です")
    age = datetime.now(timezone.utc) - at
    if age < timedelta(minutes=-1) or age > PAST_LIMIT:
        raise HTTPException(400, "見られるのは 3 日前までです")
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
    hourly: bool
    weekly: bool
    details: bool
    camera: bool
    tours: bool = True  # ツアーのパネル。以前の画面から送られても受け付けるよう、省いたときは開いている


class CameraBookmark(BaseModel):
    """保存したカメラの視点。globe は地球ビュー (北が上で地球の中心を向く)、region は地域ビュー。"""

    view: Literal["globe", "region"]
    lat: float = Field(ge=-90, le=90)
    lon: float
    # 地球ビューはカメラの地表からの高さ、地域ビューは中心の地点からカメラまでの距離 (地球の半径が 1)
    distance: float = Field(gt=0)
    heading: float  # 見ている方角。0 が北。地球ビューでは 0
    tilt: float = Field(ge=0, le=90)  # 0 が真下。地球ビューでは 0
    cruise: bool  # 地域ビューの巡航モード


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
    depth_of_field: bool
    f_number: float = Field(ge=1.4, le=22)
    globe_size: float = Field(ge=0.3, le=32)
    show_fps: bool
    show_map_lines: bool
    border_opacity: float = Field(ge=0, le=3)
    show_city_labels: bool
    show_country_labels: bool
    show_planet_labels: bool
    show_constellations: bool
    star_twinkle: bool
    star_brightness: float = Field(ge=0.125, le=8)
    space_tint: float = Field(ge=0, le=1)
    cloud_shadow: float = Field(ge=0, le=1)
    region_bloom: float = Field(ge=0, le=1)
    city_glow: float = Field(ge=0, le=2)
    moonlight: bool
    glint_strength: float = Field(ge=0, le=3)
    region_detail: bool
    region_relief: bool
    terrain_shading: float = Field(ge=0, le=4)
    volume_clouds: bool
    cloud_resolution: Literal[50, 75, 100]
    cloud_edge_detail: float = Field(ge=0, le=1)
    cloud_edge_sharpness: float = Field(ge=0, le=1)
    cloud_puffiness: float = Field(ge=0, le=2)
    cloud_height: float = Field(ge=0.5, le=3)
    ui_font: Literal["noto-sans-jp", "yu-gothic-ui", "meiryo-ui", "biz-udp-gothic", "yu-mincho"]
    cruise_mode: Literal["analog", "stepped"]
    cruise_bank: bool
    lens_flare: bool
    wireframe: bool
    mcp_server: bool
    show_hourly_panel: bool
    show_weekly_panel: bool
    show_details_panel: bool
    show_camera_panel: bool
    show_tour_panel: bool = True  # 以前の画面から送られても受け付けるよう、省いたときは出す
    show_heading_tape: bool = True  # 同上
    show_scale_bar: bool = True  # 同上


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


@app.put("/settings/camera-bookmarks/{slot}")
def put_camera_bookmark(bookmark: CameraBookmark, slot: int = Path(ge=0, le=9)) -> dict:
    return update_camera_bookmark(slot, bookmark.model_dump())


class SavedTour(BaseModel):
    """保存したツアー。scenes は画面の tour.ts の TourScene の並びで、形は MCP サーバーが確かめる。"""

    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    title: str = Field(min_length=1, max_length=80)
    scenes: list[dict] = Field(min_length=1, max_length=200)
    saved_at: datetime


@app.get("/tours")
def get_tours() -> list[dict]:
    return load_tours()


@app.put("/tours/{tour_id}")
def put_saved_tour(tour: SavedTour, tour_id: str = Path(pattern=r"^[A-Za-z0-9_-]{1,64}$")) -> list[dict]:
    if tour.id != tour_id:
        raise HTTPException(400, "id が URL と合いません")
    return put_tour(tour.model_dump(mode="json"))


@app.delete("/tours/{tour_id}")
def delete_saved_tour(tour_id: str = Path(pattern=r"^[A-Za-z0-9_-]{1,64}$")) -> list[dict]:
    tours = delete_tour(tour_id)
    if tours is None:
        raise HTTPException(404, "そのツアーは見つかりません")
    return tours


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
    return _report(location, forecast, target)


# デモで選ばれた都市の天気。設定は変えない
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
    return _report(location, forecast, target)


def _report(location: dict, forecast: dict, at: datetime | None = None) -> dict:
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
