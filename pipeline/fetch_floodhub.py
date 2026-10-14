#!/usr/bin/env python3
"""Fetch Google Flood Hub forecasts for South East Queensland.

Usage: FLOOD_FORECASTING_API_KEY=... python pipeline/fetch_floodhub.py config/brisbane.json site/data

Writes site/data/floodhub.json (gauges, latest flood status, thresholds,
forecasts, flash-flood events) and site/data/floodhub.geojson (forecast
flood areas and flash-flood areas). Uses only the Python standard library.

Without an API key it writes a small "not connected" file so the viewer can
explain how to switch the feed on. Access to the Flood Forecasting API is
free but needs approval: https://developers.google.com/flood-forecasting
Data are CC BY 4.0 (Google Flood Hub).
"""
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = "https://floodforecasting.googleapis.com/v1/"
ATTRIBUTION = "Flood forecasts: Google Flood Hub (CC BY 4.0)"


class Api:
    def __init__(self, key: str):
        self.key = key
        self.calls = 0

    def _req(self, method: str, path: str, params=None, body=None):
        q = dict(params or {})
        q["key"] = self.key
        url = BASE + path + "?" + urllib.parse.urlencode(q, doseq=True)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        self.calls += 1
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {detail}") from None

    def get(self, path, params=None):
        return self._req("GET", path, params=params)

    def post(self, path, body):
        return self._req("POST", path, body=body)

    def paged(self, path, body, key):
        out, token = [], None
        while True:
            b = dict(body)
            if token:
                b["pageToken"] = token
            res = self.post(path, b)
            out += res.get(key, [])
            token = res.get("nextPageToken")
            if not token:
                return out


def region_loop(bbox):
    """A counter-clockwise loop (as S2 expects) around [west, south, east, north]."""
    w, s, e, n = bbox
    pts = [(s, w), (s, e), (n, e), (n, w)]
    return {"vertices": [{"latitude": la, "longitude": lo} for la, lo in pts]}


def kml_to_geometry(kml: str):
    """Convert a Flood Hub KML polygon string to a GeoJSON geometry."""
    root = ET.fromstring(kml)
    polys = []
    for poly in root.iter():
        if not poly.tag.endswith("Polygon"):
            continue
        rings = []
        for el in poly.iter():
            if el.tag.endswith("coordinates") and el.text:
                ring = []
                for tok in el.text.split():
                    parts = tok.split(",")
                    if len(parts) >= 2:
                        ring.append([round(float(parts[0]), 6), round(float(parts[1]), 6)])
                if len(ring) >= 4:
                    rings.append(ring)
        if rings:
            polys.append(rings)
    if not polys:
        return None
    if len(polys) == 1:
        return {"type": "Polygon", "coordinates": polys[0]}
    return {"type": "MultiPolygon", "coordinates": polys}


def geometry_bbox(geom):
    xs, ys = [], []

    def walk(c):
        if c and isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for x in c:
                walk(x)
    walk(geom["coordinates"])
    return [min(xs), min(ys), max(xs), max(ys)]


def overlaps(a, b):
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def polygon_feature(api, polygon_id, props, cache):
    if not polygon_id:
        return None
    if polygon_id not in cache:
        res = api.get(f"serializedPolygons/{polygon_id}")
        cache[polygon_id] = kml_to_geometry(res.get("kml", "")) if res.get("kml") else None
    geom = cache[polygon_id]
    if not geom:
        return None
    return {"type": "Feature", "geometry": geom, "properties": dict(props, polygonId=polygon_id)}


def main(config_path: str, data_dir: str) -> None:
    cfg = json.loads(Path(config_path).read_text())
    out = Path(data_dir)
    out.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    region = cfg.get("floodhub_bbox_lonlat", cfg["bbox_lonlat"])
    summary = {"configured": False, "fetched": now, "region": region, "attribution": ATTRIBUTION}

    key = os.environ.get("FLOOD_FORECASTING_API_KEY", "").strip()
    if not key:
        summary["message"] = "Google Flood Hub is not connected yet."
        (out / "floodhub.json").write_text(json.dumps(summary, indent=2))
        print("No FLOOD_FORECASTING_API_KEY; wrote a 'not connected' file.")
        return

    api = Api(key)
    summary["configured"] = True
    loop = region_loop(region)
    features, polys, errors = [], {}, []

    def attempt(label, fn, default):
        try:
            return fn()
        except Exception as exc:  # keep going; record what failed
            errors.append(f"{label}: {exc}")
            print(f"warning: {label}: {exc}")
            return default

    gauges = attempt("gauges", lambda: api.paged("gauges:searchGaugesByArea", {
        "loop": loop, "includeNonQualityVerified": True, "includeGaugesWithoutHydroModel": True,
    }, "gauges"), [])
    statuses = attempt("flood status", lambda: api.paged("floodStatus:searchLatestFloodStatusByArea", {
        "loop": loop, "includeNonQualityVerified": True,
    }, "floodStatuses"), [])
    by_id = {g["gaugeId"]: dict(g) for g in gauges}
    for st in statuses:
        by_id.setdefault(st["gaugeId"], {"gaugeId": st["gaugeId"], "location": st.get("gaugeLocation")})
        by_id[st["gaugeId"]]["status"] = st

    modelled = [gid for gid, g in by_id.items() if g.get("hasModel") or g.get("status")]
    for gid in modelled:
        m = attempt(f"model {gid}", lambda gid=gid: api.get(f"gaugeModels/{gid}"), None)
        if m:
            by_id[gid]["model"] = {k: m.get(k) for k in ("gaugeModelId", "thresholds", "gaugeValueUnit", "qualityVerified")}
    if modelled:
        start = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).date().isoformat()
        fc = attempt("forecasts", lambda: api.get("gauges:queryGaugeForecasts",
                                                  {"gaugeIds": modelled[:500], "issuedTimeStart": start}), {})
        for gid, fs in (fc.get("forecasts") or {}).items():
            items = sorted(fs.get("forecasts", []), key=lambda f: f.get("issuedTime", ""))
            if items and gid in by_id:
                latest = items[-1]
                by_id[gid]["forecast"] = {
                    "issuedTime": latest.get("issuedTime"),
                    "values": [[r.get("forecastStartTime"), r.get("value")] for r in latest.get("forecastRanges", [])],
                }

    # forecast flood areas from gauges that have them
    for gid, g in by_id.items():
        st = g.get("status") or {}
        ims = (st.get("inundationMapSet") or {})
        for im in ims.get("inundationMaps", []):
            f = attempt(f"area {gid}", lambda im=im: polygon_feature(api, im.get("serializedPolygonId"), {
                "kind": "forecast-area", "gaugeId": gid, "level": im.get("level"),
                "mapType": ims.get("inundationMapType"), "severity": st.get("severity"),
            }, polys), None)
            if f:
                features.append(f)

    # flash floods in Australia that touch the region
    flash = attempt("flash floods", lambda: api.paged("flashFloods:search", {"countryCodes": ["AU"]}, "flashFloodEvents"), [])
    kept = []
    for ev in flash:
        for level, pid in (("LIKELY", ev.get("likelyAffectedPolygonId")),
                           ("HIGHLY_LIKELY", ev.get("highlyLikelyAffectedPolygonId"))):
            f = attempt("flash flood area", lambda pid=pid, level=level: polygon_feature(api, pid, {
                "kind": "flash-flood", "level": level, "issued": ev.get("forecastIssueTime"),
                "hours": ev.get("forecastPeriodHours"),
            }, polys), None)
            if f and overlaps(geometry_bbox(f["geometry"]), region):
                features.append(f)
                kept.append(ev)

    summary.update({
        "gauges": list(by_id.values()),
        "flashFloodEvents": [dict(e) for e in {id(e): e for e in kept}.values()],
        "areas": len(features),
        "apiCalls": api.calls,
        "errors": errors,
    })
    (out / "floodhub.json").write_text(json.dumps(summary, indent=1))
    (out / "floodhub.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    flooding = [g for g in by_id.values() if (g.get("status") or {}).get("severity") in ("ABOVE_NORMAL", "SEVERE", "EXTREME")]
    print(f"Flood Hub: {len(by_id)} gauges, {len(flooding)} above normal, "
          f"{len(kept)} flash-flood events, {len(features)} areas, {api.calls} API calls, {len(errors)} errors")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
