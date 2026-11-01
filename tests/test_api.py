"""設定 API の検証。設定ファイルは一時フォルダに置く。"""
import json
import tempfile
import threading
import unittest
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
        response = self.client.put("/settings", json={"models_dir": "D:\\models", "model": None})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/settings").json()["mode"], "weather")

    GRAPHICS = {
        "fps_limit": 30,
        "render_scale": 75,
        "bloom": False,
        "auto_exposure": False,
        "show_fps": True,
        "show_map_lines": False,
        "star_brightness": 2.0,
        "cloud_shadow": 0.8,
        "region_bloom": 0.3,
        "region_detail": False,
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
        self.assertEqual(graphics["cloud_shadow"], 0.55)
        self.assertTrue(graphics["region_detail"])
        self.assertEqual(graphics["region_bloom"], 0.5)

    def test_other_settings_keep_graphics(self):
        self.client.put("/settings/graphics", json=self.GRAPHICS)
        self.client.put("/settings/mode", json={"mode": "wind"})
        self.client.put("/settings", json={"models_dir": "D:\\models", "model": None})
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

    def test_mode_can_change_when_selected_model_is_gone(self):
        config.save_settings({**config.DEFAULT_SETTINGS, "models_dir": "D:\\no-such-folder", "model": "x.gguf"})
        self.assertEqual(self.client.put("/settings/mode", json={"mode": "wind"}).status_code, 200)
        self.assertEqual(self.client.get("/settings").json()["model"], "x.gguf")


if __name__ == "__main__":
    unittest.main()
