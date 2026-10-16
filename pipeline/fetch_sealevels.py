"""Add recorded hourly sea levels to the recorded floods near the coast.

Usage: python pipeline/fetch_sealevels.py <events.json> <sea.json>
       python pipeline/fetch_sealevels.py merge <events.json> <sea.json> <out.json>

The first form writes {event id: sea} for the recorded floods; the second
adds them to the events file the app reads (kept apart so the slow tide
gauge downloads have their own build step, cache and time limit).

For each recorded flood with readings, finds the nearest of the Australian
tide gauges in the University of Hawaii Sea Level Center (UHSLC) archive
within 150 km, reads its hourly sea levels for the flood's dates (research
quality data, or fast-delivery data where that is all there is) from one of
the public ERDDAP servers that carry it, and stores them as metres above
that gauge's mean sea level for the year (mean sea level is close to AHD).
The app then uses the real sea level, tides and surge included, as the sea
during the recorded flood instead of an idealised tide.

Queensland's own tide gauges (Maritime Safety Queensland, archived
10-minute readings on the state's open data portal, CC BY 4.0) are used
where one is nearer than a UHSLC gauge; their heights are above the port's
lowest astronomical tide, so they too are taken relative to the year's
mean.

Adds to each event: sea: {station, km, source, series: [[hours from the
flood's start, metres above mean sea level], ...]}.
"""
import csv
import datetime as dt
import io
import json
import math
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

UA = {"User-Agent": "brisbane-flood-explorer (github.com/ghedwards/brisbane-flood-explorer)"}
# UHSLC tide gauges in Australia (mainland and Tasmania)
STATIONS = [
    ("Spring Bay", 335, -42.55, 147.933), ("Portland", 129, -38.343, 141.613), ("Esperance", 176, -33.867, 121.9),
    ("Fort Denison (Sydney)", 333, -33.85, 151.233), ("Thevenard", 128, -32.15, 133.64), ("Fremantle", 175, -32.05, 115.733),
    ("Brisbane", 331, -27.367, 153.167), ("Bundaberg", 332, -24.833, 152.35), ("Carnarvon", 167, -24.883, 113.617),
    ("Port Hedland", 169, -20.317, 118.567), ("Townsville", 334, -19.25, 146.833), ("Broome", 166, -18.0, 122.217),
    ("Darwin", 168, -12.467, 130.85), ("Booby Island", 336, -10.6, 141.917),
]
# (server, dataset) pairs carrying UHSLC hourly data, tried in order
SOURCES = [
    ("https://uhslc.soest.hawaii.edu/erddap", "global_hourly_rqds"),
    ("https://pae-paha.pacioos.hawaii.edu/erddap", "uhslc_global_hourly_rqds"),
    ("https://osmc.noaa.gov/erddap", "global_hourly_rqds"),
    ("https://uhslc.soest.hawaii.edu/erddap", "global_hourly_fast"),
    ("https://erddap.emodnet-physics.eu/erddap", "UHSLC_global_hourly_fast"),
]
MAX_KM = 150
# Maritime Safety Queensland tide gauges with archived readings (approximate
# gauge positions); the open data portal's datasets are matched by name
MSQ_SITES = [
    ("Southport", -27.96, 153.42), ("Brisbane Bar", -27.37, 153.17), ("Mooloolaba", -26.68, 153.13),
    ("Urangan", -25.30, 152.91), ("Bundaberg", -24.76, 152.40), ("Gladstone", -23.83, 151.25),
    ("Port Alma", -23.58, 150.86), ("Rosslyn Bay", -23.16, 150.79), ("Mackay", -21.10, 149.23),
    ("Shute Harbour", -20.29, 148.79), ("Bowen", -20.02, 148.25), ("Townsville", -19.25, 146.83),
    ("Cardwell", -18.27, 146.03), ("Clump Point", -17.85, 146.12), ("Mourilyan Harbour", -17.60, 146.12),
    ("Cairns", -16.92, 145.78), ("Cooktown", -15.46, 145.25), ("Weipa", -12.67, 141.86), ("Karumba", -17.49, 140.83),
]
QLD_CKAN = "https://www.data.qld.gov.au/api/3/action/package_search"
AEST = dt.timezone(dt.timedelta(hours=10))


def km(lat1, lon1, lat2, lon2):
    dy = (lat1 - lat2) * 110.574
    dx = (lon1 - lon2) * 111.32 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dx, dy)


def nearest(lat, lon):
    best = min(STATIONS, key=lambda s: km(lat, lon, s[2], s[3]))
    d = km(lat, lon, best[2], best[3])
    return (best, d) if d <= MAX_KM else (None, d)


def erddap(server, ds, sid, t0, t1):
    """[(datetime UTC, metres)] from an ERDDAP tabledap CSV query."""
    q = (f"{server}/tabledap/{ds}.csv?time,sea_level&uhslc_id={sid}"
         f"&time>={t0.strftime('%Y-%m-%dT%H:%M:%SZ')}&time<={t1.strftime('%Y-%m-%dT%H:%M:%SZ')}")
    req = urllib.request.Request(urllib.parse.quote(q, safe=":/?&=,>"), headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode("utf-8", "replace")
    rows = list(csv.reader(io.StringIO(text)))
    out = []
    for row in rows[2:]:   # header, then units
        try:
            t = dt.datetime.fromisoformat(row[0].replace("Z", "+00:00"))
            v = float(row[1])
        except (ValueError, IndexError):
            continue
        if math.isfinite(v) and abs(v) < 30000:
            out.append((t, v / 1000.0))   # mm -> m
    return out


_msq_cache = None


def msq_catalogue():
    """{site name: [resources]} for the archived MSQ tide gauge datasets."""
    global _msq_cache
    if _msq_cache is None:
        q = urllib.parse.urlencode({"q": "tide gauge archived interval recordings", "rows": 100})
        req = urllib.request.Request(f"{QLD_CKAN}?{q}", headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r:
            res = json.loads(r.read()).get("result", {}).get("results", [])
        _msq_cache = {}
        for pkg in res:
            title = pkg.get("title") or ""
            if "archived" not in title.lower():
                continue
            site = re.split(r"\s+tide gauge", title, flags=re.I)[0].strip()
            _msq_cache[site.lower()] = pkg.get("resources") or []
    return _msq_cache


def parse_levels(text):
    """[(datetime UTC, metres)] from an MSQ readings file, whatever its
    layout: each line with a date-time and a level (times are AEST)."""
    out = []
    pats = [(re.compile(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})"), "ymd"),
            (re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})\s+(\d{1,2}):(\d{2})"), "dmy"),
            # MSQ archives: DDMMYYYYHHMM, then the level (e.g. 010120170000  0.902)
            (re.compile(r"^\s*(\d{2})(\d{2})((?:19|20)\d{2})(\d{2})(\d{2})\b"), "dmy"),
            (re.compile(r"\b((?:19|20)\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\b"), "ymd")]
    for line in text.splitlines():
        for pat, order in pats:
            m = pat.search(line)
            if not m:
                continue
            g = [int(x) for x in m.groups()]
            y, mo, d = (g[0], g[1], g[2]) if order == "ymd" else (g[2], g[1], g[0])
            try:
                t = dt.datetime(y, mo, d, g[3] % 24, g[4], tzinfo=AEST).astimezone(dt.timezone.utc)
            except ValueError:
                break
            rest = line[m.end():]
            for tok in re.split(r"[,\s;]+", rest):
                try:
                    v = float(tok)
                except ValueError:
                    continue
                if -3 < v < 12 and v != -99:
                    out.append((t, v))
                break
            break
    return out


_msq_years = {}
_msq_budget = {"until": None}


def msq_year(site, year):
    """Readings for one MSQ site and year, or [] if not published (each file
    is read once per run; downloads stop after the time budget)."""
    key = (site.lower(), year)
    if key in _msq_years:
        return _msq_years[key]
    import time
    if _msq_budget["until"] is None:
        _msq_budget["until"] = time.time() + 480
    if time.time() > _msq_budget["until"]:
        raise RuntimeError("time budget for Queensland files used up")
    _msq_years[key] = rows = _msq_year(site, year)
    return rows


def _msq_year(site, year):
    cat = msq_catalogue()
    resources = cat.get(site.lower(), [])
    if not resources:
        raise RuntimeError(f"no dataset named for {site} among {len(cat)} ({', '.join(list(cat)[:6])})")
    pick = [r for r in resources if str(year) in f"{r.get('name', '')} {r.get('url', '')}"
            and (r.get("format") or "").lower() in ("csv", "txt", "zip", "")]
    if not pick:
        names = "; ".join(f"{r.get('name', '')} [{r.get('format', '')}]" for r in resources[:4])
        raise RuntimeError(f"no {year} file among {len(resources)} ({names})")
    for r in pick[:2]:
        req = urllib.request.Request(r["url"], headers=UA)
        body, ctype = b"", ""
        for attempt in range(3):   # the portal sometimes answers empty: wait and retry
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read()
                ctype = resp.headers.get("Content-Type", "")
            if body:
                break
            import time
            time.sleep(10 * (attempt + 1))
        if body[:2] == b"PK":
            import zipfile
            z = zipfile.ZipFile(io.BytesIO(body))
            body = b"\n".join(z.read(n) for n in z.namelist() if not n.endswith("/"))
        text = body.decode("utf-8", "replace")
        rows = parse_levels(text)
        if len(rows) > 1000:
            return rows
        first = " | ".join(ln for ln in text.splitlines()[:6] if ln.strip())[:300]
        raise RuntimeError(f"{len(rows)} readings parsed from {r.get('name', '')} ({len(body)} bytes, {ctype}, {r.get('url', '')[-60:]}; starts: {first})")
    return []


def from_readings(year_rows, start, end):
    """Hourly series relative to the year's mean over the flood's dates."""
    if len(year_rows) < 24 * 60:
        return None
    mean = sum(v for _, v in year_rows) / len(year_rows)
    bins = {}
    for t, v in year_rows:
        if start - dt.timedelta(hours=1) <= t <= end:
            bins.setdefault(math.floor((t - start).total_seconds() / 3600), []).append(v - mean)
    series = [[h, round(sum(vs) / len(vs), 3)] for h, vs in sorted(bins.items())]
    return series if len(series) >= 12 else None


def msq_for(ev, start, end, msq=msq_year):
    site = min(MSQ_SITES, key=lambda s: km(ev["lat"], ev["lon"], s[1], s[2]))
    d = km(ev["lat"], ev["lon"], site[1], site[2])
    if d > MAX_KM:
        return None, d, None
    try:
        rows = msq(site[0], start.year)
        if end.year != start.year:
            rows = rows + msq(site[0], end.year)
    except Exception as e:  # noqa: BLE001
        return None, d, f"MSQ {site[0]}: {str(e)[:400]}"
    series = from_readings(rows, start, end)
    if not series:
        return None, d, f"MSQ {site[0]}: no readings for those dates"
    return {"station": f"{site[0]} (Maritime Safety Queensland)", "km": round(d, 1),
            "source": "Maritime Safety Queensland archived tide gauge readings", "series": series}, d, None


def sea_for(ev, fetch=erddap, msq=msq_year):
    st, d = nearest(ev["lat"], ev["lon"])
    start = dt.datetime.fromisoformat(ev["start"])
    end = start + dt.timedelta(hours=max(r[0] for r in ev["series"]) + 24)
    # a Queensland gauge only where no UHSLC gauge is near (their archived
    # files are large, slow downloads)
    qld = ev["lon"] > 137.9 and ev["lat"] > -29.2
    near_msq = min((km(ev["lat"], ev["lon"], s_[1], s_[2]) for s_ in MSQ_SITES), default=math.inf)
    want_q = qld and (not st or near_msq < d - 40)
    q, dq, why_q = msq_for(ev, start, end, msq) if want_q else (None, math.inf, None)
    if why_q:
        print(f"note: {ev['id']}: {why_q}", flush=True)
    if q and (not st or dq <= d):
        return q, None
    if not st:
        return (q, None) if q else (None, f"no tide gauge within {MAX_KM} km ({d:.0f} km)" + (f"; {why_q}" if why_q else ""))
    end = start + dt.timedelta(hours=max(r[0] for r in ev["series"]) + 24)
    year0 = dt.datetime(start.year, 1, 1, tzinfo=dt.timezone.utc)
    why = [why_q] if why_q else []
    for server, ds in SOURCES:
        try:
            year = fetch(server, ds, st[1], year0, year0.replace(year=start.year + 1))
            if len(year) < 24 * 60:
                why.append(f"{ds}: {len(year)} readings that year")
                continue
            mean = sum(v for _, v in year) / len(year)
            win = [(t, v) for t, v in year if start - dt.timedelta(hours=1) <= t <= end]
            if len(win) < 12:
                # the flood runs into the next year: read the window itself
                win = fetch(server, ds, st[1], start, end)
            series = sorted({math.floor((t - start).total_seconds() / 3600): round(v - mean, 3) for t, v in win}.items())
            if len(series) < 12:
                why.append(f"{ds}: {len(series)} hours in the flood")
                continue
            return {"station": st[0], "uhslc_id": st[1], "km": round(d, 1), "source": f"UHSLC {ds}",
                    "series": [[h, v] for h, v in series]}, None
        except Exception as e:  # noqa: BLE001 - try the next server
            why.append(f"{server.split('/')[2]}/{ds}: {str(e)[:60]}")
    if q:
        return q, None
    return None, "; ".join(why)[:300]


def main(events_path, out_path):
    data = json.loads(Path(events_path).read_text())
    done, notes, sea = [], [], {}
    for ev in data.get("events", []):
        if not ev.get("series") or not ev.get("start"):
            continue
        try:
            got, why = sea_for(ev)
        except Exception as e:  # noqa: BLE001 - one flood failing shouldn't stop the rest
            got, why = None, str(e)[:200]
        if got:
            sea[ev["id"]] = got
            done.append(f"{ev['id']} ({got['station']}, {len(got['series'])} h)")
            print(f"got: {done[-1]}", flush=True)
        elif why and "no tide gauge" not in why:
            notes.append(f"{ev['id']}: {why}")
        Path(out_path).write_text(json.dumps(sea, separators=(",", ":")))   # keep what's done so far
    Path(out_path).write_text(json.dumps(sea, separators=(",", ":")))
    print(f"Sea levels: {len(done)} recorded floods: {', '.join(done)}")
    for n in notes[:5]:
        print(f"warning: {n}")


def merge(events_path, sea_path, out_path):
    data = json.loads(Path(events_path).read_text())
    try:
        sea = json.loads(Path(sea_path).read_text())
    except (OSError, ValueError):
        sea = {}
    for ev in data.get("events", []):
        if ev.get("id") in sea:
            ev["sea"] = sea[ev["id"]]
    Path(out_path).write_text(json.dumps(data, separators=(",", ":")))


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "merge":
        merge(*sys.argv[2:])
    elif len(sys.argv) == 3:
        main(*sys.argv[1:])
    else:
        sys.exit(__doc__)
