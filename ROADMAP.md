# Flood Explorer roadmap

Ideas for future refinement, roughly in order of value. Each says what it
would add, how it could be built from open data, and what to watch for.

## Needs an owner decision or access

- **Bureau of Meteorology flood warnings and flood class levels.** The app
  already shows them (Warnings panel, report flood classes, "Minor /
  Moderate / Major" buttons in Scenario), but the Bureau's website refuses
  requests from GitHub's servers (HTTP 403) and the warning files are not on
  its anonymous FTP server. Options:
  - a small scheduled job on a home or office computer (not a cloud
    server) that runs `flood floodinfo` and commits
    `floodclass.json` and `warnings.json` to the repo, or
  - a Bureau registered-user data feed, if one can be obtained.
- **Google Flood Hub forecasts.** Built in; add the API key as the repo
  secret `FLOOD_FORECASTING_API_KEY`.
- **Repository name.** Renaming to `flood-explorer` (Settings → General)
  moves the site to `ghedwards.github.io/flood-explorer/`. Repo links
  redirect; the old Pages address does not. Saved places carry over (same
  origin).

## Modelling

- **Flood routing, further.** Below the gauge the flood is routed
  (Muskingum–Cunge) with tributary inflows, measured ratings where the
  gauge has flow records, and tides; recorded floods follow other gauges
  upstream. Still simple: tributary floods copy the gauge's shape, places
  above the gauge without a recorded gauge are only shifted in time, and
  floodplain storage and dam releases aren't modelled. Ratings come from
  daily means, so they are extrapolated above the highest daily level.
- **Tides from predictions.** Recorded floods use recorded sea levels from
  Maritime Safety Queensland's or UHSLC's tide gauges within 150 km;
  scenarios use a 12.4-hour sine at spring-tide height. NSW's ocean tide
  records (Manly Hydraulics Laboratory) aren't open downloads, so NSW
  floods use Fort Denison. Tide predictions would allow "this week's
  highest tide".
  Some recent Maritime Safety Queensland yearly files (Cairns 2023,
  Mooloolaba 2022) download empty from the state portal; Cairns 2023 gets
  its sea level once they are fixed.
- **Design rainfall from the Bureau.** Storm mode currently offers example
  storms and links to the Bureau's design rainfall (IFD) tool. Fetching the
  IFD table for the model's location would give real "1% annual chance"
  storms; the Bureau's site blocks automated requests, so this needs a
  permitted access route (see above) or a pre-built national grid.
- **Stormwater, further.** Pipes take one typical rate of runoff from
  built-up land; council pipe network data (where published) and the
  local design storm would replace the single rate.
- **More levee data.** Levees come from OpenStreetMap and whatever
  `flood levees` collects. The NSW levee audit (about 130
  datasets listed on data.nsw.gov.au) is found, but SEED refuses the
  downloads from GitHub's servers (HTTP 403), and Victoria's open map
  server has no levee layer. Options: run the script from a home or office
  computer and commit `levees.geojson`, or ask DCCEEW NSW for an open
  service. Levee crest heights from surveys would beat crests read from
  the terrain. Overtopping fills the protected area to the river level
  without a volume limit, so short overtopping is overstated.
- **Recorded floods hour by hour.** `config/events.json` lists 17 floods;
  the build fetches hourly gauge readings from Water Data Online for those
  with a nearby station holding a level series for the dates. Lismore
  2022 and Rockhampton 2017 have no such station (their flood gauges
  aren't on Water Data Online); the Bureau's flood-warning gauge archive
  would fill them, through the same access route as above.
- **More recorded floods for the accuracy check.** Queensland flood lines,
  Brisbane City Council outlines and Victoria's flood history are built in.
  New South Wales doesn't publish recorded outlines as an open service
  (Northern Rivers 2022 would be the priority); Digital Earth Australia's
  satellite-observed water for specific flood dates is another option.
- **Victoria's statewide flood extent** (1% chance), if it becomes
  available as an open map service.

- **Hazard, further.** Flow speeds are estimated from depth and slope with
  fixed roughness; a two-dimensional model (or council hazard mapping
  where published, now shown for Rockhampton) would be better.
- **Dam operations.** Releases are entered by hand; reading published
  release schedules (Seqwater, WaterNSW) during an event would automate it.
- **Climate, further.** Storm rainfall uplift follows the draft ARR rates;
  the matching loss adjustments and per-region warming projections could
  be added.

## Impact

Done: buildings, people, roads, key sites, water above floor (with a floor
height setting), daytime workplaces, places cut off from a dry road out,
and when roads close and how long places stay cut off (flood over time).

- **Daytime counts, further.** Workers come from the ABS place-of-work
  counts by SA2; destination zones (much smaller) would be sharper, but
  their counts are only in TableBuilder, not an open download.
- **Evacuation centres.** OpenStreetMap has few mapped; councils publish
  lists on their disaster dashboards (often as PDFs or web pages). Open
  map services of designated centres would make routes far more useful.
- **Measured floor heights.** NSW councils publish floor level surveys for
  some flood studies on the NSW flood data portal (SEED), which refuses
  GitHub's servers; collecting them needs the home-computer route. Others
  aren't published openly.
- **Australian damage curves.** Damage uses the EU JRC global curve for
  Oceania homes. The NSW residential damage curves (2007 guideline) and
  Geoscience Australia's vulnerability functions are used in flood
  studies but not published as open numbers; worth adopting if they are.

## Data coverage

- **More council flood maps.** Now Brisbane, Gold Coast, Moreton Bay,
  Sunshine Coast, Logan, Rockhampton and Livingstone. Redland's city plan
  service needs a login; Ipswich, Townsville and Cairns publish maps only
  as PDFs or in their own map viewers. Check periodically for new open
  services, and for NSW and Victorian councils.
- **Rain radar detail.** RainViewer's free tier stops at zoom 7; a
  higher-resolution open radar source would help storm mode.

## Reliability and usability

- **Offline, further.** The site installs and works offline from what has
  been used. It could also save a chosen area in advance (pre-fetch its
  tiles and terrain) before heading somewhere without signal, and show
  how much is stored.
- **Real-phone testing**, especially iOS Safari, for panels, scrolling,
  the area-study box and touch gestures.
- **Accessibility, further.** Done: keyboard use of the map (Enter acts at
  the map centre), focusable numbered places, announced status messages,
  colours that differ by lightness. Still to do: a screen-reader summary of
  the flood map itself (beyond the counts), and an audit with a real
  screen reader.
- **Faster first load, further.** Scripts are minified, the flood-network
  gauges load first (the other 2,400 river gauges follow once the map is
  drawn), and flood history loads with the first model.

## Build and testing

- **Preset audit.** The live check lists which Bureau gauge each river
  preset is anchored to; review any presets that aren't anchored or sit
  far from their gauge.
- **Hydrology inside `flood` (in progress, branch `hydrology-inprocess`).**
  `flood hydrology <config> <work>` runs the same six RustGIS tools as
  `pipeline/run_hydrology.sh` (breach, fill, D8 pointer, accumulation,
  streams, HAND) in-process through `wbtools_oss` from
  opengeos/whitebox-wasm, pinned to commit 6b2a6eb, the code inside the
  GeoLibre 1.6.0 release the build uses; `flood tool <id> --k=v` runs any
  tool of the suite. Its tests pass, including a real run on a test
  valley. Notes:
  - `rust/Cargo.lock` was seeded from GeoLibre 1.6.0's lockfile because
    whitebox-wasm at that commit needs `zip` 8.5.1+, which is yanked on
    crates.io; Cargo still uses a yanked version pinned in a lockfile.
    Keep the lockfile; don't regenerate it from scratch.
  - Run the vendor workflow on the branch (Actions > Vendor Rust crates,
    or the REST dispatch with `ref=hydrology-inprocess`) to refresh the
    `rust-vendor` branch for offline builds.
  - Next: `.github/workflows/hydrology-compare.yml` (runs on pushes to the
    branch) runs the Brisbane hydrology with both the geolibre program
    and `flood hydrology` and compares every raster. If they match, switch
    `build.yml` to `flood hydrology`, drop `install_geolibre.sh` and
    `run_hydrology.sh`, and merge. A release build with LTO takes over
    ten minutes because of the whole tool suite; consider a lighter
    profile for the pipeline.
- **The model inside RustGIS.** `rust/flood-core` has no dependencies and
  builds to WebAssembly; it could be offered to RustGIS as a tool working
  on a DEM and D8 opened there.
- **Faster single runs.** In the browser one inundation costs about the
  same in Rust as in JavaScript, because the results are copied out of
  WebAssembly memory. Returning only what the map draws (or sharing
  memory) would make interactive updates quicker; analysis, storms and
  flood timelines are already 1.2–2.6× faster.
