"""Tests for the national BoM fetcher, with the services mocked.

Run with: python -m unittest tests/test_national.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import fetch_national as fn  # noqa: E402


def pt(lon, lat, **props):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": props}


def fake(url, params=None, retries=3):
    params = params or {}
    if "/FeatureServer/" in url and url.endswith("/query") or "Water_Storages" in url:
        if "Water_Storages" in url:
            return {"type": "FeatureCollection", "features": [
                pt(152.6, -27.4, storage_id=1, wstorname="Wivenhoe Dam", wiski_station_no="143001A",
                   accessible_capacity_ml=1165240, total_capacity_ml=1165240, river_name="Brisbane River",
                   state_name="Queensland", data_owner="Seqwater")]}
        layer = int(url.split("/FeatureServer/")[1].split("/")[0])
        if params.get("resultOffset", 0) > 0:
            return {"type": "FeatureCollection", "features": []}
        if layer == 2:
            return {"type": "FeatureCollection", "properties": {"exceededTransferLimit": True}, "features": [
                pt(153.03, -27.47, bom_stn_num=540198, awrc_stateid="540198", name="Brisbane City",
                   location_types="Forecast Location", forecast_site_classification="Forecast", basin="Brisbane River")]}
        if layer == 3:
            return {"type": "FeatureCollection", "features": [
                pt(152.9, -27.55, bom_stn_num=540100, awrc_stateid="143001C", name="Moggill",
                   location_types="Information Location", forecast_site_classification="Information")]}
        if layer == 5:
            return {"type": "FeatureCollection", "features": [
                # duplicate of a forecast site: forecast must win
                pt(153.03, -27.47, bom_stn_num=540198, awrc_stateid="540198", name="Brisbane City",
                   location_types="River Gauge"),
                pt(153.17, -27.37, bom_stn_num=540683, awrc_stateid="540683", name="Brisbane Bar",
                   location_types="Tide Gauge")]}
    if url == fn.KIWIS:
        if params["request"] == "getTimeseriesList":
            if params["parametertype_name"] == "Water Course Level":
                return [["station_no", "ts_id"], ["540198", "111"], ["999999", "222"]]
            return [["station_no", "ts_id"], ["143001A", "333"]]
        if params["request"] == "getTimeseriesValues":
            ids = params["ts_id"].split(",")
            out = []
            for i in ids:
                v = {"111": [["2026-10-12T00:00:00.000+10:00", 1.1], ["2026-10-13T00:00:00.000+10:00", 1.3]],
                     "333": [["2026-10-13T00:00:00.000+10:00", 900000.0]]}.get(i)
                if v:
                    out.append({"ts_id": i, "columns": "Timestamp,Value", "data": v})
            return out
    raise AssertionError(f"unexpected request {url} {params}")


class NationalTests(unittest.TestCase):
    def test_fetch_with_mocked_services(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(fn, "http_json", fake):
            fn.main(d)
            gauges = json.loads((Path(d) / "gauges.geojson").read_text())["features"]
            storages = json.loads((Path(d) / "storages.geojson").read_text())["features"]
            readings = json.loads((Path(d) / "readings.json").read_text())
            meta = json.loads((Path(d) / "meta.json").read_text())
        by = {g["properties"]["name"]: g["properties"] for g in gauges}
        self.assertEqual(len(gauges), 3)  # Brisbane City de-duplicated
        self.assertEqual(by["Brisbane City"]["kind"], "forecast")
        self.assertEqual(by["Moggill"]["kind"], "information")
        self.assertEqual(by["Brisbane Bar"]["kind"], "tide")
        self.assertEqual(storages[0]["properties"]["name"], "Wivenhoe Dam")
        self.assertEqual(readings["level"]["540198"]["latest"][1], 1.3)
        self.assertNotIn("999999", readings["level"])  # not a mapped gauge
        self.assertEqual(readings["storage"]["143001A"]["latest"][1], 900000.0)
        self.assertEqual(meta["errors"], [])

    def test_failures_are_recorded_not_fatal(self):
        def broken(url, params=None, retries=3):
            raise RuntimeError("blocked")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(fn, "http_json", broken):
            fn.main(d)
            meta = json.loads((Path(d) / "meta.json").read_text())
        self.assertEqual(meta["gauges"], 0)
        self.assertTrue(meta["errors"])


if __name__ == "__main__":
    unittest.main()


import fetch_waterhistory as wh  # noqa: E402

CSV = "date,pc_wet,px_wet\n1987-06-03T00:00:00Z,50.0,100\n1987-06-19T00:00:00Z,60.0,120\n1987-08-01T00:00:00Z,,\n1987-08-21T00:00:00Z,70.5,140\n"


def fake_wh(url, as_json=True, retries=3):
    if url.startswith(wh.WFS):
        assert "bbox=" in url
        ring = [[152.5, -27.3], [152.6, -27.3], [152.6, -27.2], [152.5, -27.2], [152.5, -27.3]]
        far = [[150.0, -27.3], [150.1, -27.3], [150.1, -27.2], [150.0, -27.2], [150.0, -27.3]]
        return {"features": [
            {"geometry": {"type": "Polygon", "coordinates": [far]}, "properties": {"uid": "big", "area_m2": 9e9, "timeseries": "x"}},
            {"geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": {"uid": "r7hk", "area_m2": 1e8, "timeseries": "https://ts/r7hk.csv"}},
        ]}
    if url == "https://ts/r7hk.csv":
        return CSV
    raise AssertionError(url)


class WaterHistoryTests(unittest.TestCase):
    def test_monthly_series(self):
        s = wh.monthly_series(CSV)
        self.assertEqual(s["start"], "1987-06")
        self.assertEqual(s["monthly"], [55, None, 70])  # July had no pass
        self.assertEqual(s["last"], ["1987-08-21", 70.5])
        self.assertEqual(s["passes"], 3)

    def test_picks_waterbody_containing_the_dam(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(wh, "get", fake_wh):
            (Path(d) / "storages.geojson").write_text(json.dumps({"features": [
                {"geometry": {"type": "Point", "coordinates": [152.55, -27.25]}, "properties": {"id": "7"}}]}))
            wh.main(d)
            out = json.loads((Path(d) / "waterhistory.json").read_text())
        self.assertEqual(out["7"]["uid"], "r7hk")
        self.assertIn("fetched", out["7"])

    def test_keeps_fresh_records_and_fills_missing(self):
        import datetime as dt
        with tempfile.TemporaryDirectory() as d, mock.patch.object(wh, "get", fake_wh):
            (Path(d) / "storages.geojson").write_text(json.dumps({"features": [
                {"geometry": {"type": "Point", "coordinates": [152.55, -27.25]}, "properties": {"id": "7"}},
                {"geometry": {"type": "Point", "coordinates": [152.55, -27.25]}, "properties": {"id": "8"}}]}))
            prev = Path(d) / "prev.json"
            prev.write_text(json.dumps({"7": {"uid": "kept", "fetched": dt.date.today().isoformat()}}))
            wh.main(d, str(prev))
            out = json.loads((Path(d) / "waterhistory.json").read_text())
        self.assertEqual(out["7"]["uid"], "kept")   # fresh: not refetched
        self.assertEqual(out["8"]["uid"], "r7hk")   # missing: fetched


class MissingFileTests(unittest.TestCase):
    def test_forbidden_file_is_recorded_as_missing(self):
        import urllib.error
        def fake(url, as_json=True, retries=2):
            if url.startswith(wh.WFS):
                return fake_wh(url)
            raise FileNotFoundError(url)
        with tempfile.TemporaryDirectory() as d, mock.patch.object(wh, "get", fake):
            (Path(d) / "storages.geojson").write_text(json.dumps({"features": [
                {"geometry": {"type": "Point", "coordinates": [152.55, -27.25]}, "properties": {"id": "9"}}]}))
            wh.main(d)
            out = json.loads((Path(d) / "waterhistory.json").read_text())
        self.assertEqual(out["9"]["missing"], "no time series file")
