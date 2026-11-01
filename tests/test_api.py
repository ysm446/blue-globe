"""設定 API の検証。設定ファイルは一時フォルダに置く。"""
import tempfile
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

    def test_mode_can_change_when_selected_model_is_gone(self):
        config.save_settings({**config.DEFAULT_SETTINGS, "models_dir": "D:\\no-such-folder", "model": "x.gguf"})
        self.assertEqual(self.client.put("/settings/mode", json={"mode": "wind"}).status_code, 200)
        self.assertEqual(self.client.get("/settings").json()["model"], "x.gguf")


if __name__ == "__main__":
    unittest.main()
