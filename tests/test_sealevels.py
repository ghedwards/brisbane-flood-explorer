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
        sea, why = fs.sea_for(ev, fetch=fake, msq=lambda site, year: [])
        self.assertIsNone(why)
        vals = [v for _, v in sea["series"]]
        self.assertAlmostEqual(max(vals), 1.0, delta=0.05)
        self.assertAlmostEqual(min(vals), -1.0, delta=0.05)
        self.assertEqual(sea["series"][0][0], -1)
        self.assertEqual(sea["station"], "Brisbane")

    def test_reads_msq_files_in_either_date_layout(self):
        text = "Date,Time,Level\n12/01/2011 10:00,2.35\n12/01/2011 10:10,2.41,ok\n2011-01-12 10:20 2.50\nheader junk\n"
        rows = fs.parse_levels(text)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0][0], dt.datetime(2011, 1, 12, 0, 0, tzinfo=UTC), "AEST to UTC")
        self.assertEqual([v for _, v in rows], [2.35, 2.41, 2.5])

    def test_a_nearer_queensland_gauge_comes_first(self):
        def msq(site, year):
            self.assertEqual(site, "Mackay")
            t, out = dt.datetime(year, 1, 1, tzinfo=UTC), []
            while t.year == year:
                out.append((t, 3.0 + math.cos(2 * math.pi * t.timestamp() / 3600 / 12.42)))
                t += dt.timedelta(minutes=10)
            return out
        ev = {"id": "m", "lat": -21.14, "lon": 149.18, "start": "2008-02-14T00:00:00+10:00", "series": [[0, 1], [48, 2]]}
        sea, why = fs.sea_for(ev, fetch=fake, msq=msq)
        self.assertIsNone(why)
        self.assertIn("Mackay", sea["station"])
        self.assertAlmostEqual(max(v for _, v in sea["series"]), 1.0, delta=0.05)

    def test_main_and_merge(self):
        with tempfile.TemporaryDirectory() as d:
            p, sea, out = Path(d, "e.json"), Path(d, "s.json"), Path(d, "o.json")
            p.write_text(json.dumps({"events": [{"id": "x", "lat": -36.1, "lon": 144.7, "start": "2022-10-12T00:00:00+10:00", "series": [[0, 1]]}]}))
            fs.main(p, sea)
            self.assertEqual(json.loads(sea.read_text()), {}, "inland: no tide gauge")
            sea.write_text(json.dumps({"x": {"station": "S", "series": [[0, 0.5]]}}))
            fs.merge(p, sea, out)
            self.assertEqual(json.loads(out.read_text())["events"][0]["sea"]["station"], "S")


if __name__ == "__main__":
    unittest.main()
