"""Workers by place of work for each SA2 (ABS 2021 Census, Working Population Profile).

Usage: python pipeline/fetch_workers.py <out.json>

Downloads the 2021 Census Working Population Profile DataPack for SA2s
(all of Australia; CC BY 4.0) and keeps, for each SA2, the number of people
who work there (the total of table W01, 'Tot_P' or similar). The app spreads
each SA2's workers across the workplaces OpenStreetMap shows in it (offices,
shops, factories, schools, hospitals and public buildings) to count workers
whose workplace floods: daytime exposure, alongside the residents counted
from the SA1 population.

Writes {source, fetched, table, workers: {sa2_code: count}}.
"""
import csv
import datetime as dt
import io
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

UA = {"User-Agent": "Mozilla/5.0 (compatible; brisbane-flood-explorer; github.com/ghedwards/brisbane-flood-explorer)"}
BASE = "https://www.abs.gov.au/census/find-census-data/datapacks/download/"
NAMES = ["2021_WPP_SA2_for_AUS_short-header.zip", "2021_WPP_SA2_for_AUS_long-header.zip",
         "2021_WPP_all_for_AUS_short-header.zip"]


def download():
    why = []
    for n in NAMES:
        try:
            req = urllib.request.Request(BASE + n, headers=UA)
            with urllib.request.urlopen(req, timeout=300) as r:
                body = r.read()
            if body[:2] == b"PK":
                return n, body
            why.append(f"{n}: not a zip ({body[:40]!r})")
        except Exception as e:  # noqa: BLE001
            why.append(f"{n}: {str(e)[:80]}")
    raise RuntimeError("; ".join(why))


def total_column(header):
    """The column with total persons: 'Tot_P' or 'Total_Persons' style."""
    for pat in (r"^tot_p$", r"^total_persons$", r"^tot.*_p$", r"^total.*persons?$"):
        for i, h in enumerate(header):
            if re.match(pat, h.strip(), re.I):
                return i
    return None


def workers_from_zip(body):
    z = zipfile.ZipFile(io.BytesIO(body))
    csvs = [n for n in z.namelist() if n.lower().endswith(".csv") and "sa2" in n.lower()]
    # W01 first (the profile's first table), then any table with a total column
    csvs.sort(key=lambda n: (0 if re.search(r"w01", n, re.I) else 1, n))
    for name in csvs:
        rows = list(csv.reader(io.StringIO(z.read(name).decode("utf-8-sig", "replace"))))
        if len(rows) < 100:
            continue
        header = rows[0]
        ti = total_column(header)
        ci = next((i for i, h in enumerate(header) if re.match(r"^sa2_code", h.strip(), re.I)), 0)
        if ti is None:
            continue
        out = {}
        for r in rows[1:]:
            try:
                out[r[ci].strip()] = int(float(r[ti]))
            except (ValueError, IndexError):
                continue
        if len(out) > 1000:
            return name.rsplit("/", 1)[-1], header[ti], out
    raise RuntimeError(f"no SA2 table with a total persons column among {len(csvs)} files")


def main(out_path):
    name, body = download()
    table, col, workers = workers_from_zip(body)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps({
        "source": "ABS 2021 Census Working Population Profile (place of work), SA2, CC BY 4.0",
        "file": name, "table": f"{table} {col}", "fetched": now, "workers": workers}, separators=(",", ":")))
    print(f"Workers: {len(workers)} SA2s, {sum(workers.values()):,} workers ({table} {col})")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    try:
        main(sys.argv[1])
    except Exception as e:  # noqa: BLE001 - the app falls back to counting workplaces
        print(f"Workers: unavailable ({str(e)[:300]})")
