#!/usr/bin/env python3
"""Download Copernicus GLO-30 DEM tiles for an area and prepare dem.tif.

Usage: python pipeline/fetch_dem.py config/brisbane.json work/brisbane

GLO-30 is a free 30 m global surface model (it includes buildings and
trees). Tiles are public Cloud Optimized GeoTIFFs on AWS Open Data, so this
runs without any login. The output is reprojected to the area's projected
CRS (GDA2020 / MGA zone 56 for Brisbane) at the configured cell size.

For street-level detail, replace work/<area>/dem.tif with an ELVIS LiDAR DEM
(https://elevation.fsdf.org.au/) in the same CRS before running the
hydrology step.
"""
import json
import math
import sys
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.warp import Resampling, reproject, transform_bounds

BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com"
NODATA = -9999.0


def tile_name(lat_floor: int, lon_floor: int) -> str:
    ns = "N" if lat_floor >= 0 else "S"
    ew = "E" if lon_floor >= 0 else "W"
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat_floor):02d}_00_{ew}{abs(lon_floor):03d}_00_DEM"


def download(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    try:
        with urllib.request.urlopen(url, timeout=120) as r, open(dest, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        return True
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):  # all-ocean tiles do not exist
            print(f"  no tile at {url} ({e.code}); treating as sea")
            return False
        raise


def main(config_path: str, out_dir: str) -> None:
    cfg = json.loads(Path(config_path).read_text())
    out = Path(out_dir)
    tiles_dir = out / "tiles"
    tiles_dir.mkdir(parents=True, exist_ok=True)

    w, s, e, n = cfg["bbox_lonlat"]
    pad = 0.02  # degrees, so reprojection has data at the edges
    paths = []
    for lat in range(math.floor(s - pad), math.floor(n + pad) + 1):
        for lon in range(math.floor(w - pad), math.floor(e + pad) + 1):
            name = tile_name(lat, lon)
            dest = tiles_dir / f"{name}.tif"
            print(f"tile {name}")
            if download(f"{BUCKET}/{name}/{name}.tif", dest):
                paths.append(dest)
    if not paths:
        sys.exit("No DEM tiles found for this area.")

    srcs = [rasterio.open(p) for p in paths]
    mosaic, mosaic_tf = merge(srcs, bounds=(w - pad, s - pad, e + pad, n + pad), nodata=NODATA)
    src_crs = srcs[0].crs
    for src in srcs:
        src.close()

    dst_crs = cfg["crs"]
    cell = float(cfg["cell_m"])
    minx, miny, maxx, maxy = transform_bounds("EPSG:4326", dst_crs, w, s, e, n, densify_pts=21)
    minx, miny = math.floor(minx / cell) * cell, math.floor(miny / cell) * cell
    maxx, maxy = math.ceil(maxx / cell) * cell, math.ceil(maxy / cell) * cell
    width, height = int(round((maxx - minx) / cell)), int(round((maxy - miny) / cell))
    dst_tf = rasterio.transform.from_origin(minx, maxy, cell, cell)

    dem = np.full((height, width), NODATA, dtype="float32")
    reproject(
        source=mosaic[0].astype("float32"),
        destination=dem,
        src_transform=mosaic_tf,
        src_crs=src_crs,
        src_nodata=NODATA,
        dst_transform=dst_tf,
        dst_crs=dst_crs,
        dst_nodata=NODATA,
        resampling=Resampling.bilinear,
    )
    # GLO-30 marks the open sea as 0 m; keep it as valid, low ground so the
    # river network can reach the bay.
    profile = {
        "driver": "GTiff", "dtype": "float32", "count": 1, "width": width, "height": height,
        "crs": dst_crs, "transform": dst_tf, "nodata": NODATA,
        "tiled": True, "blockxsize": 256, "blockysize": 256, "compress": "deflate",
    }
    with rasterio.open(out / "dem.tif", "w", **profile) as dst:
        dst.write(dem, 1)
    valid = dem[dem != NODATA]
    print(f"dem.tif: {width} x {height} cells at {cell:g} m, "
          f"elevation {valid.min():.1f} to {valid.max():.1f} m")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
