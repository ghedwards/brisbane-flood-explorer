"""Tests for the flood class / warnings fetcher (no network).

Run with: python -m unittest tests/test_floodinfo.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch_floodinfo as fi  # noqa: E402

VIC = """<table>
<tr><th>Bureau No.</th><th>AWRC No.</th><th>Station</th><th>Minor</th><th>Moderate</th><th>Major</th><th>Gauge Zero</th></tr>
<tr><td colspan="7">401 - Upper Murray River Basin</td></tr>
<tr><td>82106</td><td>401204</td><td>Tallandoon</td><td>4.2</td><td>4.9</td><td>5.6</td><td>216.893</td></tr>
<tr><td>572037</td><td>n/a</td><td>Khancoban DS Flow</td><td>114 m3/s</td><td>n/a</td><td>n/a</td><td>n/a</td></tr>
<tr><td>572004</td><td>401549</td><td>Bringenbrong</td><td>3.0</td><td>3.4</td><td>n/a</td><td>n/a</td></tr>
</table>"""

RSS = """<rss><channel>
<item><title>Flood Warning for the Mary River</title><link>http://www.bom.gov.au/qld/warnings/flood/maryriver.shtml</link><pubDate>Thu, 15 Oct 2026 03:00:00 GMT</pubDate></item>
<item><title>Severe Thunderstorm Warning &amp; more</title><link>x</link></item>
<item><title>Flood Watch for South East Queensland</title><link>y</link></item>
</channel></rss>"""


class FloodInfo(unittest.TestCase):
    def test_floodclass_table(self):
        got = fi.parse_floodclass(VIC, "vic")
        self.assertEqual(got["82106"]["minor"], 4.2)
        self.assertEqual(got["82106"]["major"], 5.6)
        self.assertEqual(got["82106"]["zero"], 216.893)
        self.assertNotIn("572037", got)            # flow-only thresholds are skipped
        self.assertIsNone(got["572004"]["major"])
        self.assertIsNone(got["572004"]["zero"])

    def test_rss_keeps_flood_items(self):
        got = fi.parse_rss(RSS, "QLD")
        self.assertEqual([w["title"] for w in got], ["Flood Warning for the Mary River", "Flood Watch for South East Queensland"])
        self.assertEqual(got[0]["state"], "QLD")

    def test_main_writes_files_and_survives_failures(self):
        def fake(url, retries=2):
            if "floodclass_north" in url:
                return VIC
            if "IDZ00056" in url:
                return RSS
            raise RuntimeError("unreachable")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(fi, "http_text", fake):
            fi.main(d)
            classes = json.loads((Path(d) / "floodclass.json").read_text())
            warn = json.loads((Path(d) / "warnings.json").read_text())
        self.assertIn("82106", classes)
        self.assertEqual(len(warn["warnings"]), 2)
        self.assertTrue(warn["ok"])


if __name__ == "__main__":
    unittest.main()
