"""Tide heights around the whole Australian coast, for storm tide and tide cycles.

Usage: python pipeline/fetch_tides.py <out.json>

Source: Tidal Statistics for Australia (Tidal range, LAT, HAT, MLWS, MHWS,
Percentiles) derived from the EOT20 tidal model (NESP MaC 3.17, AIMS),
version 1-1, CC BY 4.0, https://doi.org/10.26274/z8b6-zx94. The grids
(1/32 degree, tide heights from the tide model, so relative to mean sea
level) are on eAtlas's Nextcloud share; this finds the share behind the
dataset's link, lists it over WebDAV, downloads the Highest Predicted Tide
(a proxy for HAT) and Mean High Water Springs grids, and keeps the cells at
the coast (next to land), every other one.

Writes {source, fetched, step, points: [[lat, lon, hat, mhws], ...]} with
heights in metres above mean sea level (about AHD).
"""
import datetime as dt
import json
import re
import sys
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ALIAS = "https://nextcloud.eatlas.org.au/apps/sharealias/a/AU_NESP-MaC-3-17_AIMS_EOT20-tidal-stats_v1-1"
UA = {"User-Agent": "brisbane-flood-explorer (github.com/ghedwards/brisbane-flood-explorer)"}


def share_token():
    """Follow the dataset's link to the public share and return its token."""
    req = urllib.request.Request(ALIAS, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        final, body = r.geturl(), r.read(200000).decode("utf-8", "replace")
    for text in (final, body):
        m = re.search(r"/s/([A-Za-z0-9]{8,})", text)
        if m:
            return m.group(1)
    raise RuntimeError(f"no share token behind {ALIAS} (ended at {final})")


def webdav_list(token, path="/"):
    """Files under a public share: [(path, size)], walking folders."""
    out, todo = [], [path]
    base = "https://nextcloud.eatlas.org.au/public.php/webdav"
    import base64
    auth = "Basic " + base64.b64encode(f"{token}:".encode()).decode()
    while todo and len(out) < 2000:
        p = todo.pop()
        req = urllib.request.Request(base + urllib.parse.quote(p), method="PROPFIND",
                                     headers=dict(UA, Depth="1", Authorization=auth))
        with urllib.request.urlopen(req, timeout=60) as r:
            tree = ET.fromstring(r.read())
        for resp in tree.findall("{DAV:}response"):
            href = urllib.parse.unquote(resp.find("{DAV:}href").text)
            rel = href.split("/public.php/webdav", 1)[-1]
            if rel.rstrip("/") == p.rstrip("/"):
                continue
            is_dir = resp.find(".//{DAV:}collection") is not None
            size = resp.find(".//{DAV:}getcontentlength")
            if is_dir:
                todo.append(rel)
            else:
                out.append((rel, int(size.text) if size is not None and size.text else 0))
    return out, base, auth


def pick(files, *words):
    """The GeoTIFF whose name has all the words (case-insensitive), preferring
    whole-of-Australia files over monthly or regional ones."""
    cands = [f for f in files if f[0].lower().endswith((".tif", ".tiff")) and all(w in f[0].lower() for w in words)]
    cands = [f for f in cands if "month" not in f[0].lower()] or cands
    return max(cands, key=lambda f: f[1]) if cands else None


def download(base, auth, rel, dest):
    req = urllib.request.Request(base + urllib.parse.quote(rel), headers=dict(UA, Authorization=auth))
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)


def coastal_points(hat_path, mhws_path, step=2):
    import numpy as np
    import rasterio
    with rasterio.open(hat_path) as h, rasterio.open(mhws_path) as m:
        hat, mh = h.read(1).astype("float32"), m.read(1).astype("float32")
        tf = h.transform
        for arr, src in ((hat, h), (mh, m)):
            if src.nodata is not None:
                arr[arr == src.nodata] = np.nan
    ok = np.isfinite(hat) & np.isfinite(mh) & (np.abs(hat) < 20)
    # coastal: a valid cell with land (no data) among its neighbours
    land = ~ok
    near = np.zeros_like(ok)
    near[1:, :] |= land[:-1, :]
    near[:-1, :] |= land[1:, :]
    near[:, 1:] |= land[:, :-1]
    near[:, :-1] |= land[:, 1:]
    coast = ok & near
    rows, cols = np.nonzero(coast)
    pts = []
    for r, c in zip(rows, cols):
        if (r + c) % step:      # every other coastal cell, in a checkerboard
            continue
        lon, lat = tf * (c + 0.5, r + 0.5)
        pts.append([round(lat, 3), round(lon, 3), round(float(hat[r, c]), 2), round(float(mh[r, c]), 2)])
    return pts


def main(out_path):
    token = share_token()
    files, base, auth = webdav_list(token)
    hat = pick(files, "hpt") or pick(files, "hat")
    mhws = pick(files, "mhws") or pick(files, "mhsw")
    if not hat or not mhws:
        names = ", ".join(f[0] for f in files[:12])
        raise RuntimeError(f"HPT or MHWS grid not found among {len(files)} files ({names})")
    with tempfile.TemporaryDirectory() as d:
        hp, mp = Path(d, "hat.tif"), Path(d, "mhws.tif")
        download(base, auth, hat[0], hp)
        download(base, auth, mhws[0], mp)
        pts = coastal_points(hp, mp)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps({
        "source": "Tidal Statistics for Australia from the EOT20 tidal model (NESP MaC 3.17, AIMS), v1-1, CC BY 4.0",
        "files": [hat[0], mhws[0]], "fetched": now, "points": pts}, separators=(",", ":")))
    print(f"Tides: {len(pts)} coastal points from {hat[0].rsplit('/', 1)[-1]} and {mhws[0].rsplit('/', 1)[-1]}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    try:
        main(sys.argv[1])
    except Exception as e:  # noqa: BLE001 - the app falls back to Queensland ports
        print(f"Tides: unavailable ({str(e)[:300]})")
