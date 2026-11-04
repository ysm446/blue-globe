"""天気の値を画面に出す形に整える処理の検証。

実行: .venv\\Scripts\\python -m unittest discover tests
"""
import unittest
from datetime import datetime, timezone

from server import news

class PastTimeTest(unittest.TestCase):
    def test_local_hour_rounds_to_the_nearest_hour_in_local_time(self):
        at = datetime(2026, 11, 1, 23, 29, tzinfo=timezone.utc)
        self.assertEqual(news.local_hour(at, 9 * 3600), datetime(2026, 11, 2, 8, 0))
        at = datetime(2026, 11, 1, 23, 31, tzinfo=timezone.utc)
        self.assertEqual(news.local_hour(at, 9 * 3600), datetime(2026, 11, 2, 9, 0))
        self.assertEqual(news.local_hour(at, -5 * 3600), datetime(2026, 11, 1, 19, 0))

    def test_past_current_reads_the_row_of_that_hour(self):
        hourly = {"time": ["2026-11-01T08:00", "2026-11-01T09:00"], "temperature_2m": [10.0, 11.0]}
        self.assertEqual(news.past_current(hourly, datetime(2026, 11, 1, 9, 0))["temperature_2m"], 11.0)
        self.assertIsNone(news.past_current(hourly, datetime(2026, 11, 1, 10, 0)))

    def test_from_today_removes_the_past_days(self):
        daily = {"time": ["2026-11-01", "2026-11-02", "2026-11-03"], "weather_code": [1, 2, 3]}
        self.assertEqual(news.from_today(daily, datetime(2026, 11, 2, 9, 0))["weather_code"], [2, 3])
        self.assertEqual(news.from_today(daily, datetime(2026, 12, 1, 9, 0))["weather_code"], [1, 2, 3])


class WeatherIconTest(unittest.TestCase):
    def test_every_weather_code_has_an_icon(self):
        self.assertEqual(set(news.WEATHER), set(news.ICONS))

    def test_unknown_code_falls_back_to_cloudy(self):
        self.assertEqual(news.weather_icon(1234), "cloudy")


DAILY = {
    "time": ["2026-11-01", "2026-11-02", "2026-11-03"],
    "weather_code": [0, 3, 61],
    "temperature_2m_max": [20.0, 17.6, 15.2],
    "temperature_2m_min": [10.0, 9.4, 8.1],
    "precipitation_probability_max": [0, 40, None],
}


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


class WeeklyRowsTest(unittest.TestCase):
    def test_labels_and_values(self):
        rows = news.weekly_rows(DAILY)
        self.assertEqual([r["label"] for r in rows], ["今日", "明日", "3(火)"])
        self.assertEqual(rows[1]["high"], 18)
        self.assertEqual(rows[1]["low"], 9)
        self.assertEqual(rows[2]["icon"], "rain")
        self.assertIsNone(rows[2]["rain"])


if __name__ == "__main__":
    unittest.main()


class ClockDetailsTest(unittest.TestCase):
    NOW = datetime(2026, 11, 2, 6, 15)
    HOURLY = {
        "time": ["2026-11-02T05:00", "2026-11-02T06:00", "2026-11-02T07:00"],
        "precipitation_probability": [10, 30, None],
    }
    DAILY = {
        "time": ["2026-11-02", "2026-11-03", "2026-11-04"],
        "sunrise": ["2026-11-02T06:05", "2026-11-03T06:06", None],
        "sunset": ["2026-11-02T16:48", "2026-11-03T16:47", None],
    }

    def test_rain_now_uses_the_current_hour(self):
        self.assertEqual(news.rain_now(self.HOURLY, self.NOW), 30)

    def test_rain_now_is_none_outside_the_forecast(self):
        self.assertIsNone(news.rain_now(self.HOURLY, datetime(2026, 11, 3, 6, 15)))

    def test_rain_now_keeps_missing_value(self):
        self.assertIsNone(news.rain_now(self.HOURLY, datetime(2026, 11, 2, 7, 0)))

    def test_sun_times_are_todays_clock_times(self):
        self.assertEqual(news.sun_times(self.DAILY, self.NOW), {"sunrise": "06:05", "sunset": "16:48"})

    def test_sun_times_are_none_without_sunrise(self):
        self.assertEqual(news.sun_times(self.DAILY, datetime(2026, 11, 4, 6, 0)), {"sunrise": None, "sunset": None})

    def test_sun_times_are_none_outside_the_forecast(self):
        self.assertEqual(news.sun_times(self.DAILY, datetime(2026, 12, 1, 6, 0)), {"sunrise": None, "sunset": None})
