"""Keep a copy of OpenStreetMap buildings, roads and key sites for each preset.

Usage: python pipeline/fetch_osm.py viewer/app.js <out_dir> [--max N] [--days D]

The app counts what a flood affects from OpenStreetMap through the Overpass
API, which is often slow or busy. For the preset places the build keeps a
copy instead: each run refreshes up to N presets (missing ones first, then
any older than D days), so the full set fills in over a few runs and stays
current without hammering the service. The query matches the app's own
(viewer/app.js, loadImpactData); the box is a little larger than a 20 km
model so it still covers the model after it snaps to the river.

Writes <out_dir>/<id>.json:
  {id, bbox: [south, west, north, east], fetched,
   b: [lon, lat, ...] building centres, f: [flags] (1 home, 2 workplace),
   nodes: [lat, lon, ...], roads: [[name, type, [node index, ...]], ...],
   sites: [[name, kind, lat, lon], ...]}
and <out_dir>/index.json listing {id, bbox, fetched, buildings} for each.
"""
import datetime as dt
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS = ["https://overpass-api.de/api/interpreter",
            "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
            "https://overpass.kumi.systems/api/interpreter"]
UA = {"User-Agent": "brisbane-flood-explorer (github.com/ghedwards/brisbane-flood-explorer)"}
HALF_KM = 13
VERSION = 2   # 2: evacuation centres added to the sites; older copies are refetched first
SITE_KINDS = {
    "hospital": "Hospital", "clinic": "Clinic", "doctors": "Doctors", "school": "School", "kindergarten": "Kindergarten",
    "childcare": "Childcare", "nursing_home": "Aged care", "fire_station": "Fire station", "police": "Police",
    "ambulance_station": "Ambulance", "community_centre": "Community centre",
}
ROAD_TYPES = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street"
HOMES = "house|residential|detached|semidetached_house|terrace|apartments|bungalow|dormitory|duplex|cabin"
WORK = "commercial|retail|industrial|office|warehouse|supermarket|school|university|college|hospital|public|civic|government|kindergarten"


def presets(app_js):
    """The presets listed in the app: [{id, lat, lon}]."""
    src = Path(app_js).read_text()
    block = src[src.index("const PRESETS = ["):]
    block = block[:block.index("];")]
    pat = re.compile(r"id: '([^']+)'.*?lat: (-?[\d.]+), lon: (-?[\d.]+)")
    return [{"id": m[0], "lat": float(m[1]), "lon": float(m[2])} for m in pat.findall(block)]


def box(lat, lon, half_km=HALF_KM):
    dlat = half_km * 1000 / 110574
    dlon = half_km * 1000 / (111320 * math.cos(math.radians(lat)))
    return [round(lat - dlat, 5), round(lon - dlon, 5), round(lat + dlat, 5), round(lon + dlon, 5)]


def query(bb):
    b = ",".join(str(v) for v in bb)
    mark = lambda n: f'make marker name="{n}";out;'  # noqa: E731
    sites = "|".join(SITE_KINDS)
    return (f"[out:json][timeout:240];"
            f"{mark('buildings')}way[\"building\"]({b});out ids center qt;"
            f"{mark('homes')}way[\"building\"~\"^({HOMES})$\"]({b});out ids qt;"
            f"{mark('work')}way[\"building\"~\"^({WORK})$\"]({b});out ids qt;"
            f"{mark('roads')}way[\"highway\"~\"^({ROAD_TYPES})(_link)?$\"]({b});out body geom qt;"
            f"{mark('sites')}nwr[\"amenity\"~\"^({sites})$\"]({b});out tags center qt;"
            f"nwr[\"social_facility\"~\"^(nursing_home|assisted_living)$\"]({b});out tags center qt;"
            f"nwr[\"emergency\"~\"^(evacuation_centre|evacuation_center)$\"]({b});out tags center qt;"
            f"nwr[\"evacuation_centre\"=\"yes\"]({b});out tags center qt;nwr[\"evacuation_center\"=\"yes\"]({b});out tags center qt;")


def overpass(q, timeout=300):
    last = None
    for url in OVERPASS:
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(), headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
            j = json.loads(body)
            if "remark" in j and "error" in str(j.get("remark", "")).lower():
                raise RuntimeError(str(j["remark"])[:120])
            return j
        except Exception as e:  # noqa: BLE001 - try the next mirror
            last = e
    raise RuntimeError(f"OpenStreetMap service unavailable ({str(last)[:120]})")


def compact(osm, pid, bb):
    """The app's structures, in a compact form."""
    b, f, idx = [], [], {}
    homes, work = set(), set()
    nodes, node_idx, roads, sites = [], {}, [], []
    section = ""
    for e in osm.get("elements", []):
        if e.get("type") == "marker":
            section = (e.get("tags") or {}).get("name", "")
            continue
        if section == "buildings" and e.get("center"):
            if e["id"] not in idx:
                idx[e["id"]] = len(f)
                b += [round(e["center"]["lon"], 6), round(e["center"]["lat"], 6)]
                f.append(0)
        elif section == "homes":
            homes.add(e["id"])
        elif section == "work":
            work.add(e["id"])
        elif section == "roads" and e.get("geometry"):
            tags = e.get("tags") or {}
            pts, ids = e["geometry"], e.get("nodes") or []
            if len(ids) != len(pts):
                ids = [f"{p['lat']:.6f},{p['lon']:.6f}" for p in pts]
            seq = []
            for nid, p in zip(ids, pts):
                if p is None:
                    continue
                k = node_idx.get(nid)
                if k is None:
                    k = node_idx[nid] = len(nodes) // 2
                    nodes += [round(p["lat"], 6), round(p["lon"], 6)]
                seq.append(k)
            if len(seq) >= 2:
                roads.append([tags.get("name") or tags.get("ref") or "", tags.get("highway", ""), seq])
        elif section == "sites" and e.get("tags"):
            t = e["tags"]
            ll = e.get("center") or ({"lat": e["lat"], "lon": e["lon"]} if "lat" in e else None)
            evac = t.get("emergency") in ("evacuation_centre", "evacuation_center") or "yes" in (t.get("evacuation_centre"), t.get("evacuation_center"))
            kind = "Evacuation centre" if evac else SITE_KINDS.get(t.get("amenity", "")) or ("Aged care" if t.get("social_facility") else None)
            if ll and kind:
                sites.append([t.get("name") or kind, kind, round(ll["lat"], 6), round(ll["lon"], 6)])
    for i_d, i in idx.items():
        f[i] = (1 if i_d in homes else 0) | (2 if i_d in work else 0)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    return {"id": pid, "v": VERSION, "bbox": bb, "fetched": now, "b": b, "f": f, "nodes": nodes, "roads": roads, "sites": sites}


def age_days(path):
    try:
        d = json.loads(path.read_text())
        if d.get("v", 1) < VERSION:
            return math.inf
        t = dt.datetime.fromisoformat(d["fetched"])
        return (dt.datetime.now(dt.timezone.utc) - t).total_seconds() / 86400
    except Exception:  # noqa: BLE001
        return math.inf


def main(app_js, out_dir, max_n=12, days=30, budget_s=1500):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    ps = presets(app_js)
    todo = sorted(((age_days(out / f"{p['id']}.json"), p) for p in ps), key=lambda x: -x[0])
    todo = [p for a, p in todo if a > days][:max_n]
    done, failed, t0 = [], [], time.time()
    for p in todo:
        if time.time() - t0 > budget_s:
            break
        bb = box(p["lat"], p["lon"])
        try:
            d = compact(overpass(query(bb)), p["id"], bb)
            (out / f"{p['id']}.json").write_text(json.dumps(d, separators=(",", ":"), ensure_ascii=False))
            done.append(f"{p['id']} ({len(d['f'])})")
        except Exception as e:  # noqa: BLE001
            failed.append(f"{p['id']}: {str(e)[:80]}")
        time.sleep(2)   # be gentle with the shared service
    ids = {p["id"] for p in ps}
    index = []
    for path in sorted(out.glob("*.json")):
        if path.stem == "index" or path.stem not in ids:
            continue
        try:
            d = json.loads(path.read_text())
            index.append({"id": d["id"], "bbox": d["bbox"], "fetched": d["fetched"], "buildings": len(d["f"])})
        except Exception:  # noqa: BLE001
            continue
    (out / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    print(f"OpenStreetMap copies: {len(index)} of {len(ps)} presets; refreshed {len(done)}: {', '.join(done)[:500]}")
    for f in failed[:5]:
        print(f"warning: {f}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit(__doc__)
    opt = {"max_n": 12, "days": 30}
    if "--max" in args:
        opt["max_n"] = int(args[args.index("--max") + 1])
    if "--days" in args:
        opt["days"] = float(args[args.index("--days") + 1])
    main(args[0], args[1], **opt)
