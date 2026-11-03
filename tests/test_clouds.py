"""雲マップ作成の検証。通信はしない。"""
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import httpx
import numpy as np

from server import clouds


def sample(array, lon, lat):
    height, width = array.shape
    return array[int((90 - lat) * height / 180), int((lon + 180) * width / 360)]


class ReprojectTest(unittest.TestCase):
    def setUp(self):
        # GMGSI と同じ、列が 180 度付近から始まり、行が北から南へ並ぶ格子
        self.lon = np.concatenate([[179.95], np.arange(-179.5, 180, 1.0)])
        self.lat = np.linspace(72, -72, 145)

    def test_positions_are_preserved(self):
        lon2d, lat2d = np.meshgrid(self.lon, self.lat)
        result = clouds.reproject(lon2d.astype(np.float32), self.lat, self.lon, 720, 360)
        self.assertAlmostEqual(float(sample(result, 139.7, 35)), 139.75, delta=0.3)
        self.assertAlmostEqual(float(sample(result, -74.0, 40)), -73.75, delta=0.3)
        result = clouds.reproject(lat2d.astype(np.float32), self.lat, self.lon, 720, 360)
        self.assertAlmostEqual(float(sample(result, 10, 35)), 34.75, delta=0.3)
        self.assertAlmostEqual(float(sample(result, 10, -40)), -40.25, delta=0.3)

    def test_outside_latitude_range_is_missing(self):
        data = np.ones((145, len(self.lon)), dtype=np.float32)
        result = clouds.reproject(data, self.lat, self.lon, 720, 360)
        self.assertTrue(np.isnan(sample(result, 0, 80)))
        self.assertFalse(np.isnan(sample(result, 0, 70)))


class GfsTargetTest(unittest.TestCase):
    def test_longitude_zero_start_is_rolled(self):
        # 経度 0 度始まりの格子で、東経 140 度の列だけ雲がある
        gfs = np.zeros((181, 360), dtype=np.float32)
        gfs[:, 140] = 1
        result = clouds.gfs_to_target(gfs, 720, 360)
        self.assertGreater(float(sample(result, 140, 0)), 0.5)
        self.assertLess(float(sample(result, -40, 0)), 0.01)  # 反対側に出ない

    def test_north_stays_north(self):
        gfs = np.zeros((181, 360), dtype=np.float32)
        gfs[:40] = 1  # 北緯 50 度より北
        result = clouds.gfs_to_target(gfs, 720, 360)
        self.assertGreater(float(sample(result, 0, 70)), 0.9)
        self.assertLess(float(sample(result, 0, -70)), 0.01)


class ReadGmgsiTest(unittest.TestCase):
    def test_bad_quality_pixels_are_missing(self):
        # 品質フラグが 0 以外の画素は、値が 255 (最も冷たい) で埋まっていても使わない
        import h5py

        lon = np.concatenate([[179.95], np.arange(-179.5, 180, 1.0)])
        lat = np.linspace(72, -72, 145)
        data = np.full((1, lat.size, lon.size), 100, dtype=np.float32)
        quality = np.zeros((1, lat.size, lon.size), dtype=np.int8)
        rows = (lat > 40) & (lat < 60)
        cols = (lon > -10) & (lon < 20)
        data[0][np.ix_(rows, cols)] = 255
        quality[0][np.ix_(rows, cols)] = 20
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "gmgsi.nc"
            with h5py.File(path, "w") as f:
                f.create_dataset("data", data=data).attrs["_FillValue"] = np.float32(-9999)
                f.create_dataset("dqf", data=quality)
                f.create_dataset("lat", data=np.repeat(lat[:, None], lon.size, axis=1))
                f.create_dataset("lon", data=np.repeat(lon[None, :], lat.size, axis=0))
            ir = clouds.read_gmgsi(path)
        self.assertTrue(np.isnan(sample(ir, 5, 50)))
        self.assertAlmostEqual(float(sample(ir, 60, 50)), 100, places=3)


class FillFromPreviousHourTest(unittest.TestCase):
    KEY = "GMGSI_LW/2026/11/03/12/GLOBCOMPLIR_v3r0_blend_s202611031200000_e202611031209599_c202611031233468.nc"
    PREVIOUS = "GMGSI_LW/2026/11/03/11/GLOBCOMPLIR_v3r0_blend_s202611031100000_e202611031109599_c202611031133468.nc"

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.folder = Path(tmp.name)
        self.ir = np.full((360, 720), 100, dtype=np.float32)

    def fill(self, previous_ir):
        response = mock.Mock(content=b"nc", raise_for_status=mock.Mock())
        with mock.patch.object(clouds, "nearest_key", return_value=self.PREVIOUS) as nearest, mock.patch.object(
            clouds.httpx, "get", return_value=response
        ) as get, mock.patch.object(clouds, "read_gmgsi", return_value=previous_ir):
            result = clouds.fill_from_previous_hour(self.ir, self.KEY, self.folder)
        return result, nearest, get

    def test_large_missing_area_is_filled_from_previous_hour(self):
        self.ir[100:160, 340:400] = np.nan
        result, nearest, get = self.fill(np.full((360, 720), 150, dtype=np.float32))
        self.assertEqual(nearest.call_args.args[0], datetime(2026, 11, 3, 11, tzinfo=timezone.utc))
        self.assertIn(self.PREVIOUS, get.call_args.args[0])
        self.assertEqual(float(sample(result, 5, 30)), 150)  # 欠けていた場所だけ 1 時間前の値
        self.assertEqual(float(sample(result, 60, 30)), 100)
        self.assertFalse((self.folder / "gmgsi-previous.nc").exists())

    def test_small_missing_area_is_left_to_gfs(self):
        self.ir[170, 360] = np.nan
        result, _, get = self.fill(np.full((360, 720), 150, dtype=np.float32))
        get.assert_not_called()
        self.assertTrue(np.isnan(result[170, 360]))

    def test_download_failure_keeps_missing_area(self):
        self.ir[100:160, 340:400] = np.nan
        with mock.patch.object(clouds, "nearest_key", return_value=self.PREVIOUS), mock.patch.object(
            clouds.httpx, "get", side_effect=httpx.ConnectError("down")
        ):
            result = clouds.fill_from_previous_hour(self.ir, self.KEY, self.folder)
        self.assertTrue(np.isnan(sample(result, 5, 30)))


class ComposeTest(unittest.TestCase):
    def build(self, ir_value, gfs_value):
        ir = np.full((360, 720), ir_value, dtype=np.float32)
        gfs = np.full((181, 360), gfs_value, dtype=np.float32)
        return clouds.compose(ir, gfs)

    def test_thick_cloud_confirmed_by_gfs(self):
        self.assertGreater(float(sample(self.build(205, 1.0), 0, 20)), 0.9)

    def test_warm_clear_sea_stays_clear(self):
        self.assertEqual(float(sample(self.build(76, 0.0), 0, 20)), 0.0)

    def test_cold_ground_is_rejected_when_gfs_says_clear(self):
        # シベリアのように赤外では雲に見えるが GFS は晴れ
        ir = np.full((360, 720), 76, dtype=np.float32)
        ir[:, 340:380] = 178  # 経度 -10〜10 度だけ冷たい
        gfs = np.zeros((181, 360), dtype=np.float32)
        self.assertEqual(float(sample(clouds.compose(ir, gfs), 0, 20)), 0.0)

    def test_gfs_alone_does_not_make_cloud(self):
        # 薄い雲を別のデータから足すと、濃い雲と形がつながらない
        self.assertEqual(float(sample(self.build(70, 1.0), 0, 20)), 0.0)

    def test_density_is_continuous_from_thin_to_thick(self):
        # 同じ緯度帯に晴れた場所を作り、基準を実データと同じ方法で求める
        ir = np.full((360, 720), 73, dtype=np.float32)
        gfs = np.zeros((181, 360), dtype=np.float32)
        steps = list(range(84, 216, 4))
        for i, value in enumerate(steps):
            ir[:, 300 + i * 2 : 302 + i * 2] = value
        # GFS の格子は経度 0 度始まり。経度 -40〜10 度 (ir の列 280〜380) に雲がある
        gfs[:, 320:] = 1
        gfs[:, :10] = 1
        density = clouds.compose(ir, gfs)[175]
        values = [float(density[300 + i * 2]) for i in range(len(steps))]
        self.assertGreater(values[0], 0.0)
        self.assertLess(values[0], 0.05)
        self.assertGreater(values[-1], 0.95)
        self.assertTrue(all(b > a for a, b in zip(values, values[1:])))
        self.assertLess(max(b - a for a, b in zip(values, values[1:])), 0.05)  # 途中で急に飛ばない

    def test_background_depends_on_latitude(self):
        # 同じ値でも、晴れた場所が暖かい緯度では雲、冷たい緯度では晴れになる
        ir = np.full((360, 720), 73, dtype=np.float32)
        lats = clouds.target_latitudes(360)
        ir[lats < -50] = 136
        gfs = np.zeros((181, 360), dtype=np.float32)
        # GFS の格子は経度 0 度始まり。経度 -60〜20 度に雲がある
        gfs[:, 300:] = 1
        gfs[:, :20] = 1
        ir[:, 240:400] = 136
        density = clouds.compose(ir, gfs)
        self.assertGreater(float(sample(density, -40, 10)), 0.2)
        self.assertEqual(float(sample(density, -40, -60)), 0.0)

    def test_background_falls_back_without_clear_area(self):
        ir = np.full((360, 720), 120, dtype=np.float32)
        gfs = np.ones((181, 360), dtype=np.float32)
        background = clouds.clear_background(ir, clouds.gfs_to_target(gfs, 720, 360))
        self.assertAlmostEqual(float(background[180]), 72.0, delta=1)

    def test_poles_use_gfs(self):
        ir = np.full((360, 720), np.nan, dtype=np.float32)
        gfs = np.ones((181, 360), dtype=np.float32)
        result = clouds.compose(ir, gfs)
        self.assertAlmostEqual(float(sample(result, 0, 85)), clouds.POLE_COVER, places=3)

    def test_missing_satellite_data_uses_gfs(self):
        # 衛星のデータが欠けた範囲は晴れにせず、GFS の雲量で埋める
        ir = np.full((360, 720), 76, dtype=np.float32)
        ir[100:160, 340:380] = np.nan
        gfs = np.full((181, 360), 0.8, dtype=np.float32)
        result = clouds.compose(ir, gfs)
        self.assertAlmostEqual(float(sample(result, 0, 30)), 0.8 * clouds.POLE_COVER, places=3)
        self.assertEqual(float(sample(result, 60, 30)), 0.0)  # 欠けていない晴れの場所は晴れのまま

    def test_without_gfs_uses_infrared_only(self):
        ir = np.full((360, 720), 215, dtype=np.float32)
        self.assertAlmostEqual(float(sample(clouds.compose(ir, None), 0, 20)), 1.0, places=3)


class FileNamesTest(unittest.TestCase):
    KEY = "GMGSI_LW/2026/11/01/08/GLOBCOMPLIR_v3r0_blend_s202611010800000_e202611010809599_c202611010834432.nc"

    def test_valid_time(self):
        self.assertEqual(clouds.valid_time_of(self.KEY), "2026-11-01T08:00:00+00:00")

    def test_keys_of_listing(self):
        listing = f"<Contents><Key>{self.KEY}</Key></Contents><Contents><Key>x/readme.txt</Key></Contents>"
        self.assertEqual(clouds._keys_of(listing), [self.KEY])

    def test_latest_key_falls_back_to_previous_day(self):
        empty = mock.Mock(text="<ListBucketResult/>", raise_for_status=mock.Mock())
        found = mock.Mock(text=f"<Key>{self.KEY}</Key>", raise_for_status=mock.Mock())
        with mock.patch.object(clouds.httpx, "get", side_effect=[empty, found]) as get:
            key = clouds.latest_key(datetime(2026, 11, 2, 0, 5, tzinfo=timezone.utc))
        self.assertEqual(key, self.KEY)
        self.assertIn("GMGSI_LW/2026/11/01/", get.call_args.kwargs["params"]["prefix"])


class UpdateTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        patcher = mock.patch.object(clouds, "DATA_DIR", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.cache = self.root / "cloud-cache"
        self.cache.mkdir()

    def write_previous(self, version=clouds.MAP_VERSION):
        meta = {"version": version, "key": "old.nc", "nx": 4, "ny": 2, "valid_time": "2026-11-01T07:00:00+00:00"}
        (self.cache / "current-sat.json").write_text(json.dumps(meta), encoding="utf-8")
        (self.cache / "current-sat.bin").write_bytes(bytes(8))

    def test_nearest_key_picks_the_closest_time_across_days(self):
        keys = {
            "2026/11/01": ["GMGSI_LW/x_s202611012300000.nc", "GMGSI_LW/x_s202611012200000.nc"],
            "2026/11/02": ["GMGSI_LW/x_s202611020000000.nc", "GMGSI_LW/x_s202611020100000.nc"],
        }
        with mock.patch.object(clouds, "_list_keys", side_effect=lambda day: keys.get(f"{day:%Y/%m/%d}", [])):
            near_midnight = datetime(2026, 11, 1, 23, 50, tzinfo=timezone.utc)
            self.assertEqual(clouds.nearest_key(near_midnight), "GMGSI_LW/x_s202611020000000.nc")
            morning = datetime(2026, 11, 2, 0, 40, tzinfo=timezone.utc)
            self.assertEqual(clouds.nearest_key(morning), "GMGSI_LW/x_s202611020100000.nc")

    def test_nearest_key_without_files_is_an_error(self):
        with mock.patch.object(clouds, "_list_keys", return_value=[]):
            with self.assertRaises(clouds.CloudError):
                clouds.nearest_key(datetime(2026, 11, 2, tzinfo=timezone.utc))

    def write_past(self, version=clouds.MAP_VERSION):
        past = self.cache / "past"
        past.mkdir()
        meta = {"version": version, "key": "k.nc", "nx": 4, "ny": 2, "valid_time": "2026-11-02T00:00:00+00:00", "file": "sat-2026110200.bin"}
        (past / "sat-2026110200.json").write_text(json.dumps(meta), encoding="utf-8")
        (past / "sat-2026110200.bin").write_bytes(bytes(8))

    def test_past_map_is_not_downloaded_again(self):
        self.write_past()
        with mock.patch.object(clouds.httpx, "get") as get:
            meta = clouds.past_satellite_map(datetime(2026, 11, 1, 23, 40, tzinfo=timezone.utc))
        get.assert_not_called()
        self.assertEqual(meta["file"], "sat-2026110200.bin")

    def test_past_map_of_an_old_version_is_rebuilt(self):
        self.write_past(version=clouds.MAP_VERSION - 1)
        with mock.patch.object(clouds.httpx, "get", side_effect=httpx.ConnectError("down")) as get:
            with self.assertRaises(clouds.CloudError):
                clouds.past_satellite_map(datetime(2026, 11, 2, 0, 10, tzinfo=timezone.utc))
        get.assert_called()

    def test_failure_with_previous_map_returns_stale(self):
        self.write_previous()
        with mock.patch.object(clouds.httpx, "get", side_effect=httpx.ConnectError("down")):
            result = clouds.update_satellite_map()
        self.assertTrue(result["stale"])
        self.assertEqual(result["key"], "old.nc")

    def test_failure_without_previous_map_raises(self):
        with mock.patch.object(clouds.httpx, "get", side_effect=httpx.ConnectError("down")):
            with self.assertRaises(clouds.CloudError):
                clouds.update_satellite_map()

    def test_same_key_is_not_downloaded_again(self):
        self.write_previous()
        with mock.patch.object(clouds, "latest_key", return_value="old.nc"), mock.patch.object(
            clouds.httpx, "get"
        ) as get:
            result = clouds.update_satellite_map()
        get.assert_not_called()
        self.assertFalse(result["stale"])

    def test_old_map_version_is_rebuilt_even_for_same_key(self):
        self.write_previous(version=clouds.MAP_VERSION - 1)
        with mock.patch.object(clouds, "latest_key", return_value="old.nc"), mock.patch.object(
            clouds.httpx, "get", side_effect=httpx.ConnectError("down")
        ) as get:
            result = clouds.update_satellite_map()
        get.assert_called_once()  # 作り直そうとする
        self.assertTrue(result["stale"])  # 失敗したら古い地図で続ける


if __name__ == "__main__":
    unittest.main()
