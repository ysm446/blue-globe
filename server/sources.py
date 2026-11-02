"""外部データの取得(Open-Meteo、気象庁、国土地理院)。"""
import math
import re
import unicodedata

import httpx

TIMEOUT_SECONDS = 20
HEADERS = {"User-Agent": "weather-news"}

PREFECTURE_OFFICES = {
    "青森県": "020000", "岩手県": "030000", "宮城県": "040000", "秋田県": "050000",
    "山形県": "060000", "福島県": "070000", "茨城県": "080000", "栃木県": "090000",
    "群馬県": "100000", "埼玉県": "110000", "千葉県": "120000", "東京都": "130000",
    "神奈川県": "140000", "新潟県": "150000", "富山県": "160000", "石川県": "170000",
    "福井県": "180000", "山梨県": "190000", "長野県": "200000", "岐阜県": "210000",
    "静岡県": "220000", "愛知県": "230000", "三重県": "240000", "滋賀県": "250000",
    "京都府": "260000", "大阪府": "270000", "兵庫県": "280000", "奈良県": "290000",
    "和歌山県": "300000", "鳥取県": "310000", "島根県": "320000", "岡山県": "330000",
    "広島県": "340000", "山口県": "350000", "徳島県": "360000", "香川県": "370000",
    "愛媛県": "380000", "高知県": "390000", "福岡県": "400000", "佐賀県": "410000",
    "長崎県": "420000", "熊本県": "430000", "大分県": "440000", "宮崎県": "450000",
    "鹿児島県": "460100",
}
# 北海道と沖縄は県内が複数の予報区に分かれるので、代表地点が最も近い予報区を選ぶ。
# 十勝地方は概況文が公開されていないため、十勝にも触れる釧路・根室地方の文を使う
REGIONAL_OFFICES = {
    "北海道": [
        ("011000", 45.42, 141.67), ("012000", 43.77, 142.37), ("012000", 43.94, 141.64),
        ("013000", 44.02, 144.27), ("013000", 43.80, 143.90), ("013000", 44.36, 143.35),
        ("014100", 42.98, 144.38), ("014100", 43.33, 145.58), ("014100", 42.92, 143.20),
        ("015000", 42.32, 140.97), ("015000", 42.63, 141.60), ("015000", 42.17, 142.77),
        ("016000", 43.06, 141.35), ("016000", 43.20, 141.76), ("016000", 42.90, 140.75),
        ("017000", 41.77, 140.73), ("017000", 41.87, 140.13),
    ],
    "沖縄県": [
        ("471000", 26.21, 127.68), ("472000", 25.83, 131.23),
        ("473000", 24.81, 125.28), ("474000", 24.34, 124.16),
    ],
}
AMAMI_NORTH_LATITUDE = 29.0
PREFECTURE_RE = re.compile(r"^(北海道|東京都|京都府|大阪府|.{2,3}県)(.+)$")


def _get_json(url: str, **params) -> dict | list:
    response = httpx.get(url, params=params, headers=HEADERS, timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    return response.json()


def fetch_forecast(latitude: float, longitude: float) -> dict:
    return _get_json(
        "https://api.open-meteo.com/v1/forecast",
        latitude=latitude,
        longitude=longitude,
        timezone="auto",
        wind_speed_unit="ms",
        forecast_days=7,
        current="temperature_2m,apparent_temperature,relative_humidity_2m,"
        "weather_code,is_day,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        hourly="temperature_2m,precipitation_probability,weather_code,is_day",
        daily="weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    )


def fetch_overview(office: str) -> dict:
    return _get_json(f"https://www.jma.go.jp/bosai/forecast/data/overview_forecast/{office}.json")


def office_for(location: dict) -> str | None:
    """地点に対応する気象庁の予報区コードを返す。文を取得できない地点は None。"""
    if location.get("country_code") != "JP":
        return None
    prefecture = location.get("admin1")
    latitude, longitude = location["latitude"], location["longitude"]
    if prefecture in REGIONAL_OFFICES:
        return min(
            REGIONAL_OFFICES[prefecture],
            key=lambda o: math.hypot(o[1] - latitude, o[2] - longitude),
        )[0]
    # 奄美地方も概況文が公開されておらず、鹿児島県の文は奄美を除いている
    if prefecture == "鹿児島県" and latitude < AMAMI_NORTH_LATITUDE:
        return None
    return PREFECTURE_OFFICES.get(prefecture)


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
