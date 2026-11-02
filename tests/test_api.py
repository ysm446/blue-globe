"""設定 API の検証。設定ファイルは一時フォルダに置く。"""
import json
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from server import api, config


class SettingsApiTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        for name, value in {"DATA_DIR": root, "SETTINGS_FILE": root / "settings.json"}.items():
            patcher = mock.patch.object(config, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = TestClient(api.app)

    def test_mode_defaults_to_normal(self):
        self.assertEqual(self.client.get("/settings").json()["mode"], "normal")

    def test_mode_is_saved(self):
        self.assertEqual(self.client.put("/settings/mode", json={"mode": "wind"}).status_code, 200)
        self.assertEqual(self.client.get("/settings").json()["mode"], "wind")

    def test_unknown_mode_is_rejected(self):
        self.assertEqual(self.client.put("/settings/mode", json={"mode": "rain"}).status_code, 422)
        self.assertEqual(self.client.get("/settings").json()["mode"], "normal")

    def test_saving_settings_keeps_mode(self):
        self.client.put("/settings/mode", json={"mode": "weather"})
        response = self.client.put("/settings", json={"location": None})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/settings").json()["mode"], "weather")

    GRAPHICS = {
        "fps_limit": 30,
        "render_scale": 75,
        "bloom": False,
        "auto_exposure": False,
        "show_fps": True,
        "show_map_lines": False,
        "show_city_labels": False,
        "star_brightness": 2.0,
        "cloud_shadow": 0.8,
        "region_bloom": 0.3,
        "glint_strength": 2.0,
        "region_detail": False,
        "volume_clouds": False,
    }

    def test_graphics_defaults(self):
        graphics = self.client.get("/settings").json()["graphics"]
        self.assertEqual(graphics["fps_limit"], 0)
        self.assertEqual(graphics["render_scale"], 100)
        self.assertTrue(graphics["bloom"])
        self.assertTrue(graphics["show_map_lines"])
        self.assertEqual(graphics["cloud_shadow"], 0.55)
        self.assertTrue(graphics["region_detail"])
        self.assertEqual(graphics["region_bloom"], 0.5)
        self.assertEqual(graphics["glint_strength"], 1.3)

    def test_graphics_defaults_do_not_change_with_saved_values(self):
        self.client.put("/settings/graphics", json=self.GRAPHICS)
        defaults = self.client.get("/settings/graphics/defaults").json()
        self.assertEqual(defaults, config.DEFAULT_SETTINGS["graphics"])
        self.assertEqual(defaults["cloud_shadow"], 0.55)
        self.assertEqual(set(defaults), set(self.GRAPHICS))

    def test_graphics_are_saved(self):
        self.assertEqual(self.client.put("/settings/graphics", json=self.GRAPHICS).status_code, 200)
        self.assertEqual(self.client.get("/settings").json()["graphics"], self.GRAPHICS)

    def test_invalid_graphics_are_rejected(self):
        for change in (
            {"fps_limit": 45},
            {"render_scale": 10},
            {"star_brightness": 100},
            {"star_brightness": 0},
            {"cloud_shadow": 1.5},
            {"cloud_shadow": -0.1},
            {"region_bloom": 1.5},
            {"region_bloom": -0.1},
            {"glint_strength": 3.5},
            {"glint_strength": -0.1},
        ):
            response = self.client.put("/settings/graphics", json={**self.GRAPHICS, **change})
            self.assertEqual(response.status_code, 422)
        self.assertEqual(self.client.get("/settings").json()["graphics"]["fps_limit"], 0)

    def test_old_settings_file_gets_new_graphics_defaults(self):
        old = {"fps_limit": 60, "render_scale": 100, "bloom": True, "auto_exposure": True, "show_fps": False}
        config.save_settings({"location": None, "graphics": old})
        graphics = self.client.get("/settings").json()["graphics"]
        self.assertEqual(graphics["fps_limit"], 60)
        self.assertEqual(graphics["star_brightness"], 1.0)
        self.assertTrue(graphics["show_map_lines"])
        self.assertTrue(graphics["show_city_labels"])
        self.assertEqual(graphics["cloud_shadow"], 0.55)
        self.assertTrue(graphics["region_detail"])
        self.assertTrue(graphics["volume_clouds"])
        self.assertEqual(graphics["region_bloom"], 0.5)
        self.assertEqual(graphics["glint_strength"], 1.3)

    def test_panels_default_to_open(self):
        self.assertEqual(self.client.get("/settings").json()["panels"], {"news": True, "hourly": True, "weekly": True, "details": True})

    def test_panels_are_saved(self):
        panels = {"news": True, "hourly": False, "weekly": False, "details": False}
        self.assertEqual(self.client.put("/settings/panels", json=panels).status_code, 200)
        self.assertEqual(self.client.get("/settings").json()["panels"], panels)

    def test_invalid_panels_are_rejected(self):
        self.assertEqual(self.client.put("/settings/panels", json={"news": True}).status_code, 422)

    def test_old_settings_file_gets_new_panels_defaults(self):
        config.save_settings({"location": None, "panels": {"weekly": False}})
        self.assertEqual(self.client.get("/settings").json()["panels"], {"news": True, "hourly": True, "weekly": False, "details": True})

    def test_other_settings_keep_graphics(self):
        self.client.put("/settings/graphics", json=self.GRAPHICS)
        self.client.put("/settings/mode", json={"mode": "wind"})
        self.client.put("/settings", json={"location": None})
        self.assertEqual(self.client.get("/settings").json()["graphics"], self.GRAPHICS)

    def test_concurrent_updates_keep_the_file_valid(self):
        # 設定を素早く続けて変えると、保存が同時に走る
        config.save_settings({**config.DEFAULT_SETTINGS, "location": {"name": "渋谷区"}})
        barrier = threading.Barrier(8)

        def worker(index):
            barrier.wait()
            for round_number in range(40):
                config.update_settings({f"key{index}": round_number})

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        saved = json.loads(config.SETTINGS_FILE.read_text(encoding="utf-8"))
        self.assertEqual(saved["location"], {"name": "渋谷区"})
        for index in range(8):
            self.assertEqual(saved[f"key{index}"], 39)  # どの変更も失われていない

    def test_old_settings_file_with_model_still_works(self):
        config.save_settings({**config.DEFAULT_SETTINGS, "models_dir": "D:\\no-such-folder", "model": "x.gguf"})
        self.assertEqual(self.client.put("/settings/mode", json={"mode": "wind"}).status_code, 200)
        self.assertEqual(self.client.put("/settings", json={"location": None}).status_code, 200)
        self.assertEqual(self.client.get("/settings").json()["mode"], "wind")

    def test_several_sentences_show_the_original_outlook(self):
        location = {"name": "東京", "admin1": "東京都", "country_code": "JP", "latitude": 35.7, "longitude": 139.7}
        text = "2日は、晴れの見込みです。夜は雨が降るでしょう。"
        overview = {"text": text, "reportDatetime": "2026-11-02T05:00:00+09:00"}
        with mock.patch.object(api.sources, "fetch_overview", return_value=overview):
            outlook, note = api._outlook(location, datetime(2026, 11, 2, 9, 0))
        self.assertIsNone(note)
        self.assertEqual(outlook["method"], "verbatim")
        self.assertEqual(outlook["original"], text)
        self.assertNotIn("model", outlook)


if __name__ == "__main__":
    unittest.main()


class PlaceNewsTest(unittest.TestCase):
    FORECAST = {
        "utc_offset_seconds": 14400,
        "current": {
            "time": "2026-11-02T20:15",
            "temperature_2m": 28.4,
            "apparent_temperature": 30.1,
            "relative_humidity_2m": 60,
            "precipitation": 0,
            "weather_code": 0,
            "is_day": 0,
            "wind_speed_10m": 3.2,
            "wind_direction_10m": 90,
            "wind_gusts_10m": 6.0,
        },
        "hourly": {
            "time": [f"2026-11-{2 + h // 24:02d}T{h % 24:02d}:00" for h in range(72)],
            "temperature_2m": [25.0] * 72,
            "precipitation_probability": [10] * 72,
            "weather_code": [0] * 72,
            "is_day": [1] * 72,
        },
        "daily": {
            "time": [f"2026-11-{d:02d}" for d in range(2, 9)],
            "weather_code": [0] * 7,
            "temperature_2m_max": [30.0] * 7,
            "temperature_2m_min": [22.0] * 7,
            "precipitation_probability_max": [10] * 7,
            "sunrise": ["2026-11-02T06:20"] * 7,
            "sunset": ["2026-11-02T17:40"] * 7,
        },
    }

    def setUp(self):
        self.client = TestClient(api.app)

    def test_returns_the_weather_of_the_city_without_changing_settings(self):
        before = self.client.get("/settings").json()
        with mock.patch.object(api.sources, "fetch_forecast", return_value=self.FORECAST) as fetch:
            response = self.client.get("/news/place", params={"name": "ドバイ", "latitude": 25.2, "longitude": 55.3})
        self.assertEqual(response.status_code, 200)
        fetch.assert_called_once_with(25.2, 55.3)
        report = response.json()
        self.assertEqual(report["location"]["name"], "ドバイ")
        self.assertEqual(report["utc_offset_seconds"], 14400)
        self.assertEqual(report["current"]["sunrise"], "06:20")
        self.assertIsNone(report["outlook"])
        self.assertEqual(self.client.get("/settings").json(), before)

    PAST_HOURLY = {
        **FORECAST["hourly"],
        "apparent_temperature": [20.0] * 72,
        "relative_humidity_2m": [55] * 72,
        "wind_speed_10m": [4.0] * 72,
        "wind_direction_10m": [180] * 72,
        "wind_gusts_10m": [9.0] * 72,
    }

    def past_forecast(self):
        # 前日の 2026-11-02 から始まる。現地時刻は 11-03 20:15
        hourly = dict(self.PAST_HOURLY)
        hourly["temperature_2m"] = [float(i) for i in range(72)]
        daily = {key: list(values) for key, values in self.FORECAST["daily"].items()}
        return {
            **self.FORECAST,
            "current": {**self.FORECAST["current"], "time": "2026-11-03T20:15"},
            "hourly": hourly,
            "daily": {**daily, "time": [f"2026-11-{d:02d}" for d in range(2, 9)]},
        }

    def get_past(self, at, forecast=None):
        with mock.patch.object(api.sources, "fetch_forecast", return_value=forecast or self.past_forecast()) as fetch, mock.patch.object(
            api, "_past_time", side_effect=lambda value: value
        ):
            response = self.client.get(
                "/news/place", params={"name": "ドバイ", "latitude": 25.2, "longitude": 55.3, "at": at}
            )
        return response, fetch

    def test_past_time_shows_the_values_of_that_hour(self):
        # 2026-11-03T02:10Z は現地 (UTC+4) の 06:10 で、一番近い 1 時間は 06:00
        response, fetch = self.get_past("2026-11-03T02:10:00Z")
        self.assertEqual(response.status_code, 200)
        fetch.assert_called_once_with(25.2, 55.3, past=True)
        report = response.json()
        self.assertEqual(report["current"]["temperature"], 30.0)  # 11-02 00:00 から 30 時間目
        self.assertEqual(report["current"]["humidity"], 55)
        self.assertEqual(report["hourly"][0]["time"], "9時")
        self.assertIn("11月3日 午前6時", report["headline"])
        self.assertTrue(report["current_text"].startswith("6時の気温は30.0℃で"))
        self.assertTrue(report["current_text"].endswith("でした。"))
        self.assertEqual(report["day_text"], "")
        self.assertIsNone(report["outlook"])
        self.assertIn("過去の時刻", report["note"])
        self.assertIsNotNone(report["at"])

    def test_past_time_keeps_todays_weekly_forecast(self):
        report = self.get_past("2026-11-03T02:10:00Z")[0].json()
        self.assertEqual(report["weekly"][0]["label"], "今日")

    def test_past_time_outside_the_forecast_is_an_error(self):
        self.assertEqual(self.get_past("2026-10-01T02:10:00Z")[0].status_code, 502)

    def test_future_and_too_old_times_are_rejected(self):
        now = datetime.now(timezone.utc)
        for at in (now + timedelta(hours=2), now - timedelta(hours=30)):
            response = self.client.get("/news/place", params={"name": "x", "latitude": 0, "longitude": 0, "at": at.isoformat()})
            self.assertEqual(response.status_code, 400)

    def test_time_without_timezone_is_rejected(self):
        response = self.client.get("/news/place", params={"name": "x", "latitude": 0, "longitude": 0, "at": "2026-11-03T02:10:00"})
        self.assertEqual(response.status_code, 400)

    def test_invalid_coordinates_are_rejected(self):
        response = self.client.get("/news/place", params={"name": "x", "latitude": 95, "longitude": 0})
        self.assertEqual(response.status_code, 422)

    def test_failed_fetch_returns_an_error(self):
        with mock.patch.object(api.sources, "fetch_forecast", side_effect=ValueError("bad")):
            response = self.client.get("/news/place", params={"name": "x", "latitude": 0, "longitude": 0})
        self.assertEqual(response.status_code, 502)
