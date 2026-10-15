#!/usr/bin/env python3
"""Australia-wide image of DEA's "water seen by satellite since 1987" layer.

Usage: python pipeline/render_dea_mosaic.py site/data/dea

DEA's map server only draws this layer from about zoom 7 (regional scale).
This fetches it at the coarsest zoom the server allows, as Web Mercator
tiles, stitches them into one image for the whole country and writes
water_frequency.png plus dea.json with its bounds. The viewer shows the
image when zoomed out and DEA's live layer when zoomed in.

Data: Digital Earth Australia Water Observations (Geoscience Australia), CC BY 4.0.
"""
import concurrent.futures as cf
import datetime as dt
import io
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

OWS = "https://ows.dea.ga.gov.au/"
LAYER, STYLE = "ga_ls_wo_fq_myear_3", "mysummary_wofs_frequency_3"
AUS = (112.0, -44.0, 154.0, -9.0)  # lon/lat box
R = 6378137.0
HALF = math.pi * R
UA = {"User-Agent": "brisbane-flood-explorer (github.com/ghedwards/brisbane-flood-explorer)"}
FILL = (150, 180, 200)  # DEA's "zoomed out too far" colour


def tile_range(z):
    def tx(lon):
        return int((lon + 180) / 360 * 2 ** z)

    def ty(lat):
        r = math.radians(lat)
        return int((1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** z)
    return tx(AUS[0]), tx(AUS[2]), ty(AUS[3]), ty(AUS[1])


def tile_bbox(x, y, z):
    size = 2 * HALF / 2 ** z
    minx = -HALF + x * size
    maxy = HALF - y * size
    return minx, maxy - size, minx + size, maxy


def fetch(x, y, z, retries=3):
    from PIL import Image
    b = tile_bbox(x, y, z)
    q = urllib.parse.urlencode({
        "service": "WMS", "version": "1.3.0", "request": "GetMap", "layers": LAYER, "styles": STYLE,
        "crs": "EPSG:3857", "bbox": ",".join(f"{v:.3f}" for v in b), "width": 256, "height": 256,
        "format": "image/png", "transparent": "true",
    })
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{OWS}?{q}", headers=UA), timeout=60) as r:
                return Image.open(io.BytesIO(r.read())).convert("RGBA")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"tile {z}/{x}/{y}: {last}")


def is_fill(img):
    """True if DEA returned its 'zoom in' fill instead of data."""
    px = img.getdata()
    n = sum(1 for r, g, b, a in px if a and abs(r - FILL[0]) < 4 and abs(g - FILL[1]) < 4 and abs(b - FILL[2]) < 4)
    return n > len(px) * 0.9


def to_lonlat(x, y):
    return math.degrees(x / R), math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2)


def main(out_dir: str) -> None:
    from PIL import Image
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    # coarsest zoom the server will draw: try 7, else 8 (then halve the size)
    for z in (7, 8):
        x0, x1, y0, y1 = tile_range(z)
        probe = fetch((x0 + x1) // 2, (y0 + y1) // 2, z)  # a tile over inland Australia
        if not is_fill(probe):
            break
    else:
        raise SystemExit("DEA would not draw the layer at zoom 7 or 8")
    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    mosaic = Image.new("RGBA", (cols * 256, rows * 256), (0, 0, 0, 0))
    errors = 0
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        futs = {pool.submit(fetch, x, y, z): (x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)}
        for fut in cf.as_completed(futs):
            x, y = futs[fut]
            try:
                img = fut.result()
            except Exception as e:
                errors += 1
                print("warning:", e)
                continue
            if not is_fill(img):
                mosaic.paste(img, ((x - x0) * 256, (y - y0) * 256))
    if z == 8:
        mosaic = mosaic.resize((mosaic.width // 2, mosaic.height // 2), Image.LANCZOS)
    # palette image keeps the file small; alpha preserved
    small = mosaic.quantize(colors=96, method=Image.Quantize.FASTOCTREE)
    path = out / "water_frequency.png"
    small.save(path, optimize=True)
    minx, _, _, maxy = tile_bbox(x0, y0, z)
    _, miny, maxx, _ = tile_bbox(x1, y1, z)
    w, s = to_lonlat(minx, miny)
    e, n = to_lonlat(maxx, maxy)
    meta = {"generated": dt.date.today().isoformat(), "zoom": z,
            "water_frequency": {"file": path.name, "bounds": [w, s, e, n]}, "tileErrors": errors}
    (out / "dea.json").write_text(json.dumps(meta, indent=1))
    print(f"DEA mosaic: zoom {z}, {cols}x{rows} tiles -> {small.width}x{small.height} px, "
          f"{path.stat().st_size // 1024} KB, {errors} tile errors")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
