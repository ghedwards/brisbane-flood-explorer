"""Tests for the data status file (no network).

Run with: python -m unittest tests/test_status.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import build_status as bs  # noqa: E402


class Status(unittest.TestCase):
    def test_summaries_states_and_dates(self):
        with tempfile.TemporaryDirectory() as d:
            site = Path(d, "site")
            (site / "data" / "national").mkdir(parents=True)
            (site / "data" / "national" / "meta.json").write_text(json.dumps({"fetched": "2026-10-16T00:00:00+00:00"}))
            (site / "data" / "tides.json").write_text(json.dumps({"fetched": "2026-10-01T00:00:00+00:00", "points": []}))
            log = Path(d, "a.log")
            log.write_text("National: 3839 gauges, 303 storages, 0 errors\nLevees: 0 lines (nsw: unavailable)\nRecorded floods: 15 of 22 with hourly readings\n")
            bs.main(site, [log, Path(d, "missing.log")])
            out = {s["name"]: s for s in json.loads((site / "data" / "status.json").read_text())["sources"]}
        self.assertEqual(out["Bureau gauges, dams and readings"]["state"], "ok")
        self.assertEqual(out["Bureau gauges, dams and readings"]["fetched"], "2026-10-16T00:00:00+00:00")
        self.assertEqual(out["Levee lines"]["state"], "problem")
        self.assertEqual(out["Recorded floods (hourly readings)"]["state"], "ok")
        self.assertEqual(out["Tide heights"]["state"], "cached")
        self.assertEqual(out["Workers by place of work"]["state"], "missing")


if __name__ == "__main__":
    unittest.main()
