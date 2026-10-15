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

- **Flood routing, further.** Below the gauge the flood is routed
  (Muskingum–Cunge) with tributary inflows, measured ratings where the
  gauge has flow records, and tides; recorded floods follow other gauges
  upstream. Still simple: tributary floods copy the gauge's shape, places
  above the gauge without a recorded gauge are only shifted in time, and
  floodplain storage and dam releases aren't modelled. Ratings come from
  daily means, so they are extrapolated above the highest daily level.
- **Tides from predictions.** Tide heights cover the whole coast (the
  national EOT20 tide statistics outside Queensland), but tide cycles are a
  12.4-hour sine at spring-tide height. Tide predictions for the event's
  dates would allow "this week's highest tide" and real tide timing for
  recorded floods.
- **Design rainfall from the Bureau.** Storm mode currently offers example
  storms and links to the Bureau's design rainfall (IFD) tool. Fetching the
  IFD table for the model's location would give real "1% annual chance"
  storms; the Bureau's site blocks automated requests, so this needs a
  permitted access route (see above) or a pre-built national grid.
- **Stormwater, further.** Pipes take one typical rate of runoff from
  built-up land; council pipe network data (where published) and the
  local design storm would replace the single rate.
- **More levee data.** Levees come from OpenStreetMap and whatever
  `pipeline/fetch_levees.py` collects. The NSW levee audit (about 130
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

## Impact

Done: buildings, people, roads, key sites, water above floor (with a floor
height setting), daytime workplaces, places cut off from a dry road out,
and when roads close and how long places stay cut off (flood over time).

- **Daytime population counts.** The ABS publishes workplace destination
  zones as an open service but not the worker counts for them; daytime
  exposure currently counts flooded workplaces, shops, schools and public
  buildings from OpenStreetMap. Loading the ABS place-of-work counts (a
  download) into the build would give numbers of workers.
- **Measured floor heights.** Councils hold surveyed floor levels for some
  floodplains; where any are published openly they would replace the
  single typical floor height.
- **Australian damage curves.** Damage currently uses the EU JRC global
  curve for Oceania homes; the NSW residential flood damage curves (by
  house type) or Geoscience Australia's vulnerability models would be
  more local, if published as numbers.

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
- **Accessibility, further.** Done: keyboard use of the map (Enter acts at
  the map centre), focusable numbered places, announced status messages,
  colours that differ by lightness. Still to do: a screen-reader summary of
  the flood map itself (beyond the counts), and an audit with a real
  screen reader.
- **Faster first load, further.** Scripts are minified and background data
  loads after the map; the national gauge file is the largest download and
  could be split by state or loaded by map view.

## Build and testing

- **Preset audit.** The live check lists which Bureau gauge each river
  preset is anchored to; review any presets that aren't anchored or sit
  far from their gauge.
