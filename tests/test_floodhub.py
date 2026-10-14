"""Tests for the Flood Hub fetcher, with the Google API mocked.

Run with: python -m unittest tests/test_floodhub.py
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch_floodhub as fh  # noqa: E402

CONFIG = str(Path(__file__).resolve().parent.parent / "config" / "brisbane.json")

KML = """<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
<Polygon><outerBoundaryIs><LinearRing><coordinates>
153.0,-27.5,0 153.1,-27.5,0 153.1,-27.4,0 153.0,-27.4,0 153.0,-27.5,0
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>"""

FAR_KML = KML.replace("153.0,", "130.0,").replace("153.1,", "130.1,")


def fake(method, path, params=None, body=None):
    if path == "gauges:searchGaugesByArea":
        return {"gauges": [
            {"gaugeId": "g1", "siteName": "Brisbane", "river": "Brisbane River", "hasModel": True,
             "location": {"latitude": -27.47, "longitude": 153.03}, "qualityVerified": True},
            {"gaugeId": "g2", "siteName": "No model", "hasModel": False,
             "location": {"latitude": -27.6, "longitude": 152.9}}]}
    if path == "floodStatus:searchLatestFloodStatusByArea":
        assert body.get("regionCode") == "AU" or len(body["loop"]["vertices"]) == 4
        return {"floodStatuses": [{
            "gaugeId": "g1", "severity": "SEVERE", "forecastTrend": "RISE",
            "issuedTime": "2026-10-14T00:00:00Z",
            "inundationMapSet": {"inundationMapType": "PROBABILITY",
                                 "inundationMaps": [{"level": "HIGH", "serializedPolygonId": "p1"}]}}]}
    if path == "gaugeModels/g1":
        return {"gaugeModelId": "m1", "gaugeValueUnit": "CUBIC_METERS_PER_SECOND",
                "thresholds": {"warningLevel": 100, "dangerLevel": 200}}
    if path == "gauges:queryGaugeForecasts":
        return {"forecasts": {"g1": {"forecasts": [
            {"issuedTime": "2026-10-13T00:00:00Z", "forecastRanges": [{"forecastStartTime": "a", "value": 1}]},
            {"issuedTime": "2026-10-14T00:00:00Z", "forecastRanges": [
                {"forecastStartTime": "2026-10-14T00:00:00Z", "value": 150},
                {"forecastStartTime": "2026-10-15T00:00:00Z", "value": 220}]}]}}}
    if path == "flashFloods:search":
        return {"flashFloodEvents": [
            {"likelyAffectedPolygonId": "p2", "forecastIssueTime": "2026-10-14T01:00:00Z", "forecastPeriodHours": 6},
            {"likelyAffectedPolygonId": "far", "forecastIssueTime": "2026-10-14T01:00:00Z"}]}
    if path.startswith("serializedPolygons/"):
        pid = path.split("/")[1]
        return {"polygonId": pid, "kml": FAR_KML if pid == "far" else KML}
    raise AssertionError(f"unexpected call {method} {path}")


def box_config(tmp):
    cfg = json.loads(Path(CONFIG).read_text())
    cfg.pop("floodhub_region", None)
    cfg["floodhub_bbox_lonlat"] = [151.9, -28.4, 153.6, -26.4]
    p = Path(tmp) / "cfg.json"
    p.write_text(json.dumps(cfg))
    return str(p)


class FloodHubTests(unittest.TestCase):
    def test_kml_polygon(self):
        g = fh.kml_to_geometry(KML)
        self.assertEqual(g["type"], "Polygon")
        self.assertEqual(g["coordinates"][0][0], [153.0, -27.5])

    def test_loop_is_counter_clockwise(self):
        v = fh.region_loop([1, 2, 3, 4])["vertices"]
        area = sum(v[i]["longitude"] * v[(i + 1) % 4]["latitude"] - v[(i + 1) % 4]["longitude"] * v[i]["latitude"]
                   for i in range(4))
        self.assertGreater(area, 0)

    def test_without_key_writes_not_connected(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"FLOOD_FORECASTING_API_KEY": ""}):
            fh.main(CONFIG, d)
            s = json.loads((Path(d) / "floodhub.json").read_text())
            self.assertFalse(s["configured"])

    def test_national_fetch_keeps_all_australian_flash_floods(self):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.dict(os.environ, {"FLOOD_FORECASTING_API_KEY": "test"}), \
                mock.patch.object(fh.Api, "_req", lambda self, m, p, params=None, body=None: fake(m, p, params, body)):
            fh.main(CONFIG, d)
            s = json.loads((Path(d) / "floodhub.json").read_text())
        self.assertEqual(s["regionCode"], "AU")
        self.assertEqual(len(s["flashFloodEvents"]), 2)

    def test_full_fetch_with_mocked_api(self):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.dict(os.environ, {"FLOOD_FORECASTING_API_KEY": "test"}), \
                mock.patch.object(fh.Api, "_req", lambda self, m, p, params=None, body=None: fake(m, p, params, body)):
            fh.main(box_config(d), d)
            s = json.loads((Path(d) / "floodhub.json").read_text())
            gj = json.loads((Path(d) / "floodhub.geojson").read_text())
        self.assertTrue(s["configured"])
        self.assertEqual(s["errors"], [])
        g1 = next(g for g in s["gauges"] if g["gaugeId"] == "g1")
        self.assertEqual(g1["status"]["severity"], "SEVERE")
        self.assertEqual(g1["model"]["thresholds"]["dangerLevel"], 200)
        self.assertEqual(g1["forecast"]["values"][-1][1], 220)
        kinds = sorted(f["properties"]["kind"] for f in gj["features"])
        self.assertEqual(kinds, ["flash-flood", "forecast-area"])  # far-away flash flood dropped
        self.assertEqual(len(s["flashFloodEvents"]), 1)


if __name__ == "__main__":
    unittest.main()
