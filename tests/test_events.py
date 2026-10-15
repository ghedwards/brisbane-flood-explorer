"""Tests for the recorded-flood and levee fetchers (no network).

Run with: python -m unittest tests/test_events.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch_events as fe  # noqa: E402
import fetch_levees as fl  # noqa: E402


def gauge(lon, lat, **p):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": p}


GAUGES = [
    gauge(153.277, -28.808, name="Lismore (Rowing Club)", basin="Richmond River", station="203004", kind="forecast", id="1"),
    gauge(153.300, -28.800, name="Other Creek", basin="Richmond River", station="203999", kind="forecast", id="2"),
    gauge(153.276, -28.809, name="Lismore tide", station="T1", kind="tide", id="3"),
]


def fake_kiwis(params):
    if params["request"] == "getTimeseriesList":
        return [["ts_id", "ts_name"], ["11", "DMQaQc.Merged.DailyMean.24HR"], ["22", "DMQaQc.Merged.AsStored.1"]]
    data = [[f"2022-02-26T{h:02d}:{m:02d}:00.000+10:00", 2 + h * 0.5] for h in range(0, 20) for m in (0, 30)]
    return [{"ts_id": "22", "data": data}]


class Events(unittest.TestCase):
    def test_picks_the_named_gauge_not_the_tide_gauge(self):
        best = fe.pick_gauge({"lat": -28.809, "lon": 153.2765, "match": "lismore|wilson"}, GAUGES)
        self.assertEqual(best[1]["properties"]["station"], "203004")

    def test_prefers_finer_series_and_averages_to_hours(self):
        with mock.patch.object(fe, "kiwis", fake_kiwis):
            ev = fe.fetch_event({"id": "x", "name": "X", "lat": -28.809, "lon": 153.2765, "match": "lismore",
                                 "start": "2022-02-26", "end": "2022-02-26"}, GAUGES)
        self.assertEqual(ev["ts_name"], "DMQaQc.Merged.AsStored.1")
        self.assertEqual(ev["series"][0], [0, 2.0])
        self.assertEqual(len(ev["series"]), 20)
        self.assertEqual(ev["peak"]["hours"], 19)

    def test_collects_the_same_flood_at_other_gauges_on_the_river(self):
        with mock.patch.object(fe, "kiwis", fake_kiwis):
            ev = fe.fetch_event({"id": "x", "name": "X", "lat": -28.809, "lon": 153.2765, "match": "lismore|richmond",
                                 "start": "2022-02-26", "end": "2022-02-26"}, GAUGES)
        self.assertEqual([o["station"] for o in ev["others"]], ["203999"], "the other Richmond gauge, not the tide gauge")
        self.assertEqual(len(ev["others"][0]["series"]), 20)

    def test_main_records_errors_without_stopping(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(fe, "kiwis", fake_kiwis):
            cfg = Path(d) / "c.json"
            cfg.write_text(json.dumps({"events": [
                {"id": "a", "name": "A", "lat": -28.809, "lon": 153.2765, "match": "lismore", "start": "2022-02-26", "end": "2022-02-26"},
                {"id": "b", "name": "B", "lat": -20.0, "lon": 140.0, "match": "x", "start": "2022-02-26", "end": "2022-02-26"}]}))
            g = Path(d) / "g.json"
            g.write_text(json.dumps({"features": GAUGES}))
            out = Path(d) / "o.json"
            fe.main(cfg, g, out)
            res = json.loads(out.read_text())["events"]
        self.assertTrue(res[0]["series"])
        self.assertIn("error", res[1])


class Levees(unittest.TestCase):
    def test_round_line_drops_repeats_and_short_lines(self):
        self.assertEqual(fl.round_line([[1.000001, 2.0], [1.000002, 2.0], [1.1, 2.1]]), [[1.0, 2.0], [1.1, 2.1]])
        self.assertIsNone(fl.round_line([[1.0, 2.0], [1.000001, 2.0]]))

    def test_main_survives_unreachable_sources(self):
        def boom(*a, **k):
            raise OSError("unreachable")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(fl, "get", boom):
            out = Path(d) / "l.geojson"
            fl.main(out)
            self.assertEqual(json.loads(out.read_text())["features"], [])


if __name__ == "__main__":
    unittest.main()
