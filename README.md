# Brisbane Flood Explorer

A screening tool for river and coastal flooding on the lower Brisbane River. Pick a river level at the Brisbane City gauge, a bay level and a sea-level-rise allowance, and the map shows which land sits below the water surface and connects to the river, with depths.

For the processed Brisbane area the flood layer sits on a pan-and-zoom street map: tap anywhere for ground level and water depth, tap the river to move the gauge, or jump to your location. It opens on Esri satellite imagery; switch between satellite, street, Queensland Government aerial and topographic, and other basemaps with the layer button. Brisbane City Council's creek and overland-flow flood likelihood maps and the recorded 1974, 2011 and 2022 flood extents can be switched on from the same button, to compare the model with the council's studies and with what actually happened. The illustrative sample terrain is shown as a static picture.

The heavy terrain work is done by the hydrology tools that power [RustGIS](https://github.com/opengeos/RustGIS) (the [GeoLibre](https://github.com/opengeos/geolibre-rust) runner, built on Whitebox). A small browser viewer then runs the flood scenarios instantly.

**Live site:** https://ghedwards.github.io/brisbane-flood-explorer/ (after GitHub Pages is switched on, see [Setup](#setup)).

> **Not for emergency or property decisions.** This is a screening model built on a 30 m surface model. Use [Brisbane City Council Flood Awareness Maps](https://fam.brisbane.qld.gov.au/) and [Bureau of Meteorology warnings](https://www.bom.gov.au/qld/warnings/) for real flood risk.

## How it works

```mermaid
flowchart LR
  A[Copernicus GLO-30 DEM<br/>AWS Open Data] --> B[fetch_dem.py<br/>mosaic, MGA56, 40 m]
  B --> C[GeoLibre / RustGIS tools<br/>breach + fill depressions<br/>D8 pointer, flow accumulation<br/>streams, HAND]
  C --> D[export_viewer.py<br/>dem.f32, d8.u8, meta.json]
  D --> E[Browser viewer<br/>scenario sliders, map,<br/>river long-section]
```

GitHub Actions runs the whole pipeline on every push to `main`, publishes the viewer and data to GitHub Pages, then loads the live site in a headless browser to check the interactive map works ([`.github/workflows/build.yml`](.github/workflows/build.yml), [`tests/smoke_live.py`](tests/smoke_live.py)). The check's results appear as annotations on the workflow run, with a screenshot attached.

### 1. Terrain (`pipeline/fetch_dem.py`)

Downloads the Copernicus GLO-30 tiles covering the area in [`config/brisbane.json`](config/brisbane.json), mosaics them, and reprojects to GDA2020 / MGA zone 56 at 40 m. No login is needed.

### 2. Hydrology with the RustGIS tools (`pipeline/run_hydrology.sh`)

`pipeline/install_geolibre.sh` installs the same `geolibre` runner that RustGIS downloads for its Analyze > GeoLibre toolboxes (pinned release, SHA-256 checked). The pipeline then runs:

| Step | Tool | Output |
|---|---|---|
| Carve through embankments and bridges | `breach_depressions_least_cost` | `dem_breached.tif` |
| Make flats drain | `fill_depressions --fix_flats=true` | `dem_cond.tif` |
| Flow directions | `d8_pointer` | `d8.tif` |
| Flow accumulation | `d8_flow_accum` | `acc.tif` |
| Stream network | `extract_streams` | `streams.tif` |
| Height above nearest drainage | `elevation_above_stream` | `hand.tif` |

Every step is also available in the RustGIS desktop or web app, so you can open `dem.tif` there and repeat or inspect any stage by hand. The published site links the HAND, streams and flow-direction GeoTIFFs for download.

### 3. Flood scenarios (in the browser)

[`viewer/flood-core.js`](viewer/flood-core.js) takes the ground elevations and the D8 flow directions and:

1. Builds the stream network from a minimum catchment area.
2. Sets a water surface along the river: it varies linearly with river distance from the bay level at the mouth to the chosen level at the gauge, and rises at a set slope (default 0.3 m/km) upstream of the gauge and up tributaries.
3. Gives every cell the water level of the stream it drains to. This generalises HAND, which assumes one flood stage everywhere.
4. Floods a cell when its ground is below that level **and** it touches water through neighbouring wet cells, so low ground behind high ground stays dry.
5. Reports land newly flooded compared with normal conditions (gauge 0.5 m, bay at 0 m).

Sea-level rise raises the bay level, which lifts the lower reaches through step 2.

### Scenarios included

Peaks at the Brisbane City gauge from the Bureau of Meteorology's [lower Brisbane River flood warning brochure](https://www.bom.gov.au/qld/flood/brochures/brisbane_lower/brisbane_lower.shtml):

| Flood | Peak (m) |
|---|---|
| Feb 1893 | 8.35 |
| Jan 1974 | 5.45 |
| Jan 2011 | 4.46 |
| Feb 2022 | 3.85 |
| Jan 2013 | 2.30 |

Sea-level rise options run from 0.3 m to 1.1 m, including Queensland's 0.8 m planning allowance to 2100. The "extra river peak" slider is a manual allowance for heavier rainfall; the model does not turn rainfall into river levels.

## Limitations

- **Surface model, not bare earth.** GLO-30 includes buildings and trees, which wrongly raise ground levels in suburbs and along vegetated banks. A LiDAR DEM from [ELVIS](https://elevation.fsdf.org.au/) fixes most of this.
- **Static water surface.** No flood wave, timing, velocity, storage or flow through bridges and culverts. The linear water surface between gauge and mouth is a simplification; real flood profiles bend.
- **Only river and sea flooding.** Rainfall on the floodplain, creeks rising on their own, stormwater backflow and overland flow are not modelled. In 2022 much of Brisbane's damage came from creek and flash flooding that this model cannot show.
- **Datum.** GLO-30 heights use the EGM2008 geoid, a few tenths of a metre from AHD around Brisbane; gauge levels are treated as AHD.
- **Levees and flood gates** are not represented unless they appear in the terrain.

For full hydrodynamic modelling, the outputs here are a starting point for [ANUGA](https://github.com/GeoscienceAustralia/anuga_core) or [LISFLOOD-FP](https://www.seamlesswave.com/LISFLOOD8.0).

## Setup

1. **Turn on GitHub Pages.** In the repository, open Settings > Pages and set Source to **GitHub Actions**.
2. **Run the workflow.** Push to `main` or use Actions > *Build terrain and publish viewer* > Run workflow. The build summary says whether the DEM download and the hydrology step succeeded. If either fails, the site still publishes with the sample terrain only.

## Run it yourself

The viewer is plain HTML and JavaScript with no build step:

```sh
python3 -m http.server -d viewer 8000   # then open http://localhost:8000
```

Without processed data it opens on an illustrative sample terrain. You can also load your own GeoTIFF or ASCII grid DEM in the page, optionally with a `d8.tif` from the pipeline.

To run the pipeline locally (Linux or macOS, needs Python 3.10+ and the GitHub CLI):

```sh
pip install -r pipeline/requirements.txt
pipeline/install_geolibre.sh ~/.local/bin
python pipeline/fetch_dem.py config/brisbane.json work/brisbane
pipeline/run_hydrology.sh config/brisbane.json work/brisbane
python pipeline/export_viewer.py config/brisbane.json work/brisbane viewer/data
python3 -m http.server -d viewer 8000
```

**Using LiDAR instead of GLO-30:** download a DEM for your area from ELVIS, reproject it to the area's CRS (EPSG:7856 for Brisbane), save it as `work/brisbane/dem.tif`, and start from the hydrology step. Set `cell_m` in the config to the LiDAR cell size, since the stream threshold depends on it. At 1–5 m the grid gets large, so clip to the reach you care about.

**Another river:** copy `config/brisbane.json`, change the bounding box, CRS, gauge and `brisbane_gauge_events: false`, and add the area to the workflow.

## Tests

```sh
node --test tests/core.test.js
```

The tests check routing (every cell drains), monotonic flooding, water levels at the gauge and mouth, connectivity, and that Whitebox D8 pointers from the pipeline reproduce the browser's own routing exactly.

## Repository layout

```
config/brisbane.json         area, CRS, cell size, gauge, thresholds
pipeline/                    DEM download, GeoLibre install + hydrology, export
viewer/                      static web app (index.html, app.js, flood-core.js)
tests/                       Node tests for the flood model
.github/workflows/build.yml  CI: test, build terrain, publish to Pages
```

## Data and credits

- Terrain: Copernicus GLO-30 Digital Elevation Model, © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA; all rights reserved. Accessed through the [AWS Open Data registry](https://registry.opendata.aws/copernicus-dem/).
- Hydrology tools: [GeoLibre](https://github.com/opengeos/geolibre-rust) and [Whitebox](https://github.com/opengeos/whitebox-wasm), as used by [RustGIS](https://github.com/opengeos/RustGIS).
- Flood peaks: Bureau of Meteorology.
- Creek and overland flow likelihood and recorded flood extents: [Brisbane City Council Flood Awareness data](https://data.brisbane.qld.gov.au/), CC BY 4.0, read live from the council's ArcGIS services with [esri-leaflet](https://github.com/Esri/esri-leaflet).
- GeoTIFF reading in the browser: [geotiff.js](https://github.com/geotiffjs/geotiff.js).
- Street map: [Leaflet](https://leafletjs.com/). Basemaps, chosen with the layer button on the map:
  - Streets: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors © [CARTO](https://carto.com/attributions)
  - OpenStreetMap standard tiles, used under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  - Satellite: Esri World Imagery (Esri, Maxar, Earthstar Geographics). Check [Esri's terms](https://www.esri.com/en-us/legal/terms/full-master-agreement) before any commercial use.
  - Queensland aerial imagery and topographic basemaps: © State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); imagery partly © Planet Labs Netherlands B.V. under licence from Planet and Geoplex
  - Topographic: © [OpenTopoMap](https://opentopomap.org) (CC BY-SA), map data © OpenStreetMap contributors, SRTM

Released under the MIT licence (see [LICENSE](LICENSE)).
