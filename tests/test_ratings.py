"""Tests for the level-to-flow ratings (no network).

Run with: python -m unittest tests/test_ratings.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch_ratings as fr  # noqa: E402

APP = Path(__file__).resolve().parent.parent / "viewer" / "app.js"


class Ratings(unittest.TestCase):
    def test_fit_recovers_a_power_law(self):
        pairs = [(1.2 + 0.05 * i, 30 * (0.05 * i + 0.7) ** 1.8) for i in range(100)]
        r = fr.fit(pairs)
        self.assertIsNotNone(r)
        self.assertAlmostEqual(r["b"], 1.8, delta=0.15)
        self.assertAlmostEqual(r["h0"], 0.5, delta=0.15)
        self.assertGreater(r["r2"], 0.99)

    def test_fit_rejects_too_little_or_flat_data(self):
        self.assertIsNone(fr.fit([(1.0, 5.0)] * 10))
        self.assertIsNone(fr.fit([(1.0 + i * 0.001, 5.0 + i) for i in range(100)]))

    def test_main_fits_gauges_near_presets(self):
        def fake(params):
            if params["request"] == "getTimeseriesList":
                return [["ts_id", "ts_name"], ["Q" if "Discharge" in params["parametertype_name"] else "H", "DMQaQc.Merged.DailyMean.24HR"]]
            vals = [[f"2020-01-{d:02d}T00:00:00+10:00", 1.0 + d * 0.1] for d in range(1, 29)] * 1
            days = [[f"2020-{m:02d}-{d:02d}T00:00:00+10:00", 1.0 + (m * 28 + d) * 0.01] for m in range(1, 13) for d in range(1, 29)]
            if params["ts_id"] == "Q":
                days = [[t, 20 * (v - 0.5) ** 2] for t, v in days]
            return [{"data": days or vals}]
        gauges = {"features": [
            {"geometry": {"coordinates": [153.2765, -28.809]}, "properties": {"station": "203004", "name": "Lismore", "kind": "forecast"}},
            {"geometry": {"coordinates": [140.0, -20.0]}, "properties": {"station": "999", "name": "Far away", "kind": "forecast"}}]}
        with tempfile.TemporaryDirectory() as d, mock.patch.object(fr, "kiwis", fake):
            g = Path(d, "g.json"); g.write_text(json.dumps(gauges))
            out = Path(d, "r.json")
            fr.main(APP, g, out)
            res = json.loads(out.read_text())["ratings"]
        self.assertEqual(list(res), ["203004"])
        self.assertAlmostEqual(res["203004"]["b"], 2.0, delta=0.2)


if __name__ == "__main__":
    unittest.main()
