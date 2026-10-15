"""Tests for the national tide heights (no network).

Run with: python -m unittest tests/test_tides.py
"""
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch_tides as ft  # noqa: E402


class Tides(unittest.TestCase):
    def test_picks_the_whole_country_grids(self):
        files = [("/v1-1/HPT_2019-2023.tif", 9000), ("/v1-1/monthly/HPT_monthly.tif", 99000),
                 ("/v1-1/MHWS_2019-2023.tif", 9000), ("/v1-1/LPT_2019-2023.tif", 9000), ("/v1-1/readme.txt", 10)]
        self.assertEqual(ft.pick(files, "hpt")[0], "/v1-1/HPT_2019-2023.tif")
        self.assertEqual(ft.pick(files, "mhws")[0], "/v1-1/MHWS_2019-2023.tif")
        self.assertIsNone(ft.pick(files, "nothing"))

    def test_keeps_sea_cells_next_to_land(self):
        try:
            import rasterio
        except ImportError:
            self.skipTest("rasterio not installed")
        from rasterio.transform import from_origin
        hat = np.full((6, 6), 1.5, dtype="float32")
        hat[:, :3] = -9999          # land on the west half
        with tempfile.TemporaryDirectory() as d:
            paths = []
            for name, arr in (("h", hat), ("m", np.where(hat > -9999, 1.1, -9999).astype("float32"))):
                p = Path(d, f"{name}.tif")
                with rasterio.open(p, "w", driver="GTiff", width=6, height=6, count=1, dtype="float32",
                                   crs="EPSG:4326", transform=from_origin(150, -20, 0.03125, 0.03125), nodata=-9999) as dst:
                    dst.write(arr, 1)
                paths.append(p)
            pts = ft.coastal_points(*paths)
        self.assertEqual(len(pts), 3, "column 3 is the coast; every other cell kept")
        self.assertTrue(all(p[2] == 1.5 and p[3] == 1.1 for p in pts))
        self.assertTrue(all(abs(p[1] - (150 + 3.5 * 0.03125)) < 1e-3 for p in pts))


if __name__ == "__main__":
    unittest.main()
