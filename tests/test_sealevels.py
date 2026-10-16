"""Tests for recorded sea levels (no network).

Run with: python -m unittest tests/test_sealevels.py
"""
import datetime as dt
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch_sealevels as fs  # noqa: E402

UTC = dt.timezone.utc


def fake(server, ds, sid, t0, t1):
    """A tide of ±1 m around 1.5 m on the gauge's zero, hourly."""
    if ds != "global_hourly_rqds":
        raise OSError("down")
    out, t = [], t0
    while t <= t1:
        h = (t - dt.datetime(2000, 1, 1, tzinfo=UTC)).total_seconds() / 3600
        out.append((t, 1.5 + math.cos(2 * math.pi * h / 12.42)))
        t += dt.timedelta(hours=1)
    return out


class Sea(unittest.TestCase):
    def test_nearest_gauge_within_range(self):
        st, d = fs.nearest(-27.47, 153.03)
        self.assertEqual(st[0], "Brisbane")
        st, d = fs.nearest(-36.12, 144.75)   # Echuca, inland
        self.assertIsNone(st)

    def test_series_is_relative_to_the_years_mean(self):
        ev = {"id": "b", "lat": -27.47, "lon": 153.03, "start": "2022-02-24T00:00:00+10:00", "series": [[0, 1], [100, 2]]}
        sea, why = fs.sea_for(ev, fetch=fake)
        self.assertIsNone(why)
        vals = [v for _, v in sea["series"]]
        self.assertAlmostEqual(max(vals), 1.0, delta=0.05)
        self.assertAlmostEqual(min(vals), -1.0, delta=0.05)
        self.assertEqual(sea["series"][0][0], -1)
        self.assertEqual(sea["station"], "Brisbane")

    def test_main_updates_the_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d, "e.json")
            p.write_text(json.dumps({"events": [{"id": "x", "lat": -36.1, "lon": 144.7, "start": "2022-10-12T00:00:00+10:00", "series": [[0, 1]]}]}))
            fs.main(p)
            self.assertNotIn("sea", json.loads(p.read_text())["events"][0])


if __name__ == "__main__":
    unittest.main()
