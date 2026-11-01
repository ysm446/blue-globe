"""ニュース文の組み立て。通信はせず、数値と文章だけを扱う。

数値の文はテンプレートで作り、LLM には触らせない。
気象庁の文は整形で済めばそのまま使い、複数の文をまとめる必要があるときだけ LLM を使う。
LLM の出力が検査に落ちたら、原文を表示する。
"""
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from .llm import LlmError

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

SUMMARY_SYSTEM = """あなたは気象ニュースの編集者です。入力された気象庁の文章だけを根拠に、日本語で1文に要約します。
- 「気象庁によると、{day}日は」で始め、「見込みです。」で終える。
- 原因となる気圧配置、天気、時間帯を残す。
- 雷、雪、地域ごとの違いなど、注意すべき情報を省かない。
- 入力にない情報、数値、地名を加えない。
- 要約文だけを出力する。"""

# 出力に現れたら、原文にも現れているべき語
NO_ADD = [
    "雨", "雪", "雷", "晴", "曇", "霧", "台風", "低気圧", "前線", "高気圧", "気圧の谷",
    "湿った空気", "寒気", "未明", "明け方", "朝", "昼前", "昼過ぎ", "夕方", "夜",
    "北部", "南部", "東部", "西部", "中部", "日中", "午後",
]
# 原文にあれば、出力にも残っているべき語
MUST_KEEP = [
    "雨", "雪", "雷", "台風", "暴風", "大雨", "大雪", "竜巻", "高波", "晴れ", "曇り", "所",
    "未明", "明け方", "朝", "昼前", "昼過ぎ", "夕方", "夜", "日中", "午後",
]
REGION_RE = re.compile(r"[一-龠々]*(?:地方|諸島|北部|南部|東部|西部|中部)")
# 「でしょう」の前が動詞や形容詞なら「見込みです」、名詞なら「の見込みです」でつなぐ
PREDICATE_ENDINGS = "うくぐすつぬぶむるい"


@dataclass
class Outlook:
    text: str
    method: str  # rule / llm / verbatim
    original: str | None = None
    note: str | None = None


def wind_direction(degrees: float) -> str:
    return DIRECTIONS[round(degrees / 45) % 8]


def weather_label(code: int) -> str:
    return WEATHER.get(code, "不明")


def weather_icon(code: int) -> str:
    return ICONS.get(code, "cloudy")


def clock_label(time: datetime) -> str:
    period = "午前" if time.hour < 12 else "午後"
    minute = f"{time.minute}分" if time.minute else ""
    return f"{period}{time.hour % 12}時{minute}"


def headline(name: str, time: datetime) -> str:
    return f"{name} {time.month}月{time.day}日 {clock_label(time)}"


def current_sentence(current: dict) -> str:
    weather = weather_label(current["weather_code"])
    first = f"現在の気温は{current['temperature_2m']:.1f}℃で、{weather}です。"
    speed = current["wind_speed_10m"]
    if speed < CALM_WIND_MS:
        return f"{first}風はほとんどありません。"
    direction = wind_direction(current["wind_direction_10m"])
    return f"{first}{direction}寄りの風{speed:.1f}m/s、最大瞬間風速は{current['wind_gusts_10m']:.1f}m/sです。"


def focus_index(now: datetime) -> int:
    """ニュースで取り上げる日の、日別予報の添字を返す(0: 今日、1: 明日)。"""
    return 0 if now.hour < EVENING_HOUR else 1


def target_days(now: datetime) -> list[date]:
    """気象庁の文を探す日を優先順に返す。夕方の発表には今日の文がないことがあるので明日も探す。"""
    return [now.date() + timedelta(days=i) for i in range(focus_index(now), 2)]


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


def weekly_rows(daily: dict) -> list[dict]:
    rows = []
    for index, value in enumerate(daily["time"]):
        day = date.fromisoformat(value)
        code = daily["weather_code"][index]
        names = {0: "今日", 1: "明日"}
        rows.append(
            {
                "label": names.get(index, f"{day.day}({WEEKDAYS[day.weekday()]})"),
                "weather": weather_label(code),
                "icon": weather_icon(code),
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


def summary_problems(output: str, segment: str) -> list[str]:
    problems = []
    if not re.match(rf"{PREFIX}\d+日", output):
        problems.append("書き出し")
    if not output.endswith("見込みです。") or output.count("。") != 1:
        problems.append("文末")
    if len(output) > len(PREFIX) + len(segment) + 10:
        problems.append("長さ")
    problems += [f"追加:{word}" for word in NO_ADD if word in output and word not in segment]
    problems += [f"欠落:{word}" for word in MUST_KEEP if word in segment and word not in output]
    for region in REGION_RE.findall(segment):
        if region not in output:
            problems.append(f"地域欠落:{region}")
    return problems


def compose_outlook(
    segment: str,
    day: int,
    summarize: Callable[[str, str], str] | None,
) -> Outlook:
    """summarize(system, user) は LLM 呼び出し。None なら LLM を使わない。"""
    tidied = _tidy(segment)
    merged = tidied.replace("見込みです。このため、", "ため、")
    sentences = split_sentences(merged)
    if len(sentences) == 1:
        text = PREFIX + _with_forecast_ending(sentences[0])
        return Outlook(text=text, method="rule", original=segment)

    verbatim = PREFIX + tidied
    if summarize is None:
        return Outlook(text=verbatim, method="verbatim", original=segment)
    try:
        output = summarize(SUMMARY_SYSTEM.format(day=day), segment)
    except LlmError as e:
        return Outlook(text=verbatim, method="verbatim", original=segment, note=str(e))
    problems = summary_problems(output, segment)
    if problems:
        note = f"要約が検査に通らなかったため、原文を表示しています({'、'.join(problems)})"
        return Outlook(text=verbatim, method="verbatim", original=segment, note=note)
    return Outlook(text=output, method="llm", original=segment)
