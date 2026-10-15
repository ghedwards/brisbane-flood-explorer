"""Tests for the OpenStreetMap copies of the presets (no network).

Run with: python -m unittest tests/test_osm.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch_osm as fo  # noqa: E402

APP = Path(__file__).resolve().parent.parent / "viewer" / "app.js"
OSM = {"elements": [
    {"type": "marker", "tags": {"name": "buildings"}},
    {"type": "way", "id": 1, "center": {"lat": -27.1, "lon": 153.1}},
    {"type": "way", "id": 2, "center": {"lat": -27.2, "lon": 153.2}},
    {"type": "way", "id": 2, "center": {"lat": -27.2, "lon": 153.2}},
    {"type": "marker", "tags": {"name": "homes"}}, {"type": "way", "id": 1},
    {"type": "marker", "tags": {"name": "work"}}, {"type": "way", "id": 2},
    {"type": "marker", "tags": {"name": "roads"}},
    {"type": "way", "id": 9, "tags": {"name": "A St", "highway": "residential"}, "nodes": [5, 6, 7],
     "geometry": [{"lat": -27, "lon": 153}, {"lat": -27.01, "lon": 153}, {"lat": -27.02, "lon": 153}]},
    {"type": "way", "id": 10, "tags": {"highway": "primary", "ref": "M1"}, "nodes": [7, 8],
     "geometry": [{"lat": -27.02, "lon": 153}, {"lat": -27.03, "lon": 153}]},
    {"type": "marker", "tags": {"name": "sites"}},
    {"type": "node", "id": 3, "lat": -27.05, "lon": 153.05, "tags": {"amenity": "school", "name": "X School"}},
]}


class Osm(unittest.TestCase):
    def test_reads_the_presets_from_the_app(self):
        ps = fo.presets(APP)
        self.assertGreater(len(ps), 40)
        self.assertIn("lismore", [p["id"] for p in ps])

    def test_compact_keeps_buildings_flags_shared_road_nodes_and_sites(self):
        d = fo.compact(OSM, "x", [0, 0, 1, 1])
        self.assertEqual(len(d["f"]), 2)
        self.assertEqual(d["f"], [1, 2])
        self.assertEqual(len(d["nodes"]) // 2, 4, "the node shared by both roads is stored once")
        self.assertEqual(d["roads"][1], ["M1", "primary", [2, 3]])
        self.assertEqual(d["sites"][0][:2], ["X School", "School"])

    def test_refreshes_missing_first_and_survives_a_dead_service(self):
        def boom(q, timeout=300):
            raise RuntimeError("down")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(fo, "overpass", boom), mock.patch.object(fo.time, "sleep", lambda s: None):
            Path(d, "lismore.json").write_text(json.dumps(dict(fo.compact(OSM, "lismore", [0, 0, 1, 1]))))
            fo.main(APP, d, max_n=3)
            idx = json.loads(Path(d, "index.json").read_text())
        self.assertEqual([i["id"] for i in idx], ["lismore"])


if __name__ == "__main__":
    unittest.main()
