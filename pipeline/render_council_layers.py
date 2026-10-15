#!/usr/bin/env python3
"""Pre-render Brisbane City Council flood likelihood layers as images.

Usage: python pipeline/render_council_layers.py site/data/council

The creek and overland-flow likelihood layers are tens of thousands of
detailed polygons, too many to draw in a browser for the whole city. This
downloads them once, rasterises them in Web Mercator (so they line up
exactly on the map) and writes a palette PNG per layer plus council.json
with their bounds. The viewer shows these images when zoomed out and the
live polygons when zoomed in.

Data: Brisbane City Council Flood Awareness, CC BY 4.0.
"""
import datetime as dt
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


BCC = "https://services2.arcgis.com/dEKgZETqwmDAh1rP/ArcGIS/rest/services/"
UA = {"User-Agent": "brisbane-flood-explorer (github.com/ghedwards/brisbane-flood-explorer)"}
R = 6378137.0
PIXEL_M = 15.0  # Web Mercator metres (about 13 m on the ground at Brisbane)

LAYERS = {
    "creek": "Flood_Awareness_Creek",
    "overland": "Flood_Awareness_Overland_Flow",
}
# class value -> colour; higher values are drawn last so they win
CLASSES = {"Very Low": (1, "#fff3a8"), "Low": (2, "#f2c12e"), "Medium": (3, "#e8710a"), "High": (4, "#b3261e")}


def get_json(url, params, retries=4):
    q = url + "?" + urllib.parse.urlencode(params)
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(q, headers=UA), timeout=120) as r:
                data = json.loads(r.read())
            if "error" in data:
                raise RuntimeError(data["error"])
            return data
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as e:
            last = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


def fetch_features(service):
    layer = BCC + service + "/FeatureServer/0/query"
    feats, offset = [], 0
    while True:
        res = get_json(layer, {
            "where": "1=1", "outFields": "FLOOD_RISK", "returnGeometry": "true", "outSR": 102100,
            "maxAllowableOffset": PIXEL_M / 2, "geometryPrecision": 1, "f": "json",
            "resultOffset": offset, "resultRecordCount": 2000, "orderByFields": "OBJECTID",
        })
        batch = res.get("features", [])
        feats += batch
        if not batch or not res.get("exceededTransferLimit"):
            return feats
        offset += len(batch)


def signed_area(ring):
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1])) / 2


def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def esri_to_polygons(rings):
    """Esri rings (outer clockwise, holes anticlockwise) -> GeoJSON polygons."""
    outers, holes = [], []
    for ring in rings:
        if len(ring) < 4:
            continue
        (outers if signed_area(ring) < 0 else holes).append(ring)
    polys = [[o] for o in outers]
    for h in holes:
        for p in polys:
            if point_in_ring(h[0], p[0]):
                p.append(h)
                break
    return [{"type": "Polygon", "coordinates": p} for p in polys]


def to_lonlat(x, y):
    return math.degrees(x / R), math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)


def render(name, service, out_dir):
    from PIL import Image
    from rasterio import features
    from rasterio.transform import from_origin
    feats = fetch_features(service)
    shapes = []
    minx = miny = math.inf
    maxx = maxy = -math.inf
    for f in feats:
        cls = CLASSES.get((f.get("attributes") or {}).get("FLOOD_RISK"))
        rings = (f.get("geometry") or {}).get("rings")
        if not cls or not rings:
            continue
        for ring in rings:
            for x, y in ring:
                minx, maxx = min(minx, x), max(maxx, x)
                miny, maxy = min(miny, y), max(maxy, y)
        for g in esri_to_polygons(rings):
            shapes.append((g, cls[0]))
    if not shapes:
        raise RuntimeError(f"{service}: no polygons")
    shapes.sort(key=lambda s: s[1])  # low classes first, so high classes win
    minx, miny = math.floor(minx / PIXEL_M) * PIXEL_M, math.floor(miny / PIXEL_M) * PIXEL_M
    maxx, maxy = math.ceil(maxx / PIXEL_M) * PIXEL_M, math.ceil(maxy / PIXEL_M) * PIXEL_M
    W, H = int((maxx - minx) / PIXEL_M), int((maxy - miny) / PIXEL_M)
    grid = features.rasterize(shapes, out_shape=(H, W), transform=from_origin(minx, maxy, PIXEL_M, PIXEL_M),
                              fill=0, dtype="uint8", merge_alg=features.MergeAlg.replace)
    img = Image.fromarray(grid, mode="P")
    palette = [0, 0, 0]
    for label, (value, hexcol) in sorted(CLASSES.items(), key=lambda kv: kv[1][0]):
        palette += [int(hexcol[i:i + 2], 16) for i in (1, 3, 5)]
    img.putpalette(palette + [0, 0, 0] * (256 - len(palette) // 3))
    path = out_dir / f"{name}.png"
    img.save(path, optimize=True, transparency=0)
    w, s = to_lonlat(minx, miny)
    e, n = to_lonlat(maxx, maxy)
    counts = {label: int((grid == v).sum()) for label, (v, _) in CLASSES.items()}
    print(f"{name}: {len(feats)} features -> {W}x{H} px, {path.stat().st_size // 1024} KB, cells {counts}")
    return {"file": path.name, "bounds": [w, s, e, n], "features": len(feats), "pixel_m": PIXEL_M}


def main(out_dir: str) -> None:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    meta = {"generated": dt.date.today().isoformat(), "layers": {}, "errors": []}
    for name, service in LAYERS.items():
        try:
            meta["layers"][name] = render(name, service, out)
        except Exception as e:
            meta["errors"].append(f"{name}: {e}")
            print(f"warning: {name}: {e}")
    (out / "council.json").write_text(json.dumps(meta, indent=1))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
