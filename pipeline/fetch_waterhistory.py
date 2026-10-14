#!/usr/bin/env python3
"""Satellite water history for every BoM water storage (dam).

Usage: python pipeline/fetch_waterhistory.py site/data/national

Reads storages.geojson (from fetch_national.py), finds the Digital Earth
Australia Waterbodies polygon at each dam, downloads its Landsat time series
(percentage of the waterbody seen wet on each clear pass since 1987) and
writes waterhistory.json, keyed by storage id:

  {"<id>": {"uid": "...", "area_m2": ..., "start": "1987-06",
            "monthly": [pc or null, ...],   # monthly mean % wet
            "last": ["2026-09-30", 81.2], "passes": 900}}

DEA's files don't allow direct browser requests, so the build fetches them.
Data: DEA Waterbodies, Geoscience Australia, CC BY 4.0.
"""
import concurrent.futures as cf
import csv
import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

WFS = "https://geoserver.dea.ga.gov.au/geoserver/wfs"
LAYER = "DigitalEarthAustraliaWaterbodies_v3"
UA = {"User-Agent": "brisbane-flood-explorer (github.com/ghedwards/brisbane-flood-explorer)"}


def get(url, as_json=True, retries=3):
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                data = r.read()
            return json.loads(data) if as_json else data.decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"{url[:100]}: {last}")


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def contains(geom, x, y):
    polys = [geom["coordinates"]] if geom["type"] == "Polygon" else geom.get("coordinates", [])
    return any(point_in_ring(x, y, p[0]) and not any(point_in_ring(x, y, h) for h in p[1:]) for p in polys)


def find_waterbody(lon, lat, d=0.03):
    q = urllib.parse.urlencode({
        "service": "WFS", "version": "1.1.0", "request": "GetFeature", "typeName": LAYER,
        "outputFormat": "application/json", "srsName": "EPSG:4326",
        "bbox": f"{lon - d},{lat - d},{lon + d},{lat + d},EPSG:4326",
    })
    feats = [f for f in get(f"{WFS}?{q}").get("features", []) if f.get("geometry")]
    if not feats:
        return None
    inside = [f for f in feats if contains(f["geometry"], lon, lat)]
    pool = inside or feats
    return max(pool, key=lambda f: f["properties"].get("area_m2") or 0)


def monthly_series(text):
    rows = list(csv.reader(io.StringIO(text)))
    by_month, last, passes = {}, None, 0
    for r in rows[1:]:
        if len(r) < 2 or not r[1].strip():
            continue
        try:
            pc = float(r[1])
        except ValueError:
            continue
        date = r[0][:10]
        passes += 1
        by_month.setdefault(date[:7], []).append(pc)
        last = [date, round(pc, 1)]
    if not by_month:
        return None
    months = sorted(by_month)
    y, m = int(months[0][:4]), int(months[0][5:7])
    ey, em = int(months[-1][:4]), int(months[-1][5:7])
    out = []
    while (y, m) <= (ey, em):
        vals = by_month.get(f"{y:04d}-{m:02d}")
        out.append(round(sum(vals) / len(vals)) if vals else None)
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return {"start": months[0], "monthly": out, "last": last, "passes": passes}


def one(feature):
    p = feature["properties"]
    lon, lat = feature["geometry"]["coordinates"][:2]
    wb = find_waterbody(lon, lat)
    if not wb:
        return p["id"], None, "no waterbody"
    url = wb["properties"].get("timeseries")
    if not url:
        return p["id"], None, "no time series"
    series = monthly_series(get(url, as_json=False))
    if not series:
        return p["id"], None, "empty time series"
    series.update({"uid": wb["properties"].get("uid"), "area_m2": wb["properties"].get("area_m2")})
    return p["id"], series, None


def main(national_dir: str) -> None:
    d = Path(national_dir)
    storages = json.loads((d / "storages.geojson").read_text())["features"]
    out, misses, errors = {}, 0, []
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        for fut in cf.as_completed([pool.submit(one, f) for f in storages]):
            try:
                sid, series, why = fut.result()
            except Exception as e:
                errors.append(str(e)[:160])
                continue
            if series:
                out[sid] = series
            else:
                misses += 1
    (d / "waterhistory.json").write_text(json.dumps(out, separators=(",", ":")))
    print(f"Water history: {len(out)} of {len(storages)} dams, {misses} without a record, {len(errors)} errors")
    for e in errors[:3]:
        print("warning:", e)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
