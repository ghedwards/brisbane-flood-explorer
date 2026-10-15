#!/usr/bin/env python3
"""Load the published site in a real browser and check the interactive map.

Usage: python tests/smoke_live.py https://ghedwards.github.io/brisbane-flood-explorer/

Run by CI after each deploy. Results are printed as GitHub annotations, and a
screenshot is saved to smoke.png.
"""
import json
import os
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
            # fluid wheel zoom: zooms in around the cursor in small steps
            z0 = page.evaluate("window.__floodZoom()")
            page.mouse.move(640, 450)
            for _ in range(3):
                page.mouse.wheel(0, -120)
                page.wait_for_timeout(60)
            page.wait_for_timeout(1200)
            z1 = page.evaluate("window.__floodZoom()")
            print(f"Wheel zoom: {z0} -> {z1}")
            if not (z1 > z0 + 0.5 and z1 < z0 + 3):
                failures.append(f"smooth wheel zoom did not zoom in as expected: {z0} -> {z1}")
            page.mouse.move(640, 450)
            for _ in range(3):
                page.mouse.wheel(0, 120)
                page.wait_for_timeout(60)
            page.wait_for_timeout(1200)
            note("notice", f"National view: {json.dumps(nat)}")
            if not nat.get("gauges"):
                failures.append("the national view has no gauges")
        except Exception:
            failures.append(f"the national view did not load: {json.dumps(status())}")
        # zoomed out over Australia: the stitched water image and scaled DEA tiles
        page.evaluate("window.__floodTestZoom(-26.5, 134, 5)")
        name = "Water seen by satellite since 1987 (DEA)"
        page.evaluate("([n]) => window.__floodSetOverlay(n, true)", [name])
        page.wait_for_timeout(6000)
        st = page.evaluate("n => window.__floodStatus.overlays[n] || {}", name)
        if not st.get("image"):
            failures.append(f"national water image did not show at zoom 5: {st}")
        page.screenshot(path="smoke-z5-water.png")
        page.evaluate("([n]) => window.__floodSetOverlay(n, false)", [name])
        dea = "Latest satellite, infrared (DEA)"
        page.evaluate("n => window.__floodSetBasemap(n)", dea)
        try:
            page.wait_for_function(f"window.__floodStatus.basemaps[{json.dumps(dea)}].loaded > 0", timeout=40_000)
        except Exception:
            pass
        bst = page.evaluate("n => window.__floodStatus.basemaps[n]", dea)
        if not bst or not bst.get("loaded"):
            failures.append(f"DEA basemap drew nothing at zoom 5: {bst}")
        page.screenshot(path="smoke-z5-dea.png")
        page.evaluate("n => window.__floodSetBasemap(n)", "Satellite (Esri)")
        print(f"Zoomed-out checks: water image {st}, DEA basemap {bst}")
        with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a") as fh:
            fh.write(f"- Zoom 5: water image {json.dumps(st)}; DEA basemap {json.dumps(bst)}\n")

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
            # coverage builds up over several runs, so a missing dam is a warning
            note("notice" if wb.get("ok") else "warning", f"Dam report water history {json.dumps(wb)}: {dam[:300]}")
            page.screenshot(path="smoke-dam.png")
            rep = status().get("report", {})
            if rep.get("count", 0) < 2:
                failures.append(f"expected two reports side by side: {rep}")
            print(f"Reports open: {rep}")
        # NSW flood planning layer over Sydney's Parramatta River
        page.evaluate("window.__floodTestZoom && window.__floodTestZoom(-33.815, 151.0, 14)")
        page.evaluate("([n]) => window.__floodSetOverlay(n, true)", ["NSW flood planning areas (state)"])
        page.wait_for_timeout(8000)
        nsw = page.evaluate("window.__floodStatus.overlays['NSW flood planning areas (state)'] || null")
        note("notice" if nsw and nsw.get("features") else "error", f"NSW layer at Parramatta: {json.dumps(nsw)}")
        if not (nsw and nsw.get("features")):
            failures.append(f"NSW flood planning layer did not draw: {nsw}")
        page.screenshot(path="smoke-nsw.png")
        # and zoomed out to the Sydney region, beyond the server's own limit
        before_nsw = nsw.get("features", 0) if nsw else 0
        page.evaluate("window.__floodTestZoom(-33.8, 151.0, 9)")
        page.wait_for_timeout(8000)
        nsw9 = page.evaluate("window.__floodStatus.overlays['NSW flood planning areas (state)'] || null")
        note("notice", f"NSW layer at zoom 9: {json.dumps(nsw9)}")
        if not (nsw9 and nsw9.get("features", 0) > before_nsw):
            failures.append(f"NSW flood planning layer did not draw zoomed out: {nsw9}")
        page.screenshot(path="smoke-nsw-z9.png")
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

        # ---- both modelled areas stay on the map; switch back to the first
        areas = page.evaluate("window.__floodAreaInfo ? window.__floodAreaInfo() : []")
        if len(areas) < 2 or not all(a["drawn"] for a in areas):
            failures.append(f"expected two drawn modelled areas: {areas}")
        if areas:
            page.evaluate("k => window.__floodActivateArea(k)", areas[0]["key"])
            page.wait_for_timeout(800)
            after_switch = page.evaluate("window.__floodAreaInfo()")
            if not after_switch[0]["active"]:
                failures.append(f"switching back to the first area failed: {after_switch}")
            stats_first = page.inner_text("#stats").replace("\n", " ")
            print(f"Areas: {areas}; after switch {after_switch}; stats {stats_first}")
            with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a") as fh:
                fh.write(f"- Areas: {json.dumps(after_switch)}\n")
        page.screenshot(path="smoke-two-areas.png")
        # ‹ › in the Scenario panel select the next modelled place; Places follows
        if len(areas) >= 2:
            act0 = [a["key"] for a in page.evaluate("window.__floodAreaInfo()") if a["active"]]
            page.locator("#scenarioNext").click()
            page.wait_for_timeout(800)
            act1 = [a["key"] for a in page.evaluate("window.__floodAreaInfo()") if a["active"]]
            sel = page.evaluate("window.__floodStatus.selectedPlace")
            if act0 == act1 or sel is None:
                failures.append(f"Scenario › did not move to the next flood scenario: {act0} -> {act1}, selected {sel}")
            print(f"Scenario step: {act0} -> {act1}, selected {sel}")

        # ---- a model started from a report shares the report's number,
        #      and the number can be hidden and shown from Places
        page.evaluate("window.__floodOpenPanel('panel-report')")
        dam_btn = page.locator(".report-card", has_text="Wivenhoe").locator(".js-model")
        if dam_btn.count():
            before_key = (status().get("local") or {}).get("key")
            dam_btn.first.click()
            try:
                page.wait_for_function(f"window.__floodStatus.local && window.__floodStatus.local.ok !== undefined"
                                       f" && window.__floodStatus.local.key !== {json.dumps(before_key)}", timeout=120_000)
                page.wait_for_function("window.__floodAreaInfo().every(a => a.drawn)", timeout=20_000)
            except Exception:
                pass
            places = page.evaluate("window.__floodPlaces()")
            linked = [p for p in places if p["report"] and p["area"]]
            if not linked or "Wivenhoe" not in (linked[0].get("reportName") or ""):
                failures.append(f"model from the Wivenhoe report did not share its number: {places}")
            else:
                n = linked[0]["n"]
                page.evaluate("n => window.__floodSetPlaceHidden(n, true)", n)
                hid = [p for p in page.evaluate("window.__floodPlaces()") if p["n"] == n][0]
                page.evaluate("n => window.__floodSetPlaceHidden(n, false)", n)
                shown = [p for p in page.evaluate("window.__floodPlaces()") if p["n"] == n][0]
                if hid["onMap"] or not hid["hidden"] or not shown["onMap"]:
                    failures.append(f"hiding/showing place {n} failed: hidden={hid} shown={shown}")
                print(f"Places: {places}; hide->{hid}; show->{shown}")
                # the Places panel reaches the report and the flood scenario
                page.evaluate("window.__floodSetPlacesCollapsed(false)")
                page.wait_for_timeout(300)
                if not page.locator("#areaList").is_visible():
                    failures.append("the Places list is not visible")
                page.evaluate("window.__floodOpenPanel('panel-layers')")  # close the report first
                page.locator(f"#placesCard [data-act='report'][data-n='{n}']").click()
                page.wait_for_timeout(400)
                rep_open = page.locator("#panel-report").is_visible() and page.locator("#areaList").is_visible()
                # choosing the row works like tapping its number on the map
                page.locator(f"#placesCard [data-num='{n}']").click()
                page.wait_for_timeout(800)
                if page.evaluate("window.__floodStatus.selectedPlace") != n:
                    failures.append(f"choosing place {n} in Places did not select it")
                scen_open = page.locator("#panel-scenario").is_visible() and page.locator("#areaList").is_visible()
                title = page.text_content("#scenarioPlace") or ""
                if not (rep_open and scen_open and title.startswith(f"{n}.")):
                    failures.append(f"Places actions failed: report panel {rep_open}, scenario panel {scen_open}, title {title!r}")
                print(f"Places actions: report {rep_open}, scenario {scen_open}, title {title!r}")
                with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a") as fh:
                    fh.write(f"- Places: {json.dumps(places)}\n")
            page.evaluate("window.__floodOpenPanel('panel-scenario')")
            page.screenshot(path="smoke-places.png")
        else:
            failures.append("no Wivenhoe report card to model from")

        # ---- detailed Brisbane model
        page.select_option("#area", "brisbane")
        page.evaluate("window.__floodOpenPanel('panel-scenario')")
        try:
            page.wait_for_function(
                "window.__floodStatus && window.__floodStatus.area === 'brisbane' && window.__floodStatus.mode === 'map'"
                " && window.__floodAreaInfo().some(a => a.key === 'brisbane' && a.active && a.drawn)",
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
            page.evaluate("window.__floodTapAt(-27.52, 152.98)")
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
            page.evaluate("window.__floodTapAt(-27.52, 152.98)")
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
                try:  # DEA's imagery server can take a while to render tiles
                    page.wait_for_function(f"window.__floodStatus.basemaps[{json.dumps(name)}].loaded > 0", timeout=25_000)
                except Exception:
                    pass
                st = page.evaluate("n => window.__floodStatus.basemaps[n]", name)
                note("notice", f"Basemap {name}: {st['loaded']} tiles loaded, {st['errors']} errors")
                if st["loaded"] == 0:
                    failures.append(f"basemap '{name}' loaded no tiles ({st['errors']} errors)")
                safe = "".join(ch if ch.isalnum() else "-" for ch in name.lower())
                page.screenshot(path=f"smoke-{safe}.png")
            if names:
                page.evaluate("n => window.__floodSetBasemap(n)", names[0])

            # council likelihood layers zoomed out: pre-rendered images
            page.evaluate("window.__floodTestZoom && window.__floodTestZoom(-27.47, 153.02, 11)")
            page.wait_for_timeout(1500)
            for name in ["Creek flooding likelihood (council)", "Overland flow likelihood (council)"]:
                page.evaluate("([n]) => window.__floodSetOverlay(n, true)", [name])
                page.wait_for_timeout(5000)
                st = page.evaluate("n => window.__floodStatus.overlays[n] || {}", name)
                note("notice" if st.get("image") else "error", f"Layer {name} at zoom 11: {json.dumps(st)}")
                if not st.get("image"):
                    failures.append(f"council layer '{name}' did not show its zoomed-out image")
                safe = "".join(ch if ch.isalnum() else "-" for ch in name.lower())[:30]
                page.screenshot(path=f"smoke-z11-{safe}.png")
                page.evaluate("([n]) => window.__floodSetOverlay(n, false)", [name])
            # council flood layers close in: switch each one on
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

        # ---- a pin dropped on the map becomes a place; modelling it keeps its number
        page.select_option("#area", "australia")
        page.wait_for_timeout(1500)
        # a gauge dot shows a popup with an add button instead of adding itself
        reps_before = (status().get("report") or {}).get("count", 0)
        if page.evaluate("window.__floodTapDot ? window.__floodTapDot('forecast', 5) : false"):
            page.wait_for_timeout(400)
            dot_popup = page.locator(".spot-popup .spot-name")
            reps_mid = (status().get("report") or {}).get("count", 0)
            page.screenshot(path="smoke-dot-popup.png")
            if not dot_popup.count() or reps_mid != reps_before:
                failures.append(f"gauge dot popup missing or added a report on tap: popup {dot_popup.count()}, reports {reps_before}->{reps_mid}")
            else:
                page.locator(".spot-popup .spot-add").first.click()
                page.wait_for_timeout(500)
                reps_after = (status().get("report") or {}).get("count", 0)
                if reps_after != reps_before + 1:
                    failures.append(f"adding a gauge from its popup did not open a report: {reps_before}->{reps_after}")
                print(f"Dot popup: reports {reps_before}->{reps_after}")
        # adding a place while another flood scenario is active switches the Scenario panel to it
        infos = page.evaluate("window.__floodAreaInfo()")
        if infos:
            page.evaluate("k => window.__floodActivateArea(k)", infos[0]["key"])
            page.wait_for_timeout(500)
        # tapping an empty spot offers a single add-a-place button
        page.evaluate("window.__floodTestZoom && window.__floodTestZoom(-27.62, 152.76, 11)")
        page.wait_for_timeout(800)
        page.evaluate("window.__floodTapAt(-27.62, 152.76)")
        page.wait_for_timeout(400)
        spot = page.locator(".spot-popup .spot-add")
        page.screenshot(path="smoke-spot-popup.png")
        if spot.count() and spot.first.is_visible():
            n_before = len(page.evaluate("window.__floodPlaces()"))
            spot.first.click()
            page.wait_for_timeout(300)
            places_now = page.evaluate("window.__floodPlaces()")
            pin_n = max(p["n"] for p in places_now if p["pin"]) if len(places_now) > n_before else page.evaluate("window.__floodAddPin(-27.62, 152.76)")
        else:
            failures.append("tapping an empty spot did not offer the add-a-place button")
            pin_n = page.evaluate("window.__floodAddPin(-27.62, 152.76)")
        before = (status().get("local") or {}).get("key")
        # its model options sit at the top of the Scenario panel, not in Places
        page.wait_for_timeout(300)
        if status().get("modelOptions") != pin_n or not page.locator("#scenarioModel [data-model='model']").is_visible():
            failures.append(f"Scenario panel did not offer to model new place {pin_n}: {status().get('modelOptions')}")
            page.evaluate("n => window.__floodPlaceAction('model', n)", pin_n)
        else:
            page.locator("#scenarioModel [data-model='model']").click()
        try:
            page.wait_for_function(f"window.__floodStatus.local && window.__floodStatus.local.ok !== undefined"
                                   f" && (window.__floodStatus.local.ok === false || window.__floodStatus.local.key !== {json.dumps(before)})",
                                   timeout=90_000)
        except Exception:
            pass
        pin_place = [p for p in page.evaluate("window.__floodPlaces()") if p["n"] == pin_n]
        print(f"Pinned place: {pin_place}")
        if not (pin_place and pin_place[0]["pin"] and pin_place[0]["area"]):
            failures.append(f"pinned place {pin_n} was not modelled under its own number: {pin_place}")
        page.screenshot(path="smoke-pin.png")

        # ---- extending a model rebuilds it over a 40 km window, keeping its number
        if pin_place and pin_place[0]["area"]:
            ext = None
            try:
                ext = page.evaluate("window.__floodExtendModel()")
                page.wait_for_function("window.__floodAreaInfo().every(a => a.drawn)", timeout=30_000)
            except Exception as e:
                ext = f"error: {e}"
            loc = status().get("local") or {}
            ext_place = [p for p in page.evaluate("window.__floodPlaces()") if p["n"] == pin_n]
            print(f"Extend model: {ext}; local {loc}; place {ext_place}")
            note("notice", f"Extended model: {json.dumps(loc)}")
            if ext is not True or loc.get("km") != 40 or not (ext_place and ext_place[0]["area"]):
                failures.append(f"extending the model failed: {ext}, {loc}, {ext_place}")
            page.screenshot(path="smoke-extended.png")

        # ---- studying an area pulls in gauges, dams and several models
        try:
            study = page.evaluate("window.__floodStudyArea(-28.95, 153.10, -28.65, 153.45)")
        except Exception as e:
            study = {"ok": False, "error": str(e)[:300]}
        print(f"Area study: {study}")
        note("notice", f"Area study near Lismore: {json.dumps(study)}")
        if not (study and study.get("ok") and study.get("models", 0) >= 2 and study.get("gauges", 0) >= 1):
            failures.append(f"area study failed: {study}")
        page.screenshot(path="smoke-study.png")
        studies = page.evaluate("window.__floodStudies ? window.__floodStudies() : []")
        stored = page.evaluate("(() => { try { return JSON.parse(localStorage.getItem('floodExplorer.studies.v1') || '[]').length; } catch (e) { return -1; } })()")
        rows = page.locator("#placesCard [data-study]").count()
        print(f"Studies: {studies}; stored {stored}; rows {rows}")
        if not (studies and studies[-1]["loaded"] and stored >= 1 and rows >= 1):
            failures.append(f"the studied area was not kept: {studies}, stored {stored}, rows {rows}")
        # the box tool itself: button arms it, a drag draws the box
        page.locator("#studyArea").click()
        armed = page.locator("#studyHint").is_visible()
        page.locator("#studyCancel").click()
        if not armed:
            failures.append("the Study an area button did not arm the box tool")

        # ---- every preset in the menu models successfully
        results = []
        for pre in page.evaluate("window.__floodPresets || []"):
            before = (status().get("local") or {}).get("key")
            page.select_option("#area", f"preset:{pre['id']}")
            try:
                page.wait_for_function(f"window.__floodStatus.local && window.__floodStatus.local.ok !== undefined"
                                       f" && (window.__floodStatus.local.ok === false || window.__floodStatus.local.key !== {json.dumps(before)})",
                                       timeout=90_000)
            except Exception:
                pass
            loc = status().get("local") or {}
            snap = status().get("snap") or {}
            stats = page.inner_text("#stats").replace("\n", " ") if loc.get("ok") else ""
            results.append({"id": pre["id"], "ok": bool(loc.get("ok")) and loc.get("key") != before,
                            "ms": loc.get("ms"), "error": loc.get("error"), "snap": snap, "stats": stats[:120]})
            page.screenshot(path=f"smoke-preset-{pre['id']}.png")
        bad = [r for r in results if not r["ok"]]
        with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a") as fh:
            fh.write("### Presets\n" + "".join(f"- {json.dumps(r)}\n" for r in results))
        print("Presets:", json.dumps(results))
        if bad:
            failures.append(f"{len(bad)} preset(s) failed: " + "; ".join(f"{r['id']}: {r['error']}" for r in bad))

        page.screenshot(path="smoke.png", full_page=False)
        browser.close()

    errors = [e for e in errors if "favicon" not in e]
    # A third-party service that drops a request shows up as a browser network
    # log (CORS-less error reply / ERR_FAILED); the app retries and reports it,
    # so note these rather than failing the build on someone else's outage
    network = [e for e in errors if "blocked by CORS policy" in e or e.startswith("Failed to load resource")]
    errors = [e for e in errors if e not in network]
    if network:
        note("warning", "Third-party network errors: " + " | ".join(network[:3])[:900])
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
    try:
        sys.exit(main())
    except Exception:
        import traceback
        tb = traceback.format_exc()
        # where it happened (last frames) and what Playwright was doing (first lines of the error)
        frames = [l.strip() for l in tb.splitlines() if l.strip().startswith(("File", "page.", "raise"))][-6:]
        err = [l for l in tb.splitlines() if l.strip() and not l.startswith(" ")][-1:]
        call_log = [l.strip() for l in tb.splitlines() if "waiting for" in l or "locator" in l.lower()][:4]
        print("::error::Smoke test crashed at " + " | ".join(frames)[:900])
        print("::error::Error: " + " | ".join(err + call_log)[:900])
        sys.exit(1)
