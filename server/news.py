"""ニュース文の組み立て。通信はせず、数値と文章だけを扱う。

数値の文はテンプレートで作る。気象庁の文は 1 文に整形できれば整形し、できなければ原文を表示する。
"""
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

PREFIX = "気象庁によると、"

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
CALM_WIND_MS = 0.3
WEEKDAYS = "月火水木金土日"
# 朝に見るアプリなので普段は今日の話をする。この時刻からは明日の話に切り替える
EVENING_HOUR = 18
HOURLY_STEP = 3
HOURLY_COUNT = 8
DAY_NAMES = {0: "今日", 1: "明日"}

# 「でしょう」の前が動詞や形容詞なら「見込みです」、名詞なら「の見込みです」でつなぐ
PREDICATE_ENDINGS = "うくぐすつぬぶむるい"


@dataclass
class Outlook:
    text: str
    method: str  # rule / verbatim
    original: str | None = None


def wind_direction(degrees: float) -> str:
    return DIRECTIONS[round(degrees / 45) % 8]


def weather_label(code: int) -> str:
    return WEATHER.get(code, "不明")


def weather_icon(code: int) -> str:
    return ICONS.get(code, "cloudy")


def weather_fields(code: int) -> dict:
    return {"weather": weather_label(code), "icon": weather_icon(code)}


def clock_label(time: datetime) -> str:
    period = "午前" if time.hour < 12 else "午後"
    minute = f"{time.minute}分" if time.minute else ""
    return f"{period}{time.hour % 12}時{minute}"


def headline(name: str, time: datetime) -> str:
    return f"{name} {time.month}月{time.day}日 {clock_label(time)}"


def current_sentence(current: dict, past_time: datetime | None = None) -> str:
    """past_time を渡すと、その時刻の値として過去形で書く。"""
    weather = weather_label(current["weather_code"])
    lead = f"{past_time.hour}時の" if past_time else "現在の"
    ending = "でした" if past_time else "です"
    first = f"{lead}気温は{current['temperature_2m']:.1f}℃で、{weather}{ending}。"
    speed = current["wind_speed_10m"]
    if speed < CALM_WIND_MS:
        return f"{first}風はほとんどありませんでした。" if past_time else f"{first}風はほとんどありません。"
    direction = wind_direction(current["wind_direction_10m"])
    return f"{first}{direction}寄りの風{speed:.1f}m/s、最大瞬間風速は{current['wind_gusts_10m']:.1f}m/s{ending}。"


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


def focus_index(now: datetime) -> int:
    """ニュースで取り上げる日の、日別予報の添字を返す(0: 今日、1: 明日)。"""
    return 0 if now.hour < EVENING_HOUR else 1


def target_days(now: datetime) -> list[date]:
    """気象庁の文を探す日を優先順に返す。夕方の発表には今日の文がないことがあるので明日も探す。"""
    return [now.date() + timedelta(days=i) for i in range(focus_index(now), 2)]


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


def day_sentence(daily: dict, index: int) -> str:
    label = "今日はこのあと" if index == 0 else "明日は"
    weather = weather_label(daily["weather_code"][index])
    high = round(daily["temperature_2m_max"][index])
    low = round(daily["temperature_2m_min"][index])
    text = f"{label}{weather}で、最高気温は{high}℃、最低気温は{low}℃"
    rain = daily["precipitation_probability_max"][index]
    if rain is not None:
        text += f"、降水確率は最大{rain}%"
    return f"{text}の見込みです。"


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


def split_sentences(text: str) -> list[str]:
    return [s.strip() + "。" for s in text.split("。") if s.strip()]


def target_segment(text: str, day: int) -> str | None:
    """概況文から day 日について書かれた文を取り出す。"""
    text = unicodedata.normalize("NFKC", text)
    paragraphs = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
    # 概況の段落にある「1日夜から2日にかけて」を拾わないよう、日付で始まる文だけを対象にする
    starts = [
        lambda s: re.match(rf"{day}日", s),
        lambda s: re.match(r"\d+日", s) and re.search(rf"(?<!\d){day}日", s),
    ]
    for is_start in starts:
        for paragraph in paragraphs:
            picked: list[str] = []
            for sentence in split_sentences(paragraph):
                head = re.match(r"(\d+)日", sentence)
                if picked and head and int(head.group(1)) != day:
                    break
                if picked or is_start(sentence):
                    picked.append(sentence)
            if picked:
                return "".join(picked)
    return None


def _tidy(segment: str) -> str:
    return re.sub(r"^(\d+日[^、。]{0,15}?は)、", r"\1", segment.strip())


def _with_forecast_ending(sentence: str) -> str:
    match = re.match(r"(.*)でしょう。$", sentence)
    if not match:
        return sentence
    body = match.group(1)
    return f"{body}見込みです。" if body[-1:] in PREDICATE_ENDINGS else f"{body}の見込みです。"


def compose_outlook(segment: str) -> Outlook:
    tidied = _tidy(segment)
    merged = tidied.replace("見込みです。このため、", "ため、")
    sentences = split_sentences(merged)
    if len(sentences) == 1:
        text = PREFIX + _with_forecast_ending(sentences[0])
        return Outlook(text=text, method="rule", original=segment)

    return Outlook(text=PREFIX + tidied, method="verbatim", original=segment)
