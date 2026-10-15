"""Tests for the council layer renderer's geometry helpers.

Run with: python -m unittest tests/test_council.py
"""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import render_council_layers as rc  # noqa: E402


class CouncilTests(unittest.TestCase):
    def test_rings_become_polygons_with_holes(self):
        outer_a = [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]       # clockwise (y up)
        hole_a = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]            # anticlockwise
        outer_b = [[20, 0], [20, 5], [25, 5], [25, 0], [20, 0]]      # second outer ring
        polys = rc.esri_to_polygons([outer_a, hole_a, outer_b])
        self.assertEqual(len(polys), 2)
        self.assertEqual(len(polys[0]["coordinates"]), 2)  # outer + hole
        self.assertEqual(len(polys[1]["coordinates"]), 1)

    def test_web_mercator_to_lonlat(self):
        lon, lat = rc.to_lonlat(153.0 * math.pi / 180 * rc.R, 0)
        self.assertAlmostEqual(lon, 153.0)
        self.assertAlmostEqual(lat, 0.0)
        # Brisbane latitude round trip
        y = rc.R * math.log(math.tan(math.pi / 4 + math.radians(-27.47) / 2))
        self.assertAlmostEqual(rc.to_lonlat(0, y)[1], -27.47, places=6)


if __name__ == "__main__":
    unittest.main()


import render_dea_mosaic as dm  # noqa: E402


class MosaicTests(unittest.TestCase):
    def test_tile_range_covers_australia(self):
        x0, x1, y0, y1 = dm.tile_range(7)
        self.assertEqual((x0, x1), (103, 118))
        self.assertTrue(y0 < y1)
        w, s = dm.to_lonlat(*dm.tile_bbox(x0, y1, 7)[:2])
        e, n = dm.to_lonlat(*dm.tile_bbox(x1, y0, 7)[2:])
        self.assertTrue(w <= 112 and e >= 154 and s <= -44 and n >= -9)

    def test_fill_detection(self):
        from PIL import Image
        self.assertTrue(dm.is_fill(Image.new("RGBA", (8, 8), (150, 180, 200, 160))))
        self.assertFalse(dm.is_fill(Image.new("RGBA", (8, 8), (0, 0, 0, 0))))
