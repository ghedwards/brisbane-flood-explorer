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
    server) that runs `pipeline/fetch_floodinfo.py` and commits
    `floodclass.json` and `warnings.json` to the repo, or
  - a Bureau registered-user data feed, if one can be obtained.
- **Google Flood Hub forecasts.** Built in; add the API key as the repo
  secret `FLOOD_FORECASTING_API_KEY`.
- **Repository name.** Renaming to `flood-explorer` (Settings → General)
  moves the site to `ghedwards.github.io/flood-explorer/`. Repo links
  redirect; the old Pages address does not. Saved places carry over (same
  origin).

## Modelling

- **How a flood unfolds over time.** Route a flood wave from the gauge's
  rise and fall (a Muskingum-style or kinematic-wave reach model along the
  stream network) and add a time slider showing when water reaches each
  street and how long it stays. Needs hydrograph shapes: from Water Data
  Online history for real events, or a synthetic triangle for scenarios.
- **Storm tide.** Combine Bureau tide predictions (or the published
  highest astronomical tide by port) with a surge height for coastal models,
  with cyclone presets for north Queensland. Watch the datum: tide tables
  are relative to chart datum, not AHD.
- **Design rainfall from the Bureau.** Storm mode currently offers example
  storms and links to the Bureau's design rainfall (IFD) tool. Fetching the
  IFD table for the model's location would give real "1% annual chance"
  storms; the Bureau's site blocks automated requests, so this needs a
  permitted access route (see above) or a pre-built national grid.
- **Stormwater in storm mode.** Subtract a typical pipe capacity (for
  example the 10% to 5% annual chance storm in urban areas) from runoff
  in sealed areas, so small storms aren't overstated in sewered suburbs.
- **Levees and flood gates.** Burn known levees (where states publish
  them) into the terrain, with a "levee fails" option.
- **More recorded floods for the accuracy check.** Queensland flood lines
  and Brisbane City Council outlines are built in. Candidates: NSW SES and
  council flood studies (Northern Rivers 2022), Victorian Flood Database
  extents, and Digital Earth Australia's satellite-observed water for
  specific flood dates (cloud permitting).
- **Victoria's statewide flood extent** (1% chance), if it becomes
  available as an open map service.

## Impact

Done: buildings, people, roads, key sites, water above floor (with a floor
height setting), daytime workplaces, and places cut off from a dry road out.

- **Daytime population counts.** The ABS publishes workplace destination
  zones as an open service but not the worker counts for them; daytime
  exposure currently counts flooded workplaces, shops, schools and public
  buildings from OpenStreetMap. Loading the ABS place-of-work counts (a
  download) into the build would give numbers of workers.
- **When places get cut off.** With a flood-over-time model (above), report
  the time each road closes and how long places stay isolated.
- **Measured floor heights.** Councils hold surveyed floor levels for some
  floodplains; where any are published openly they would replace the
  single typical floor height.
- **Damage estimates.** Australian depth–damage curves could turn
  over-floor depths into indicative repair costs.

## Data coverage

- **More council overland-flow and flood maps.** Currently Brisbane,
  City of Moreton Bay and Sunshine Coast. Many councils only publish
  downloads; check periodically for new open map services (Gold Coast,
  Logan, Ipswich, Sydney councils, Townsville, Cairns).
- **Rain radar detail.** RainViewer's free tier stops at zoom 7; a
  higher-resolution open radar source would help storm mode.

## Reliability and usability

- **Offline use.** Make the site an installable web app that keeps working
  after loading when mobile signal drops during a flood (cache the app,
  the national data and the active model).
- **Real-phone testing**, especially iOS Safari, for panels, scrolling,
  the area-study box and touch gestures.
- **Accessibility.** Full keyboard use of the map tools, screen-reader
  labels for results, and colour choices checked for colour-blind users.
- **Faster first load** on slow connections (defer satellite basemaps,
  compress national data further).

## Build and testing

- **Shorter live check.** The smoke test now takes about 25 minutes,
  mostly building all 58 presets. Run the full preset sweep nightly and a
  short subset on each change.
- **Preset audit.** The live check lists which Bureau gauge each river
  preset is anchored to; review any presets that aren't anchored or sit
  far from their gauge.
