"""Add recorded hourly sea levels to the recorded floods near the coast.

Usage: python pipeline/fetch_sealevels.py <events.json>   (updated in place)

For each recorded flood with readings, finds the nearest of the Australian
tide gauges in the University of Hawaii Sea Level Center (UHSLC) archive
within 150 km, reads its hourly sea levels for the flood's dates (research
quality data, or fast-delivery data where that is all there is) from one of
the public ERDDAP servers that carry it, and stores them as metres above
that gauge's mean sea level for the year (mean sea level is close to AHD).
The app then uses the real sea level, tides and surge included, as the sea
during the recorded flood instead of an idealised tide.

Adds to each event: sea: {station, km, source, series: [[hours from the
flood's start, metres above mean sea level], ...]}.
"""
import csv
import datetime as dt
import io
import json
import math
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


def sea_for(ev, fetch=erddap):
    st, d = nearest(ev["lat"], ev["lon"])
    if not st:
        return None, f"no tide gauge within {MAX_KM} km ({d:.0f} km)"
    start = dt.datetime.fromisoformat(ev["start"])
    end = start + dt.timedelta(hours=max(r[0] for r in ev["series"]) + 24)
    year0 = dt.datetime(start.year, 1, 1, tzinfo=dt.timezone.utc)
    why = []
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
    return None, "; ".join(why)[:300]


def main(path):
    p = Path(path)
    data = json.loads(p.read_text())
    done, notes = [], []
    for ev in data.get("events", []):
        if not ev.get("series") or not ev.get("start"):
            continue
        sea, why = sea_for(ev)
        if sea:
            ev["sea"] = sea
            done.append(f"{ev['id']} ({sea['station']}, {len(sea['series'])} h)")
        elif why and "no tide gauge" not in why:
            notes.append(f"{ev['id']}: {why}")
    p.write_text(json.dumps(data, separators=(",", ":")))
    print(f"Sea levels: {len(done)} recorded floods: {', '.join(done)}")
    for n in notes[:5]:
        print(f"warning: {n}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
