"""Collect published levee lines into one GeoJSON file for the app.

Usage: python pipeline/fetch_levees.py <out.geojson>

Sources:
  - NSW: the state's levee audit datasets on SEED (one shapefile per town,
    e.g. Kempsey, Nyngan, Moulamein, Conargo), found through the SEED
    catalogue's search API, downloaded and reprojected to lon/lat.
  - Victoria: the coastal levees (DEECA, 2011), if the state's open map
    server provides them as a web feature service.

Writes a FeatureCollection of LineStrings with properties {name, source,
type}. Coordinates are rounded to about a metre. Sources that can't be
reached are skipped and reported.
"""
import io
import json
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

UA = {"User-Agent": "brisbane-flood-explorer (github.com/ghedwards/brisbane-flood-explorer)"}
SEED = "https://datasets.seed.nsw.gov.au/api/3/action/package_search"
VIC_WFS = "https://opendata.maps.vic.gov.au/geoserver/wfs"
VIC_LAYER = "open-data-platform:coastallevees"


def get(url, timeout=90):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def round_line(coords):
    out, last = [], None
    for x, y in coords:
        p = [round(x, 5), round(y, 5)]
        if p != last:
            out.append(p)
            last = p
    return out if len(out) >= 2 else None


def shapefile_lines(zbytes, name, source):
    """Lines from a zipped shapefile, reprojected to lon/lat."""
    import shapefile  # pyshp
    from pyproj import CRS, Transformer
    feats = []
    with tempfile.TemporaryDirectory() as d:
        zipfile.ZipFile(io.BytesIO(zbytes)).extractall(d)
        for shp in Path(d).rglob("*.shp"):
            prj = shp.with_suffix(".prj")
            src = CRS.from_wkt(prj.read_text(errors="ignore")) if prj.exists() else CRS.from_epsg(4283)
            tr = Transformer.from_crs(src, CRS.from_epsg(4326), always_xy=True)
            r = shapefile.Reader(str(shp))
            fields = [f[0] for f in r.fields[1:]]
            for sr in r.iterShapeRecords():
                shape = sr.shape
                if shape.shapeType not in (3, 13, 23, 5, 15, 25):   # lines (and polygon outlines)
                    continue
                attrs = dict(zip(fields, sr.record))
                typ = next((str(v) for k, v in attrs.items() if "type" in k.lower() and v), "")
                parts = list(shape.parts) + [len(shape.points)]
                for a, b in zip(parts[:-1], parts[1:]):
                    pts = [tr.transform(x, y) for x, y in shape.points[a:b]]
                    line = round_line(pts)
                    if line:
                        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": line},
                                      "properties": {"name": name, "source": source, "type": typ}})
    return feats


def nsw_levees(notes):
    feats = []
    q = urllib.parse.urlencode({"q": "levee centreline", "rows": 100})
    res = json.loads(get(f"{SEED}?{q}"))
    pkgs = res.get("result", {}).get("results", [])
    for pkg in pkgs:
        title = pkg.get("title", "")
        if "levee" not in title.lower():
            continue
        name = title.split(" - ")[0].replace("Centreline", "").replace("centreline", "").strip(" -")
        for res_ in pkg.get("resources", []):
            fmt = (res_.get("format") or "").lower()
            url = res_.get("url") or ""
            if "shp" not in fmt and "zip" not in fmt and not url.lower().endswith(".zip"):
                continue
            try:
                got = shapefile_lines(get(url), name, "NSW levee audit")
                feats += got
                notes.append(f"{name}: {len(got)}")
                break
            except Exception as e:  # noqa: BLE001
                notes.append(f"{name}: failed ({str(e)[:60]})")
    return feats


def vic_coastal(notes):
    p = urllib.parse.urlencode({"service": "WFS", "version": "1.0.0", "request": "GetFeature", "typeName": VIC_LAYER,
                                "outputFormat": "application/json", "srsName": "EPSG:4326", "maxFeatures": "20000"})
    j = json.loads(get(f"{VIC_WFS}?{p}", timeout=120))
    feats = []
    for f in j.get("features", []):
        g = f.get("geometry") or {}
        lines = [g["coordinates"]] if g.get("type") == "LineString" else g.get("coordinates", []) if g.get("type") == "MultiLineString" else []
        for ln in lines:
            line = round_line(ln)
            if line:
                feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": line},
                              "properties": {"name": "Coastal levee", "source": "Victoria coastal levees (DEECA)", "type": ""}})
    notes.append(f"Victoria coastal: {len(feats)}")
    return feats


def main(out_path):
    notes, feats = [], []
    for fn in (nsw_levees, vic_coastal):
        try:
            feats += fn(notes)
        except Exception as e:  # noqa: BLE001
            notes.append(f"{fn.__name__}: unavailable ({str(e)[:80]})")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    print(f"Levees: {len(feats)} lines ({'; '.join(notes)[:900]})")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
