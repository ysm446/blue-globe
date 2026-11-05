"""外部データの取得(Open-Meteo、国土地理院)。"""
import re
import unicodedata

import httpx

TIMEOUT_SECONDS = 20
HEADERS = {"User-Agent": "blue-globe"}

PREFECTURE_RE = re.compile(r"^(北海道|東京都|京都府|大阪府|.{2,3}県)(.+)$")


def _get_json(url: str, **params) -> dict | list:
    response = httpx.get(url, params=params, headers=HEADERS, timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    return response.json()


def fetch_forecast(latitude: float, longitude: float, past: bool = False) -> dict:
    """past を付けると前日からの時間別予報も返し、現在の値と同じ項目を時間別でも返す。"""
    hourly = "temperature_2m,precipitation_probability,weather_code,is_day"
    extra = {}
    if past:
        hourly += ",apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m"
        extra["past_days"] = 1
    return _get_json(
        "https://api.open-meteo.com/v1/forecast",
        latitude=latitude,
        longitude=longitude,
        timezone="auto",
        wind_speed_unit="ms",
        forecast_days=7,
        current="temperature_2m,apparent_temperature,relative_humidity_2m,"
        "weather_code,is_day,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        hourly=hourly,
        daily="weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
        **extra,
    )


def _search_gsi(query: str) -> list[dict]:
    rows = _get_json("https://msearch.gsi.go.jp/address-search/AddressSearch", q=query)
    results = []
    for row in rows:
        title = row["properties"]["title"]
        match = PREFECTURE_RE.match(title)
        # 施設名や川の名前を除き、市区町村だけを候補にする
        if not match or query not in title or not re.search(r"[市区町村]$", title):
            continue
        longitude, latitude = row["geometry"]["coordinates"]
        results.append(
            {
                "name": match.group(2),
                "admin1": match.group(1),
                "country": "日本",
                "country_code": "JP",
                "latitude": latitude,
                "longitude": longitude,
            }
        )
    return sorted(results, key=lambda r: (not re.search(r"[市区]$", r["name"]), len(r["name"])))


def _search_open_meteo(query: str) -> list[dict]:
    data = _get_json(
        "https://geocoding-api.open-meteo.com/v1/search",
        name=query,
        count=8,
        language="ja",
    )
    return [
        {
            "name": row["name"],
            "admin1": row.get("admin1"),
            "country": row.get("country"),
            "country_code": row.get("country_code"),
            "latitude": row["latitude"],
            "longitude": row["longitude"],
        }
        for row in data.get("results", [])
    ]


def search_locations(query: str, limit: int = 8) -> list[dict]:
    """国内の市区町村は国土地理院、それ以外は Open-Meteo で探す。"""
    query = unicodedata.normalize("NFKC", query).strip()
    if not query:
        return []
    results, failures = [], 0
    for search in (_search_gsi, _search_open_meteo):
        try:
            results += search(query)
        except (httpx.HTTPError, ValueError, KeyError):
            failures += 1
    if failures == 2:
        raise httpx.HTTPError("地名検索サービスに接続できませんでした")

    unique, seen = [], set()
    for row in results:
        key = (round(row["latitude"], 1), round(row["longitude"], 1))
        if key not in seen:
            seen.add(key)
            unique.append(row)
    return unique[:limit]
