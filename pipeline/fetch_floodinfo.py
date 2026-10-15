"""Fetch Bureau of Meteorology flood class levels and current flood warnings.

Usage: python pipeline/fetch_floodinfo.py <out_dir>

Writes into <out_dir>:
  floodclass.json  {bureau station number: {minor, moderate, major, zero, source}}
                   levels are metres on the gauge board; zero is the gauge
                   zero in metres AHD where the Bureau publishes it
  warnings.json    {fetched, warnings: [{state, title, link, published}]}

Flood class tables are published as web pages per state (Victoria's are
the most complete and include gauge zero); warnings come from the Bureau's
per-state warnings RSS feeds. Either part failing leaves the other intact.
"""
import datetime as dt
import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

UA = {"User-Agent": "brisbane-flood-explorer (github.com/ghedwards/brisbane-flood-explorer)",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-AU,en;q=0.8"}

FLOODCLASS_PAGES = [
    "https://www.bom.gov.au/vic/flood/floodclass_north.shtml",
    "https://www.bom.gov.au/vic/flood/floodclass_south.shtml",
    # other states, where the Bureau publishes a comparable table
    "https://www.bom.gov.au/nsw/flood/floodclass.shtml",
    "https://www.bom.gov.au/qld/flood/floodclass.shtml",
    "https://www.bom.gov.au/sa/flood/floodclass.shtml",
    "https://www.bom.gov.au/wa/flood/floodclass.shtml",
    "https://www.bom.gov.au/tas/flood/floodclass.shtml",
    "https://www.bom.gov.au/nt/flood/floodclass.shtml",
]

FTP_FWO = "ftp://ftp.bom.gov.au/anon/gen/fwo/"

WARNING_FEEDS = {
    "NSW": "https://www.bom.gov.au/fwo/IDZ00054.warnings_nsw.xml",
    "NT": "https://www.bom.gov.au/fwo/IDZ00055.warnings_nt.xml",
    "QLD": "https://www.bom.gov.au/fwo/IDZ00056.warnings_qld.xml",
    "SA": "https://www.bom.gov.au/fwo/IDZ00057.warnings_sa.xml",
    "TAS": "https://www.bom.gov.au/fwo/IDZ00058.warnings_tas.xml",
    "VIC": "https://www.bom.gov.au/fwo/IDZ00059.warnings_vic.xml",
    "WA": "https://www.bom.gov.au/fwo/IDZ00060.warnings_wa.xml",
}


def http_text(url, retries=2):
    last = None
    for i in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            last = e
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
        time.sleep(2 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


class Rows(HTMLParser):
    """Collect the text of every table row's cells."""

    def __init__(self):
        super().__init__()
        self.rows, self.row, self.cell = [], None, None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.row is not None and self.cell is not None:
            self.row.append(" ".join("".join(self.cell).split()))
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def level(text):
    """A flood class level in metres, or None (n/a, flows in m3/s, blank)."""
    t = (text or "").strip().lower()
    if not t or "m3" in t or "/s" in t or "n/a" in t:
        return None
    m = re.fullmatch(r"(-?\d+(?:\.\d+)?)\s*m?", t)
    return float(m.group(1)) if m else None


def parse_floodclass(page_html, source):
    """Rows of Bureau No. | AWRC No. | Station | Minor | Moderate | Major | Gauge Zero."""
    p = Rows()
    p.feed(page_html)
    out = {}
    header = None
    for row in p.rows:
        low = [c.lower() for c in row]
        if any("minor" in c for c in low) and any("major" in c for c in low):
            header = low
            continue
        if not header or len(row) < 6 or not re.fullmatch(r"\d{4,7}", row[0] or ""):
            continue
        col = {name: next((i for i, c in enumerate(header) if name in c), None)
               for name in ("station", "minor", "moderate", "major", "zero")}
        get = lambda k: row[col[k]] if col[k] is not None and col[k] < len(row) else ""
        rec = {"station": get("station") or None, "minor": level(get("minor")), "moderate": level(get("moderate")),
               "major": level(get("major")), "zero": level(get("zero")), "source": source}
        if rec["minor"] is None and rec["moderate"] is None and rec["major"] is None:
            continue
        out[str(int(row[0]))] = rec
    return out


def parse_rss(xml_text, state):
    out = []
    for item in re.findall(r"<item>(.*?)</item>", xml_text, flags=re.S):
        get = lambda tag: html.unescape((re.search(rf"<{tag}>(.*?)</{tag}>", item, flags=re.S) or [None, ""])[1]).strip()
        title = get("title")
        if "flood" not in title.lower():
            continue
        out.append({"state": state, "title": title, "link": get("link"), "published": get("pubDate")})
    return out


def main(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    classes, notes = {}, []
    for url in FLOODCLASS_PAGES:
        try:
            got = parse_floodclass(http_text(url), url)
            classes.update(got)
            notes.append(f"{url.split('/')[3]}:{url.rsplit('/', 1)[1]}={len(got)}")
        except Exception as e:  # noqa: BLE001 - a missing page is normal
            notes.append(f"{url.split('/')[3]}:{url.rsplit('/', 1)[1]}=none ({str(e)[-60:]})")
    warnings, werr = [], []
    via = {}
    for st, url in WARNING_FEEDS.items():
        # the Bureau's website refuses many cloud servers; the same feeds
        # are mirrored on its public FTP server
        for src in (url, FTP_FWO + url.rsplit("/", 1)[1]):
            try:
                warnings += parse_rss(http_text(src), st)
                via[st] = "ftp" if src.startswith("ftp") else "web"
                break
            except Exception as e:  # noqa: BLE001
                err = f"{st}: {e}"
        else:
            werr.append(err)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    if classes:
        (out / "floodclass.json").write_text(json.dumps(classes, separators=(",", ":")))
    (out / "warnings.json").write_text(json.dumps({"fetched": now, "ok": len(werr) < len(WARNING_FEEDS),
                                                   "errors": werr, "warnings": warnings}, separators=(",", ":")))
    print(f"Flood info: {len(classes)} gauges with flood class levels ({', '.join(notes)}); "
          f"{len(warnings)} current flood warnings; {len(werr)} feed errors; feeds via {via or 'none'}")
    for e in werr[:2]:
        print("warning:", e)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
