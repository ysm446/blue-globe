"""天気の値を画面に出す形に整える (時計の横の今の天気、24 時間と週間の予報)。通信はしない。"""
from datetime import date, datetime, timedelta, timezone

WEATHER = {
    0: "快晴", 1: "晴れ", 2: "晴れ時々曇り", 3: "曇り", 45: "霧", 48: "霧",
    51: "弱い霧雨", 53: "霧雨", 55: "強い霧雨", 56: "着氷性の霧雨", 57: "着氷性の霧雨",
    61: "弱い雨", 63: "雨", 65: "強い雨", 66: "着氷性の雨", 67: "着氷性の雨",
    71: "弱い雪", 73: "雪", 75: "強い雪", 77: "霧雪",
    80: "にわか雨", 81: "にわか雨", 82: "激しいにわか雨",
    85: "にわか雪", 86: "強いにわか雪", 95: "雷雨", 96: "ひょうを伴う雷雨", 99: "ひょうを伴う雷雨",
}
ICONS = {
    0: "clear", 1: "mostly-clear", 2: "partly-cloudy", 3: "cloudy", 45: "fog", 48: "fog",
    51: "drizzle", 53: "drizzle", 55: "drizzle", 56: "sleet", 57: "sleet",
    61: "rain", 63: "rain", 65: "heavy-rain", 66: "sleet", 67: "sleet",
    71: "snow", 73: "snow", 75: "snow", 77: "snow",
    80: "rain", 81: "rain", 82: "heavy-rain",
    85: "snow", 86: "snow", 95: "thunder", 96: "thunder", 99: "thunder",
}
DIRECTIONS = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"]
WEEKDAYS = "月火水木金土日"
HOURLY_STEP = 3
HOURLY_COUNT = 8
DAY_NAMES = {0: "今日", 1: "明日"}


def wind_direction(degrees: float) -> str:
    return DIRECTIONS[round(degrees / 45) % 8]


def weather_label(code: int) -> str:
    return WEATHER.get(code, "不明")


def weather_icon(code: int) -> str:
    return ICONS.get(code, "cloudy")


def weather_fields(code: int) -> dict:
    return {"weather": weather_label(code), "icon": weather_icon(code)}


def local_hour(at: datetime, utc_offset_seconds: int) -> datetime:
    """時刻を地点の現地時刻へ直し、一番近い 1 時間に丸める (時間別予報の刻み)。"""
    local = at.astimezone(timezone.utc).replace(tzinfo=None) + timedelta(seconds=utc_offset_seconds)
    return (local + timedelta(minutes=30)).replace(minute=0, second=0, microsecond=0)


def past_current(hourly: dict, time: datetime) -> dict | None:
    """時間別予報から、現在の値と同じ形でその時刻の値を取り出す。予報にない時刻なら None。"""
    key = time.strftime("%Y-%m-%dT%H:%M")
    if key not in hourly["time"]:
        return None
    index = hourly["time"].index(key)
    return {name: values[index] for name, values in hourly.items()}


def from_today(daily: dict, now: datetime) -> dict:
    """前日の分も含む日別予報から、今日より前を除く。"""
    today = now.strftime("%Y-%m-%d")
    start = daily["time"].index(today) if today in daily["time"] else 0
    return {key: values[start:] for key, values in daily.items()}


def rain_now(hourly: dict, now: datetime) -> int | None:
    """今の時間帯の降水確率。予報にない時刻なら None。"""
    start = now.replace(minute=0).strftime("%Y-%m-%dT%H:%M")
    return hourly["precipitation_probability"][hourly["time"].index(start)] if start in hourly["time"] else None


def sun_times(daily: dict, now: datetime) -> dict:
    """今日の日の出と日の入り (地点の現地時刻)。白夜や極夜でないときだけ値がある。"""
    today = now.strftime("%Y-%m-%d")
    index = daily["time"].index(today) if today in daily["time"] else None
    clock = lambda value: value[11:16] if value else None
    return {
        "sunrise": clock(daily["sunrise"][index]) if index is not None else None,
        "sunset": clock(daily["sunset"][index]) if index is not None else None,
    }


def daily_from_now(daily: dict, hourly: dict, now: datetime) -> dict:
    """日別予報のうち今日の分を、今の時刻から先の時間別予報で置き換える。"""
    start = now.replace(minute=0)
    hours = [
        i
        for i, value in enumerate(hourly["time"])
        if start <= (time := datetime.fromisoformat(value)) and time.date() == now.date()
    ]
    if not hours:
        return daily
    rains = [r for i in hours if (r := hourly["precipitation_probability"][i]) is not None]
    temperatures = [hourly["temperature_2m"][i] for i in hours]
    today = {
        # Open-Meteo の日別の天気コードと同じく、期間内で最も悪い天気を代表にする
        "weather_code": max(hourly["weather_code"][i] for i in hours),
        "temperature_2m_max": max(temperatures),
        "temperature_2m_min": min(temperatures),
        "precipitation_probability_max": max(rains) if rains else None,
    }
    return {
        key: [today.get(key, values[0]), *values[1:]] for key, values in daily.items()
    }


def hourly_rows(hourly: dict, now: datetime) -> list[dict]:
    """今の時刻から先の時間別予報を、一定の間隔で取り出す。"""
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
                **weather_fields(hourly["weather_code"][index]),
                "is_day": bool(hourly["is_day"][index]),
            }
        )
        if len(rows) == HOURLY_COUNT:
            break
    return rows


def weekly_rows(daily: dict) -> list[dict]:
    rows = []
    for index, value in enumerate(daily["time"]):
        day = date.fromisoformat(value)
        rows.append(
            {
                "label": DAY_NAMES.get(index, f"{day.day}({WEEKDAYS[day.weekday()]})"),
                **weather_fields(daily["weather_code"][index]),
                "high": round(daily["temperature_2m_max"][index]),
                "low": round(daily["temperature_2m_min"][index]),
                "rain": daily["precipitation_probability_max"][index],
            }
        )
    return rows

