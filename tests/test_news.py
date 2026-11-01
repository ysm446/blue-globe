"""ニュース文の組み立ての検証。入力は 2026-11-01 に取得した気象庁の文を使う。

実行: .venv\\Scripts\\python -m unittest discover tests
"""
import unittest
from datetime import datetime

from server import news, sources
from server.llm import LlmError

CURRENT = {
    "temperature_2m": 16.8,
    "weather_code": 0,
    "wind_speed_10m": 1.53,
    "wind_direction_10m": 349,
    "wind_gusts_10m": 4.5,
}
TOKYO = (
    "2日は、前線を伴った低気圧が西日本から東日本を東へ進む見込みです。"
    "このため、曇りで昼過ぎから夕方は雨となるでしょう。伊豆諸島では、雨で雷を伴う所がある見込みです。"
)
NAGANO = (
    "2日は、前線を伴った低気圧が西日本から東日本を東へ進む見込みです。"
    "このため、北部と中部は曇り昼前から昼過ぎ雨、南部は曇り朝から昼過ぎ雨となるでしょう。"
)
WAKAYAMA = "2日の和歌山県は、低気圧や前線の影響で曇り、朝から昼過ぎにかけて雨が降る見込みです。雷を伴う所があるでしょう。"


def must_not_call(_system, _user):
    raise AssertionError("整形で済む文に LLM を使ってはいけない")


class CurrentSentenceTest(unittest.TestCase):
    def test_matches_news_style(self):
        self.assertEqual(
            news.current_sentence(CURRENT),
            "現在の気温は16.8℃で、快晴です。北寄りの風1.5m/s、最大瞬間風速は4.5m/sです。",
        )

    def test_calm_wind(self):
        calm = {**CURRENT, "wind_speed_10m": 0.1}
        self.assertTrue(news.current_sentence(calm).endswith("風はほとんどありません。"))

    def test_headline_clock(self):
        self.assertEqual(news.headline("東京", datetime(2026, 11, 1, 9, 45)), "東京 11月1日 午前9時45分")
        self.assertEqual(news.headline("東京", datetime(2026, 11, 1, 12, 0)), "東京 11月1日 午後0時")
        self.assertEqual(news.headline("東京", datetime(2026, 11, 1, 0, 5)), "東京 11月1日 午前0時5分")


class WeatherIconTest(unittest.TestCase):
    def test_every_weather_code_has_an_icon(self):
        self.assertEqual(set(news.WEATHER), set(news.ICONS))

    def test_unknown_code_falls_back_to_cloudy(self):
        self.assertEqual(news.weather_icon(1234), "cloudy")


class TargetSegmentTest(unittest.TestCase):
    def test_prefers_paragraph_starting_with_the_day(self):
        text = (
            "北海道付近は、低気圧が１日夜から２日にかけて通過する見込みです。\n\n"
            "　１日は、晴れるでしょう。\n\n　２日は、曇りで、所により雨か雪の見込みです。\n\n"
            "沿岸の海域では、波が高いでしょう。"
        )
        self.assertEqual(news.target_segment(text, 2), "2日は、曇りで、所により雨か雪の見込みです。")

    def test_single_paragraph_with_several_days(self):
        text = "薩摩地方は晴れています。１日は、晴れとなるでしょう。２日は、曇りや雨となるでしょう。３日は、晴れるでしょう。"
        self.assertEqual(news.target_segment(text, 2), "2日は、曇りや雨となるでしょう。")

    def test_range_of_days(self):
        text = "大東島地方は晴れています。\n\n　１日から２日は、高気圧に覆われて晴れる見込みです。"
        self.assertEqual(news.target_segment(text, 2), "1日から2日は、高気圧に覆われて晴れる見込みです。")

    def test_does_not_confuse_12th_with_2nd(self):
        self.assertIsNone(news.target_segment("１２日は、晴れるでしょう。", 2))

    def test_today_with_place_name(self):
        text = "　滋賀県は、晴れています。\n\n　１日の滋賀県は、高気圧に覆われて晴れるでしょう。\n\n　２日の滋賀県は、曇るでしょう。"
        self.assertEqual(news.target_segment(text, 1), "1日の滋賀県は、高気圧に覆われて晴れるでしょう。")

    def test_no_mention(self):
        self.assertIsNone(news.target_segment("東京地方は、晴れています。", 2))


class ComposeOutlookTest(unittest.TestCase):
    def test_single_sentence_skips_llm(self):
        outlook = news.compose_outlook("2日は、低気圧や前線の影響により、曇りや雨となる見込みです。", 2, must_not_call)
        self.assertEqual(outlook.method, "rule")
        self.assertEqual(outlook.text, "気象庁によると、2日は低気圧や前線の影響により、曇りや雨となる見込みです。")

    def test_deshou_after_verb(self):
        outlook = news.compose_outlook("2日は、次第に晴れとなるでしょう。", 2, must_not_call)
        self.assertEqual(outlook.text, "気象庁によると、2日は次第に晴れとなる見込みです。")

    def test_deshou_after_noun(self):
        outlook = news.compose_outlook("2日は、曇りでしょう。", 2, must_not_call)
        self.assertEqual(outlook.text, "気象庁によると、2日は曇りの見込みです。")

    def test_konotame_is_merged_by_rule(self):
        outlook = news.compose_outlook(NAGANO, 2, must_not_call)
        self.assertEqual(outlook.method, "rule")
        self.assertEqual(
            outlook.text,
            "気象庁によると、2日は前線を伴った低気圧が西日本から東日本を東へ進むため、"
            "北部と中部は曇り昼前から昼過ぎ雨、南部は曇り朝から昼過ぎ雨となる見込みです。",
        )

    def test_llm_output_accepted(self):
        good = (
            "気象庁によると、2日は前線を伴った低気圧が西日本から東日本を東へ進む見込みで、"
            "曇りで昼過ぎから夕方は雨となり、伊豆諸島では雨で雷を伴う所がある見込みです。"
        )
        outlook = news.compose_outlook(TOKYO, 2, lambda _s, _u: good)
        self.assertEqual((outlook.method, outlook.text), ("llm", good))

    def assert_rejected(self, segment, output, reason):
        outlook = news.compose_outlook(segment, 2, lambda _s, _u: output)
        self.assertEqual(outlook.method, "verbatim")
        self.assertIn(reason, outlook.note)
        self.assertTrue(outlook.text.startswith("気象庁によると、"))

    def test_rejects_dropped_region(self):
        self.assert_rejected(
            TOKYO,
            "気象庁によると、2日は前線を伴った低気圧が西日本から東日本を東へ進むため、曇りで昼過ぎから夕方は雨となり、雷を伴う所がある見込みです。",
            "伊豆諸島",
        )

    def test_rejects_stronger_thunder_claim(self):
        # e4b の実際の出力。「一部で雷」が「雷を伴う雨」に強まっている
        self.assert_rejected(
            WAKAYAMA,
            "気象庁によると、2日の和歌山県は低気圧や前線の影響で曇り、朝から昼過ぎにかけて雷を伴う雨が降る見込みです。",
            "欠落:所",
        )

    def test_rejects_typo_of_hare(self):
        # e4b の実際の出力。「晴れ」が「晴」に崩れている
        self.assert_rejected(
            "2日は、前線の影響で曇りや雨となります。高気圧に覆われて次第に晴れとなるでしょう。",
            "気象庁によると、2日は前線の影響で曇りや雨となりますが、高気圧に覆われて次第に晴となる見込みです。",
            "欠落:晴れ",
        )

    def test_rejects_added_fact(self):
        self.assert_rejected(WAKAYAMA, "気象庁によると、2日は台風の影響で雨が降り、雷を伴う所がある見込みです。", "追加:台風")

    def test_llm_failure_shows_original(self):
        def fail(_system, _user):
            raise LlmError("LLM を起動できません")

        outlook = news.compose_outlook(TOKYO, 2, fail)
        self.assertEqual((outlook.method, outlook.note), ("verbatim", "LLM を起動できません"))

    def test_no_model_shows_original(self):
        outlook = news.compose_outlook(TOKYO, 2, None)
        self.assertEqual(outlook.method, "verbatim")
        self.assertIn("伊豆諸島", outlook.text)


DAILY = {
    "time": ["2026-11-01", "2026-11-02", "2026-11-03"],
    "weather_code": [0, 3, 61],
    "temperature_2m_max": [20.0, 17.6, 15.2],
    "temperature_2m_min": [10.0, 9.4, 8.1],
    "precipitation_probability_max": [0, 40, None],
}


class DaySelectionTest(unittest.TestCase):
    def days(self, hour):
        return [d.day for d in news.target_days(datetime(2026, 11, 1, hour, 0))]

    def test_morning_talks_about_today(self):
        self.assertEqual(news.focus_index(datetime(2026, 11, 1, 6, 30)), 0)
        self.assertEqual(self.days(6), [1, 2])

    def test_just_after_midnight_is_already_today(self):
        self.assertEqual(self.days(0), [1, 2])

    def test_evening_talks_about_tomorrow(self):
        self.assertEqual(news.focus_index(datetime(2026, 11, 1, 18, 0)), 1)
        self.assertEqual(self.days(18), [2])

    def test_month_end(self):
        self.assertEqual([d.day for d in news.target_days(datetime(2026, 11, 30, 7, 0))], [30, 1])


HOURLY = {
    "time": ["2026-11-01T14:00", "2026-11-01T15:00", "2026-11-01T16:00", "2026-11-01T23:00", "2026-11-02T00:00"],
    "temperature_2m": [25.0, 20.0, 18.0, 14.0, 5.0],
    "precipitation_probability": [90, 30, None, 10, 100],
    "weather_code": [95, 3, 1, 2, 75],
}


class DailyFromNowTest(unittest.TestCase):
    def test_ignores_past_hours_and_tomorrow(self):
        daily = news.daily_from_now(DAILY, HOURLY, datetime(2026, 11, 1, 15, 30))
        self.assertEqual(daily["temperature_2m_max"][0], 20.0)  # 14時の25℃は過去
        self.assertEqual(daily["temperature_2m_min"][0], 14.0)  # 翌0時の5℃は明日
        self.assertEqual(daily["precipitation_probability_max"][0], 30)
        self.assertEqual(daily["weather_code"][0], 3)  # 14時の雷は過去

    def test_other_days_are_unchanged(self):
        daily = news.daily_from_now(DAILY, HOURLY, datetime(2026, 11, 1, 15, 30))
        self.assertEqual(daily["temperature_2m_max"][1:], DAILY["temperature_2m_max"][1:])
        self.assertEqual(daily["time"], DAILY["time"])

    def test_no_rain_values(self):
        daily = news.daily_from_now(DAILY, HOURLY, datetime(2026, 11, 1, 16, 0))
        self.assertEqual(daily["precipitation_probability_max"][0], 10)
        only_missing = {**HOURLY, "precipitation_probability": [None] * 5}
        daily = news.daily_from_now(DAILY, only_missing, datetime(2026, 11, 1, 16, 0))
        self.assertIsNone(daily["precipitation_probability_max"][0])


class DaySentenceTest(unittest.TestCase):
    def test_today(self):
        self.assertEqual(
            news.day_sentence(DAILY, 0),
            "今日はこのあと快晴で、最高気温は20℃、最低気温は10℃、降水確率は最大0%の見込みです。",
        )

    def test_tomorrow(self):
        self.assertEqual(
            news.day_sentence(DAILY, 1),
            "明日は曇りで、最高気温は18℃、最低気温は9℃、降水確率は最大40%の見込みです。",
        )

    def test_missing_rain_probability(self):
        self.assertEqual(news.day_sentence(DAILY, 2).count("降水確率"), 0)


class WeeklyRowsTest(unittest.TestCase):
    def test_labels_and_values(self):
        rows = news.weekly_rows(DAILY)
        self.assertEqual([r["label"] for r in rows], ["今日", "明日", "3(火)"])
        self.assertEqual(rows[1]["high"], 18)
        self.assertEqual(rows[1]["low"], 9)
        self.assertEqual(rows[2]["icon"], "rain")
        self.assertIsNone(rows[2]["rain"])


class OfficeTest(unittest.TestCase):
    def office(self, prefecture, latitude, longitude, country="JP"):
        return sources.office_for(
            {"admin1": prefecture, "country_code": country, "latitude": latitude, "longitude": longitude}
        )

    def test_prefecture(self):
        self.assertEqual(self.office("東京都", 35.66, 139.7), "130000")

    def test_hokkaido_regions(self):
        self.assertEqual(self.office("北海道", 43.06, 141.35), "016000")  # 札幌
        self.assertEqual(self.office("北海道", 41.77, 140.73), "017000")  # 函館
        self.assertEqual(self.office("北海道", 42.92, 143.2), "014100")  # 帯広

    def test_okinawa_regions(self):
        self.assertEqual(self.office("沖縄県", 26.21, 127.68), "471000")  # 那覇
        self.assertEqual(self.office("沖縄県", 24.34, 124.19), "474000")  # 石垣

    def test_amami_has_no_overview(self):
        self.assertIsNone(self.office("鹿児島県", 28.38, 129.49))
        self.assertEqual(self.office("鹿児島県", 31.57, 130.55), "460100")

    def test_overseas(self):
        self.assertIsNone(self.office("イル・ド・フランス", 48.85, 2.35, "FR"))


if __name__ == "__main__":
    unittest.main()
