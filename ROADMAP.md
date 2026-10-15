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

- **Flood routing.** Flood over time follows a smooth or recorded rise and
  fall at the gauge, travelling at a set speed and flattening with distance.
  A proper routing method (Muskingum or kinematic wave) with tributary
  inflows, and tide cycles for coastal models, would be more realistic.
  The recorded-flood list lives in `config/events.json`; add events there.
- **Storm tide beyond Queensland.** The storm tide builder fills in tides
  for Queensland standard ports; other states' tidal planes (in AHD) would
  extend it, and Bureau tide predictions would allow "this week's
  highest tide".
- **Design rainfall from the Bureau.** Storm mode currently offers example
  storms and links to the Bureau's design rainfall (IFD) tool. Fetching the
  IFD table for the model's location would give real "1% annual chance"
  storms; the Bureau's site blocks automated requests, so this needs a
  permitted access route (see above) or a pre-built national grid.
- **Stormwater in storm mode.** Subtract a typical pipe capacity (for
  example the 10% to 5% annual chance storm in urban areas) from runoff
  in sealed areas, so small storms aren't overstated in sewered suburbs.
- **More levee data.** OpenStreetMap, the NSW levee audit shapefiles and
  Victoria's coastal levees (where downloadable) are collected. Levee crest
  heights from surveys would beat crests read from the terrain. Levee
  overtopping fills the protected area to the river level without a volume
  limit, so short overtopping is overstated.
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
- **Accessibility.** Full keyboard use of the map tools, screen-reader
  labels for results, and colour choices checked for colour-blind users.
- **Faster first load** on slow connections (defer satellite basemaps,
  compress national data further).

## Build and testing

- **Preset audit.** The live check lists which Bureau gauge each river
  preset is anchored to; review any presets that aren't anchored or sit
  far from their gauge.
