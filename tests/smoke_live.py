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

        # ---- Australia-wide view (the default)
        try:
            page.wait_for_function("window.__floodStatus && window.__floodStatus.national"
                                   " && window.__floodStatus.national.loaded && window.__floodStatus.mode === 'map'",
                                   timeout=60_000)
            nat = status().get("national", {})
            note("notice", f"National view: {json.dumps(nat)}")
            if not nat.get("gauges"):
                failures.append("the national view has no gauges")
        except Exception:
            failures.append(f"the national view did not load: {json.dumps(status())}")
        if page.evaluate("window.__floodOpenReport ? window.__floodOpenReport(0) : false"):
            page.wait_for_timeout(500)
            rep = (page.text_content("#reportBody") or "").strip().replace("\n", " ")
            note("notice", f"Report: {rep[:260]}")
        page.screenshot(path="smoke-national.png")
        if page.evaluate("window.__floodOpenDam ? window.__floodOpenDam('Wivenhoe') : false"):
            try:
                page.wait_for_function("window.__floodStatus.waterbodies && window.__floodStatus.waterbodies.ok !== undefined",
                                       timeout=30_000)
            except Exception:
                pass
            wb = status().get("waterbodies", {})
            dam = (page.text_content("#reportBody") or "").strip().replace("\n", " ")
            note("notice" if wb.get("ok") else "error", f"Dam report water history {json.dumps(wb)}: {dam[:300]}")
            if not wb.get("ok"):
                failures.append(f"dam report has no water history: {wb}")
            page.screenshot(path="smoke-dam.png")
        # NSW flood planning layer over Sydney's Parramatta River
        page.evaluate("window.__floodTestZoom && window.__floodTestZoom(-33.815, 151.0, 14)")
        page.evaluate("([n]) => window.__floodSetOverlay(n, true)", ["NSW flood planning areas (state)"])
        page.wait_for_timeout(8000)
        nsw = page.evaluate("window.__floodStatus.overlays['NSW flood planning areas (state)'] || null")
        note("notice" if nsw and nsw.get("features") else "error", f"NSW layer at Parramatta: {json.dumps(nsw)}")
        if not (nsw and nsw.get("features")):
            failures.append(f"NSW flood planning layer did not draw: {nsw}")
        page.screenshot(path="smoke-nsw.png")
        page.evaluate("([n]) => window.__floodSetOverlay(n, false)", ["NSW flood planning areas (state)"])
        for label, args in [("river", [-27.4741, 153.0305, {"kind": "river", "name": "Brisbane City"}]),
                            ("coast", [-27.37, 153.17, {"kind": "coast", "name": "Brisbane Bar"}])]:
            before_updates = status().get("overlayUpdates", 0)
            page.evaluate("([la, lo, o]) => { window.__floodModelHere(la, lo, o); }", args)
            try:
                page.wait_for_function("window.__floodStatus.local && (window.__floodStatus.local.ok === true"
                                       " || window.__floodStatus.local.ok === false)", timeout=120_000)
                page.wait_for_function(f"window.__floodStatus.overlayUpdates > {before_updates}", timeout=20_000)
            except Exception:
                pass
            loc = status().get("local", {})
            stats = page.inner_text("#stats").replace("\n", " ")
            note("notice" if loc.get("ok") else "error", f"Model {label}: {json.dumps(loc)} | {stats[:160]}")
            if not loc.get("ok"):
                failures.append(f"on-demand {label} model failed: {loc}")
            page.screenshot(path=f"smoke-model-{label}.png")

        # ---- detailed Brisbane model
        page.select_option("#area", "brisbane")
        page.evaluate("window.__floodOpenPanel('panel-scenario')")
        try:
            page.wait_for_function(
                "window.__floodStatus && window.__floodStatus.area === 'brisbane' && window.__floodStatus.mode === 'map'"
                " && window.__floodStatus.overlayUpdates > 0 && window.__floodStatus.tilesLoaded > 4",
                timeout=60_000,
            )
        except Exception:
            failures.append(f"street map did not finish loading: {json.dumps(status())}")

        s1 = status()
        fhs = s1.get("floodhub") or {}
        fh_text = (page.text_content("#floodhubBody") or "").strip().replace("\n", " ")
        note("notice", f"Flood Hub panel ({json.dumps(fhs)}): {fh_text[:200]}")
        if not fhs.get("loaded"):
            failures.append("the Flood Hub forecast file did not load")
        area = page.eval_on_selector("#area", "e => e.options[e.selectedIndex].textContent")
        stats_2011 = page.inner_text("#stats").replace("\n", " ")

        if s1.get("mode") == "map":
            box = page.locator("#lmap").bounding_box()
            page.mouse.click(box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.55)
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
            page.evaluate("window.__floodOpenPanel('panel-layers')")
            page.check("#moveGauge")
            page.mouse.click(box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.55)
            page.wait_for_timeout(500)
            moved = page.inner_text("#readout")
            note("notice", f"Tap with gauge moving on: {moved}")
            if "Gauge moved" in moved and "dry" in moved:
                failures.append(f"gauge moved onto dry ground: {moved}")
            page.uncheck("#moveGauge")
            page.evaluate("window.__floodOpenPanel('panel-scenario')")

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

            # council flood layers: zoom to the city and switch each one on
            page.evaluate("window.__floodTestZoom && window.__floodTestZoom(-27.47, 153.02, 15)")
            page.wait_for_timeout(2000)
            ov = page.evaluate("Object.keys(window.__floodStatus.overlays || {})")
            if not ov:
                failures.append("no council flood layers were offered")
            for name in ov:
                page.evaluate("([n]) => window.__floodSetOverlay(n, true)", [name])
                page.wait_for_timeout(8000)
                st = page.evaluate("n => window.__floodStatus.overlays[n]", name)
                note("notice", f"Layer {name}: {st['features']} features, {st['errors']} errors")
                if st["features"] == 0:
                    failures.append(f"council layer '{name}' drew no features ({st['errors']} errors)")
                safe = "".join(ch if ch.isalnum() else "-" for ch in name.lower())[:40]
                page.screenshot(path=f"smoke-layer-{safe}.png")
                page.evaluate("([n]) => window.__floodSetOverlay(n, false)", [name])
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
