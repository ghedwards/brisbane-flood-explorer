"""Fetch hour-by-hour gauge readings for recorded floods (Water Data Online).

Usage: python pipeline/fetch_events.py config/events.json <gauges.geojson> <out.json>

For each event in the config, picks the Bureau gauge nearest the event's
location (within 8 km) whose name or basin matches the event's 'match'
pattern and that has a Water Data Online station, finds its finest water
level series (hourly means, else the readings as stored, else daily means),
reads the event window and averages it to hourly values.

Writes {fetched, events: [{id, name, gauge, ts_name, start, series:
[[hours from start, metres on the gauge board], ...], peak: {hours, level},
error?}]}. Levels are on the gauge's own datum (its board), not AHD; the app
uses the shape of the rise and fall and lines the peak up with the
scenario's peak.
"""
import datetime as dt
import json
import math
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_national import kiwis  # noqa: E402  (same client and user agent)

PREFERRED = ("HourlyMean", "AsStored", "DailyMean")


def km(lat1, lon1, lat2, lon2):
    dy = (lat1 - lat2) * 110.574
    dx = (lon1 - lon2) * 111.32 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dx, dy)


def candidates(ev, gauges):
    """Gauges within 8 km, best first: named for the river or town, then
    forecast before information gauges, then nearest."""
    pat = re.compile(ev.get("match", "."), re.I)
    out = []
    for f in gauges:
        p = f["properties"]
        if not p.get("station") or p.get("kind") == "tide":
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        d = km(ev["lat"], ev["lon"], lat, lon)
        if d > 8:
            continue
        named = bool(pat.search(f"{p.get('name', '')} {p.get('basin', '')}"))
        rank = {"forecast": 0, "information": 1}.get(p.get("kind"), 2)
        out.append(((0 if named else 100) + rank * 3 + d, f, d))
    return sorted(out, key=lambda x: x[0])


def pick_gauge(ev, gauges):
    pat = re.compile(ev.get("match", "."), re.I)
    best = None
    for f in gauges:
        p = f["properties"]
        if not p.get("station") or p.get("kind") == "tide":
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        d = km(ev["lat"], ev["lon"], lat, lon)
        if d > 8:
            continue
        named = bool(pat.search(f"{p.get('name', '')} {p.get('basin', '')}"))
        rank = {"forecast": 0, "information": 1}.get(p.get("kind"), 2)
        score = (0 if named else 100) + rank * 3 + d
        if best is None or score < best[0]:
            best = (score, f, d)
    return best


def nearby_stations(ev, limit=12):
    """Water Data Online stations within about 8 km, river stations named
    for the event first, then nearest."""
    dy, dx = 8 / 110.574, 8 / (111.32 * math.cos(math.radians(ev["lat"])))
    rows = kiwis({"request": "getStationList", "bBox": f"{ev['lon'] - dx},{ev['lat'] - dy},{ev['lon'] + dx},{ev['lat'] + dy}",
                  "returnfields": "station_no,station_name,station_latitude,station_longitude"})
    if not rows or not isinstance(rows, list) or len(rows) < 2:
        return []
    h = rows[0]
    pat = re.compile(ev.get("match", "."), re.I)
    out = []
    for r in rows[1:]:
        try:
            lat, lon = float(r[h.index("station_latitude")]), float(r[h.index("station_longitude")])
        except (TypeError, ValueError):
            continue
        name = str(r[h.index("station_name")])
        d = km(ev["lat"], ev["lon"], lat, lon)
        if d <= 8:
            out.append(((0 if pat.search(name) else 100) + d,
                        {"station": str(r[h.index("station_no")]), "name": name, "lat": lat, "lon": lon}))
    return [x[1] for x in sorted(out, key=lambda x: x[0])][:limit]


def series_list(station):
    """The station's water level series, finest first (merged before raw)."""
    rows = kiwis({"request": "getTimeseriesList", "station_no": station, "parametertype_name": "Water Course Level",
                  "returnfields": "ts_id,ts_name"})
    if not rows or not isinstance(rows, list) or len(rows) < 2:
        return []
    header, data = rows[0], rows[1:]
    i_id, i_nm = header.index("ts_id"), header.index("ts_name")
    out = []
    for want in PREFERRED:
        for merged in (True, False):
            for r in data:
                nm = str(r[i_nm])
                if want in nm and ("Merged" in nm) == merged and (str(r[i_id]), nm) not in out:
                    out.append((str(r[i_id]), nm))
    return out


def pick_series(station):
    got = series_list(station)
    return got[0] if got else None


def parse_time(s):
    s = s.replace("Z", "+00:00")
    t = dt.datetime.fromisoformat(s)
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone(dt.timedelta(hours=10)))


def hourly(points, start):
    """Average readings into hourly bins: [[hours from start, level], ...]."""
    bins = {}
    for t, v in points:
        if v is None:
            continue
        h = math.floor((parse_time(t) - start).total_seconds() / 3600)
        bins.setdefault(h, []).append(float(v))
    return [[h, round(sum(vs) / len(vs), 3)] for h, vs in sorted(bins.items())]


def readings(ts_id, start, end):
    res = kiwis({"request": "getTimeseriesValues", "ts_id": ts_id, "from": start.isoformat(), "to": end.isoformat(),
                 "returnfields": "Timestamp,Value"})
    entry = res[0] if isinstance(res, list) and res else res if isinstance(res, dict) else {}
    return hourly(entry.get("data") or [], start)


def others_on_river(ev, gauges, main_station, start, end, radius=40, limit=4):
    """Readings for the same flood at other gauges on the river (named for
    it, within 40 km), so the app can follow the flood between gauges."""
    pat = re.compile(ev.get("match", "."), re.I)
    cands = []
    for f in gauges:
        p = f["properties"]
        if not p.get("station") or p.get("station") == main_station or p.get("kind") == "tide":
            continue
        if not pat.search(f"{p.get('name', '')} {p.get('basin', '')}"):
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        d = km(ev["lat"], ev["lon"], lat, lon)
        if d <= radius:
            cands.append((d, p, lat, lon))
    out = []
    for d, p, lat, lon in sorted(cands, key=lambda x: x[0])[:10]:
        if len(out) >= limit:
            break
        for ts_id, ts_name in series_list(p["station"])[:2]:
            series = readings(ts_id, start, end)
            if len(series) >= 6:
                out.append({"name": p.get("name"), "station": p.get("station"), "lat": lat, "lon": lon, "km": round(d, 2),
                            "ts_name": ts_name, "series": series})
                break
    return out


def fetch_event(ev, gauges):
    out = {"id": ev["id"], "name": ev["name"], "lat": ev["lat"], "lon": ev["lon"]}
    aest = dt.timezone(dt.timedelta(hours=10))
    start = dt.datetime.fromisoformat(ev["start"]).replace(tzinfo=aest)
    end = dt.datetime.fromisoformat(ev["end"]).replace(tzinfo=aest) + dt.timedelta(days=1)
    # Bureau flood gauges near the town first, then any other Water Data
    # Online station near it (many flood gauges aren't on Water Data Online,
    # and some series don't reach back to older floods)
    stations = []
    for _, f, d in candidates(ev, gauges)[:8]:
        p = f["properties"]
        lon, lat = f["geometry"]["coordinates"][:2]
        stations.append({"name": p.get("name"), "station": p.get("station"), "id": p.get("id"), "lat": lat, "lon": lon, "km": round(d, 2)})
    tried, with_series = 0, 0
    for k in range(2):
        if k == 1:
            seen = {s_["station"] for s_ in stations}
            stations = [dict(st, km=round(km(ev["lat"], ev["lon"], st["lat"], st["lon"]), 2))
                        for st in nearby_stations(ev) if st["station"] not in seen]
        for st in stations:
            tried += 1
            sl = series_list(st["station"])
            with_series += bool(sl)
            for ts_id, ts_name in sl[:4]:
                series = readings(ts_id, start, end)
                if len(series) >= 6:
                    out["gauge"] = st
                    out["ts_name"] = ts_name
                    out["start"] = start.isoformat()
                    out["series"] = series
                    pk = max(series, key=lambda r: r[1])
                    out["peak"] = {"hours": pk[0], "level": pk[1]}
                    out["others"] = others_on_river(ev, gauges, st["station"], start, end)
                    return out
    if not tried:
        out["error"] = "no gauge or Water Data Online station within 8 km"
    elif not with_series:
        out["error"] = f"none of the {tried} gauges and stations within 8 km has a water level series on Water Data Online"
    else:
        out["error"] = f"{with_series} of {tried} stations within 8 km have water levels, but none for these dates"
    return out


def main(cfg_path, gauges_path, out_path):
    cfg = json.loads(Path(cfg_path).read_text())
    gauges = json.loads(Path(gauges_path).read_text()).get("features", [])
    events = []
    for ev in cfg["events"]:
        try:
            events.append(fetch_event(ev, gauges))
        except Exception as e:  # noqa: BLE001 - one event failing shouldn't stop the rest
            events.append({"id": ev["id"], "name": ev["name"], "lat": ev["lat"], "lon": ev["lon"], "error": str(e)[:200]})
    ok = [e for e in events if e.get("series")]
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps({"fetched": now, "events": events}, separators=(",", ":")))
    n_other = sum(len(e.get("others") or []) for e in ok)
    print(f"Recorded floods: {len(ok)} of {len(events)} with hourly readings, {n_other} more gauges along the rivers "
          f"({', '.join(e['id'] + ':' + e.get('ts_name', '?').split('.')[-2] if '.' in e.get('ts_name', '') else e['id'] for e in ok)})")
    print("Other gauges per flood: " + "; ".join(f"{e['id']}: {', '.join(o['name'] for o in e['others'])}" for e in ok if e.get("others")))
    for e in events:
        if e.get("error"):
            print(f"warning: {e['id']}: {e['error']}")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
