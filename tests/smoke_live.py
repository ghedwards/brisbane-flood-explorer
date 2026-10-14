#!/usr/bin/env python3
"""Load the published site in a real browser and check the interactive map.

Usage: python tests/smoke_live.py https://ghedwards.github.io/brisbane-flood-explorer/

Run by CI after each deploy. Results are printed as GitHub annotations, and a
screenshot is saved to smoke.png.
"""
import json
import sys

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000/"


def note(level: str, msg: str) -> None:
    print(f"::{level}::{msg}")


def main() -> int:
    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(URL, wait_until="networkidle", timeout=90_000)

        status = lambda: page.evaluate("window.__floodStatus || {}")
        try:
            page.wait_for_function(
                "window.__floodStatus && window.__floodStatus.mode === 'map'"
                " && window.__floodStatus.overlayUpdates > 0 && window.__floodStatus.tilesLoaded > 4",
                timeout=60_000,
            )
        except Exception:
            failures.append(f"street map did not finish loading: {json.dumps(status())}")

        s1 = status()
        area = page.eval_on_selector("#area", "e => e.options[e.selectedIndex].textContent")
        stats_2011 = page.inner_text("#stats").replace("\n", " ")

        if s1.get("mode") == "map":
            box = page.locator("#lmap").bounding_box()
            page.mouse.click(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.3)
            try:
                page.wait_for_selector(".leaflet-popup-content", timeout=5_000)
                popup = page.inner_text(".leaflet-popup-content")
            except Exception:
                popup = ""
                failures.append("tapping the map did not open a popup")

            before = status()
            page.click("#events .chip:nth-child(5)")  # 1893 peak
            try:
                page.wait_for_function(
                    f"window.__floodStatus.overlayUpdates > {before.get('overlayUpdates', 0)}", timeout=10_000)
            except Exception:
                failures.append("changing the scenario did not redraw the flood layer")
            page.wait_for_timeout(500)
            after = status()
            if after.get("floodPixels", 0) <= before.get("floodPixels", 0):
                failures.append(f"1893 should flood more than 2011: {before.get('floodPixels')} -> {after.get('floodPixels')}")
            # moving the gauge onto a small creek must not be possible
            page.check("#moveGauge")
            page.mouse.click(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.3)
            page.wait_for_timeout(500)
            moved = page.inner_text("#readout")
            note("notice", f"Tap with gauge moving on: {moved}")
            if "Gauge moved" in moved and "dry" in moved:
                failures.append(f"gauge moved onto dry ground: {moved}")
            page.uncheck("#moveGauge")

            # every basemap in the switcher should load tiles at Brisbane
            names = page.evaluate("Object.keys(window.__floodStatus.basemaps || {})")
            for name in names:
                page.evaluate("n => window.__floodSetBasemap(n)", name)
                page.wait_for_timeout(5000)
                st = page.evaluate("n => window.__floodStatus.basemaps[n]", name)
                note("notice", f"Basemap {name}: {st['loaded']} tiles loaded, {st['errors']} errors")
                if st["loaded"] == 0:
                    failures.append(f"basemap '{name}' loaded no tiles ({st['errors']} errors)")
                safe = "".join(ch if ch.isalnum() else "-" for ch in name.lower())
                page.screenshot(path=f"smoke-{safe}.png")
            if names:
                page.evaluate("n => window.__floodSetBasemap(n)", names[0])
            page.click("#events .chip:nth-child(3)")  # back to 2011
            page.wait_for_timeout(800)
        else:
            popup, after = "", s1

        page.screenshot(path="smoke.png", full_page=False)
        browser.close()

    errors = [e for e in errors if "favicon" not in e]
    if errors:
        failures.append("page errors: " + " | ".join(errors[:5]))

    note("notice", f"Area: {area}. 2011 stats: {stats_2011}")
    note("notice", f"Map status: {json.dumps(s1)}; after 1893: flood pixels {after.get('floodPixels')}")
    if popup:
        note("notice", f"Popup: {popup}")
    for f in failures:
        note("error", f)
    if not failures:
        note("notice", "Interactive map smoke test passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
