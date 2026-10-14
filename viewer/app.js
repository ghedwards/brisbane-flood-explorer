/* Brisbane Flood Explorer — viewer
 *
 * Loads a terrain (sample, a pipeline-processed area, or the user's own DEM),
 * runs FloodCore for the chosen scenario and draws the map, stats and river
 * long-section.
 */
(function () {
  'use strict';
  const F = window.FloodCore;
  const $ = (id) => document.getElementById(id);

  // Peak heights at the Brisbane City gauge (m), from the Bureau of
  // Meteorology's lower Brisbane River flood warning brochure.
  const BRISBANE_EVENTS = [
    { id: '2013', label: '2013', level: 2.30 },
    { id: '2022', label: '2022', level: 3.85 },
    { id: '2011', label: '2011', level: 4.46 },
    { id: '1974', label: '1974', level: 5.45 },
    { id: '1893', label: '1893', level: 8.35 },
  ];
  const BASELINE = { gaugeLevel: 0.5, bayLevel: 0 }; // "normal" water for comparison

  const state = {
    areaId: null, areaMeta: null,
    grid: null, a: null, gauge: -1,
    events: BRISBANE_EVENTS, eventsApply: true,
    streamAreaKm2: 4,
    run: null, base: null, terrain: null,
    offscreen: document.createElement('canvas'),
    hover: -1,
  };

  /* ------------------------------------------------------------ controls */

  const ctl = {
    gaugeLevel: $('gaugeLevel'), bayLevel: $('bayLevel'), slr: $('slr'),
    extra: $('extra'), grad: $('grad'), streamArea: $('streamArea'),
  };
  const fmt = (v, d) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
  const streamFromSlider = (v) => 0.02 * Math.pow(10, (v / 100) * 3); // 0.02–20 km²
  const sliderFromStream = (km2) => Math.round((Math.log10(km2 / 0.02) / 3) * 100);

  function scenario() {
    const slr = parseFloat(ctl.slr.value);
    return {
      gauge: state.gauge,
      gaugeLevel: parseFloat(ctl.gaugeLevel.value) + parseFloat(ctl.extra.value),
      bayLevel: parseFloat(ctl.bayLevel.value) + slr,
      upstreamGradient: parseFloat(ctl.grad.value),
    };
  }

  function syncOutputs() {
    $('gaugeLevelOut').textContent = fmt(ctl.gaugeLevel.value, 2) + ' m';
    $('bayLevelOut').textContent = fmt(ctl.bayLevel.value, 2) + ' m';
    $('extraOut').textContent = '+' + fmt(ctl.extra.value, 2) + ' m';
    $('gradOut').textContent = fmt(ctl.grad.value, 2) + ' m/km';
    $('streamAreaOut').textContent = fmt(streamFromSlider(ctl.streamArea.value), 2) + ' km²';
    const L = parseFloat(ctl.gaugeLevel.value);
    document.querySelectorAll('#events .chip').forEach((b) => {
      b.setAttribute('aria-pressed', String(Math.abs(parseFloat(b.dataset.level) - L) < 0.001));
    });
  }

  function renderEvents() {
    const box = $('events');
    box.innerHTML = '';
    state.events.forEach((e) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.dataset.level = e.level;
      b.innerHTML = `<b>${e.label}</b><span>${e.level.toFixed(2)} m</span>`;
      b.addEventListener('click', () => { ctl.gaugeLevel.value = e.level; syncOutputs(); schedule(); });
      box.appendChild(b);
    });
    $('eventsSet').hidden = !state.eventsApply;
    $('eventsNote').textContent = state.areaId === 'sample'
      ? 'Real Brisbane City gauge peaks, applied to illustrative terrain.'
      : 'Brisbane City gauge peaks (Bureau of Meteorology).';
  }

  let pending = 0;
  function schedule() {
    syncOutputs();
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; runScenario(); });
  }
  Object.values(ctl).forEach((el) => el.addEventListener('input', () => {
    if (el === ctl.streamArea) return;
    schedule();
  }));
  ctl.streamArea.addEventListener('change', () => {
    state.streamAreaKm2 = streamFromSlider(ctl.streamArea.value);
    reanalyse(false);
  });
  ctl.streamArea.addEventListener('input', syncOutputs);

  /* ------------------------------------------------------------- loading */

  function setBusy(on, text) {
    $('busy').hidden = !on;
    if (text) $('busy').textContent = text;
  }

  async function listAreas() {
    const sel = $('area');
    const opts = [{ id: 'sample', name: 'Sample terrain (illustrative)' }];
    try {
      const r = await fetch('data/areas.json', { cache: 'no-cache' });
      if (r.ok) {
        const list = await r.json();
        list.forEach((x) => opts.unshift({ id: x.id, name: x.name }));
      }
    } catch (e) { /* no processed areas published yet */ }
    sel.innerHTML = '';
    for (const o of opts) {
      const op = document.createElement('option');
      op.value = o.id; op.textContent = o.name;
      sel.appendChild(op);
    }
    return opts;
  }

  async function loadArea(id) {
    setBusy(true, 'Loading terrain…');
    await nextFrame();
    try {
      if (id === 'sample') {
        const g = F.syntheticTerrain();
        state.areaMeta = { id: 'sample', name: 'Sample terrain', synthetic: true, streamAreaKm2: 4 };
        useGrid(g, 'sample', { events: true });
      } else {
        const meta = await (await fetch(`data/${id}/meta.json`, { cache: 'no-cache' })).json();
        const [demBuf, d8Buf] = await Promise.all([
          fetch(`data/${id}/${meta.files.dem}`).then(okBuf),
          fetch(`data/${id}/${meta.files.d8}`).then(okBuf),
        ]);
        const dem = new Float32Array(demBuf);
        const d8 = new Uint8Array(d8Buf);
        const N = meta.W * meta.H;
        if (dem.length !== N || d8.length !== N) throw new Error('Area files do not match their metadata.');
        const valid = new Uint8Array(N);
        for (let i = 0; i < N; i++) valid[i] = Number.isFinite(dem[i]) && dem[i] !== meta.nodata && d8[i] !== 255 ? 1 : 0;
        state.areaMeta = meta;
        useGrid({ W: meta.W, H: meta.H, cell: meta.cell, dem, valid, d8 }, id, { events: !!meta.brisbaneGauge });
      }
    } catch (err) {
      showError(`Could not load that terrain: ${err.message}`);
      if (id !== 'sample') { $('area').value = 'sample'; return loadArea('sample'); }
    } finally {
      setBusy(false);
    }
  }

  function okBuf(r) {
    if (!r.ok) throw new Error(`${r.url.split('/').pop()} returned ${r.status}`);
    return r.arrayBuffer();
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  function useGrid(grid, id, opts) {
    state.grid = grid;
    state.areaId = id;
    state.eventsApply = !!opts.events;
    const areaKm2 = (grid.W * grid.H * grid.cell * grid.cell) / 1e6;
    state.streamAreaKm2 = (state.areaMeta && state.areaMeta.streamAreaKm2)
      || Math.min(4, Math.max(0.05, areaKm2 * 0.01));
    ctl.streamArea.value = sliderFromStream(state.streamAreaKm2);
    renderEvents();
    reanalyse(true);
    // default levels
    if (state.eventsApply) ctl.gaugeLevel.value = 4.46;
    else if (state.gauge >= 0) ctl.gaugeLevel.value = Math.max(0, Math.round((grid.dem[state.gauge] + 3) * 20) / 20);
    ctl.gaugeLevel.max = Math.max(10, Math.ceil(parseFloat(ctl.gaugeLevel.value) + 6));
    syncOutputs();
    renderInfo();
    const bl = state.areaMeta && state.areaMeta.bounds_lonlat;
    if (bl) enterGeoMode(bl).then((ok) => { if (ok && state.run) drawMap(); });
    else leaveGeoMode();
    runScenario();
  }

  function reanalyse(resetGauge) {
    const g = state.grid;
    state.a = F.analyse(g, { streamAreaKm2: state.streamAreaKm2 });
    const a = state.a;
    let gauge = a.defaultGauge;
    if (!resetGauge && state.gauge >= 0) {
      const x = state.gauge % a.W, y = Math.floor(state.gauge / a.W);
      const s = F.snapToStream(a, x, y, 12);
      if (s >= 0) gauge = s;
    } else if (resetGauge && state.areaMeta && state.areaMeta.gauge) {
      const s = F.snapToStream(a, state.areaMeta.gauge.col, state.areaMeta.gauge.row, 25);
      if (s >= 0) gauge = s;
    }
    state.gauge = gauge;
    state.base = null;
    state.terrain = terrainRGBA(a);
    if (!resetGauge) runScenario();
  }

  /* ------------------------------------------------------------- uploads */

  $('files').addEventListener('change', async (ev) => {
    const files = Array.from(ev.target.files || []);
    if (!files.length) return;
    setBusy(true, 'Reading files…');
    await nextFrame();
    try {
      const grid = await readUserFiles(files);
      state.areaMeta = { id: 'upload', name: grid.name, upload: true, routedBy: grid.d8 ? 'pointers' : 'browser' };
      let op = $('area').querySelector('option[value="upload"]');
      if (!op) { op = document.createElement('option'); op.value = 'upload'; $('area').appendChild(op); }
      op.textContent = 'Your file: ' + grid.name;
      $('area').value = 'upload';
      useGrid(grid, 'upload', { events: false });
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
      ev.target.value = '';
    }
  });

  async function readUserFiles(files) {
    const isPtr = (f) => /(d8|pntr|pointer)/i.test(f.name);
    const demFile = files.find((f) => !isPtr(f)) || files[0];
    const ptrFile = files.find((f) => f !== demFile && isPtr(f));
    let grid = await readRaster(demFile);
    if (ptrFile) {
      const p = await readRaster(ptrFile, { raw: true });
      if (p.W !== grid.W || p.H !== grid.H) throw new Error(`${ptrFile.name} is ${p.W}×${p.H} cells but ${demFile.name} is ${grid.W}×${grid.H}. Use outputs from the same run.`);
      if (grid.W * grid.H > 2.5e6) throw new Error('That DEM is too large to use with its flow directions here. Re-run the pipeline at a coarser cell size.');
      const d8 = new Int16Array(grid.W * grid.H);
      for (let i = 0; i < d8.length; i++) {
        d8[i] = Math.round(p.dem[i]);
        if (!p.valid[i]) grid.valid[i] = 0;
      }
      grid.d8 = d8;
    } else {
      grid = F.downsample(grid, 700);
    }
    grid.name = demFile.name;
    return grid;
  }

  async function readRaster(file, opts) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.asc') || name.endsWith('.txt')) {
      const g = F.parseAsciiGrid(await file.text());
      return F.cleanNodata(g);
    }
    if (!(name.endsWith('.tif') || name.endsWith('.tiff'))) throw new Error(`${file.name}: use a GeoTIFF (.tif) or an ASCII grid (.asc).`);
    await loadGeoTiffLib();
    const tiff = await window.GeoTIFF.fromArrayBuffer(await file.arrayBuffer());
    const img = await tiff.getImage();
    const W = img.getWidth(), H = img.getHeight();
    if (W * H > 40e6) throw new Error(`${file.name} has ${(W * H / 1e6).toFixed(0)} million cells. Clip or resample it below 40 million first.`);
    const ras = await img.readRasters({ samples: [0] });
    const data = ras[0];
    const nd = img.getGDALNoData();
    const [rx] = img.getResolution();
    let cell = Math.abs(rx);
    const geographic = (img.geoKeys && img.geoKeys.GTModelTypeGeoKey === 2) || cell < 0.01;
    if (geographic) {
      const bb = img.getBoundingBox();
      const lat = (bb[1] + bb[3]) / 2;
      cell = cell * 111320 * Math.cos((lat * Math.PI) / 180);
    }
    const dem = new Float32Array(W * H);
    const valid = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const v = data[i];
      dem[i] = v;
      valid[i] = Number.isFinite(v) && v !== nd ? 1 : 0;
    }
    const g = { W, H, cell, dem, valid };
    return opts && opts.raw ? g : F.cleanNodata(g, nd);
  }

  let geotiffPromise = null;
  function loadGeoTiffLib() {
    if (window.GeoTIFF) return Promise.resolve();
    if (!geotiffPromise) {
      geotiffPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js';
        s.onload = () => resolve();
        s.onerror = () => { geotiffPromise = null; reject(new Error('Could not load the GeoTIFF reader. Check your connection, or use an ASCII grid (.asc).')); };
        document.head.appendChild(s);
      });
    }
    return geotiffPromise;
  }

  /* -------------------------------------------------------------- model */

  function runScenario() {
    const a = state.a;
    if (!a) return;
    const s = scenario();
    if (!state.base) state.base = F.inundate(a, Object.assign({}, s, BASELINE, { upstreamGradient: s.upstreamGradient }));
    state.run = F.inundate(a, s);
    drawMap();
    drawStats(s);
    drawProfile(s);
    renderNotice();
  }

  /* ------------------------------------------------------------ drawing */

  const DEPTH_STOPS = [
    [0.5, [201, 231, 247]], [1, [121, 191, 232]], [2, [55, 134, 201]], [4, [29, 94, 163]], [Infinity, [12, 52, 112]],
  ];
  const WATER = [109, 147, 173];
  const HYPSO = [
    [0, [226, 230, 214]], [0.12, [208, 218, 186]], [0.35, [186, 186, 146]], [0.65, [160, 142, 112]], [1, [128, 112, 100]],
  ];

  function lerpStops(stops, t) {
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
        const f = (t - t0) / (t1 - t0);
        return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
      }
    }
    return stops[stops.length - 1][1];
  }

  function terrainRGBA(a) {
    const { W, H, dem, valid, cell } = a;
    const land = [];
    for (let i = 0; i < a.N; i += 7) if (valid[i] && !a.ocean[i]) land.push(dem[i]);
    land.sort((x, y) => x - y);
    const lo = land.length ? land[Math.floor(land.length * 0.02)] : 0;
    const hi = land.length ? land[Math.floor(land.length * 0.98)] : 1;
    const out = new Uint8ClampedArray(a.N * 4);
    const az = (315 * Math.PI) / 180, alt = (45 * Math.PI) / 180;
    const z = (x, y) => {
      x = Math.max(0, Math.min(W - 1, x)); y = Math.max(0, Math.min(H - 1, y));
      const i = y * W + x;
      return valid[i] ? dem[i] : NaN;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      if (!valid[i]) { out[o + 3] = 0; continue; }
      const c = dem[i];
      const zz = (xx, yy) => { const v = z(xx, yy); return Number.isNaN(v) ? c : v; };
      const gx = (zz(x + 1, y) - zz(x - 1, y)) / (2 * cell);
      const gy = (zz(x, y + 1) - zz(x, y - 1)) / (2 * cell);
      const slope = Math.atan(Math.hypot(gx, gy) * 1.6);
      const aspect = Math.atan2(gy, -gx);
      let hs = Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect - Math.PI / 2);
      hs = Math.max(0, Math.min(1, hs));
      const t = Math.max(0, Math.min(1, (c - lo) / (hi - lo || 1)));
      const col = lerpStops(HYPSO, t);
      const k = 0.55 + 0.5 * hs;
      out[o] = col[0] * k; out[o + 1] = col[1] * k; out[o + 2] = col[2] * k; out[o + 3] = 255;
    }
    return out;
  }

  // Pixels for the current scenario. withTerrain: shaded relief underneath
  // (static map); otherwise transparent except water (overlay on a basemap).
  function composeImage(withTerrain) {
    const a = state.a, run = state.run, base = state.base;
    const img = withTerrain
      ? new ImageData(new Uint8ClampedArray(state.terrain), a.W, a.H)
      : new ImageData(a.W, a.H);
    const d = img.data;
    for (let i = 0; i < a.N; i++) {
      if (!a.valid[i]) continue;
      const o = i * 4;
      let col = null, alpha = 0.88;
      if (withTerrain && (a.ocean[i] || (base && base.wet[i] && run.wet[i] && !isFlood(i)))) col = WATER;
      if (run.wet[i] && isFlood(i)) {
        const dep = run.depth[i];
        for (const [lim, c] of DEPTH_STOPS) if (dep < lim) { col = c; break; }
      }
      if (withTerrain && !col && a.stream[i] && a.acc[i] * (a.cell * a.cell) / 1e6 > state.streamAreaKm2 * 3) { col = WATER; alpha = 0.9; }
      if (!col) continue;
      if (withTerrain) {
        d[o] = d[o] * (1 - alpha) + col[0] * alpha;
        d[o + 1] = d[o + 1] * (1 - alpha) + col[1] * alpha;
        d[o + 2] = d[o + 2] * (1 - alpha) + col[2] * alpha;
      } else {
        d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = 255;
      }
    }
    return img;
  }

  function drawMap() {
    if (state.geo && state.lmap) drawGeoMap();
    else drawStaticMap();
  }

  function drawStaticMap() {
    const a = state.a;
    const img = composeImage(true);
    const off = state.offscreen;
    off.width = a.W; off.height = a.H;
    off.getContext('2d').putImageData(img, 0, 0);

    const canvas = $('map');
    const stage = $('mapWrap');
    const cssW = Math.max(200, Math.min(stage.clientWidth, (stage.clientHeight * a.W) / a.H));
    canvas.style.width = cssW + 'px';
    canvas.style.height = (cssW * a.H / a.W) + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(cssW * dpr), ph = Math.round((cssW * a.H / a.W) * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = a.W < pw;
    ctx.drawImage(off, 0, 0, pw, ph);

    const sx = pw / a.W, sy = ph / a.H;
    // gauge marker
    if (state.gauge >= 0) {
      const gx = ((state.gauge % a.W) + 0.5) * sx, gy = (Math.floor(state.gauge / a.W) + 0.5) * sy;
      ctx.beginPath(); ctx.arc(gx, gy, 6.5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#c66f1d'; ctx.fill();
      ctx.lineWidth = 2.2 * dpr; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.font = `600 ${12 * dpr}px Archivo, sans-serif`;
      ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      const label = state.eventsApply ? 'Brisbane City gauge' : 'Gauge';
      const lx = Math.min(gx + 10 * dpr, pw - ctx.measureText(label).width - 6 * dpr);
      ctx.strokeText(label, lx, gy - 9 * dpr);
      ctx.fillStyle = '#5a2f08'; ctx.fillText(label, lx, gy - 9 * dpr);
    }
    // scale bar
    const mPerPx = (a.W * a.cell) / pw;
    const target = 110 * dpr * mPerPx;
    const nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000].find((v) => v >= target * 0.6) || 20000;
    const len = nice / mPerPx;
    const bx = 12 * dpr, by = ph - 14 * dpr;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(bx - 6 * dpr, by - 18 * dpr, len + 12 * dpr, 26 * dpr);
    ctx.fillStyle = '#12202a';
    ctx.fillRect(bx, by - 3 * dpr, len, 3 * dpr);
    ctx.fillRect(bx, by - 7 * dpr, 1.5 * dpr, 7 * dpr);
    ctx.fillRect(bx + len - 1.5 * dpr, by - 7 * dpr, 1.5 * dpr, 7 * dpr);
    ctx.font = `500 ${11 * dpr}px "IBM Plex Mono", monospace`;
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, bx + 4 * dpr, by - 7 * dpr);
  }


  /* ---------------------------------------------------- interactive map */
  // Areas with real coordinates (meta.bounds_lonlat) are shown on a pan-and-
  // zoom street map with the flood depths as an overlay. The grid is in
  // GDA2020 / MGA56, whose grid north is within 0.02° of true north at
  // Brisbane, so a lat/lon-aligned overlay lines up to a few metres.

  const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/';
  const TILES = {
    light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  };
  const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const TILE_ATTR = OSM_ATTR + ' &copy; <a href="https://carto.com/attributions">CARTO</a>';
  const QLD_ATTR = '&copy; State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development), <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>';
  const QLD_GIS = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Basemaps/';
  // Digital Earth Australia (Geoscience Australia) map services, CC BY 4.0
  const DEA_OWS = 'https://ows.dea.ga.gov.au/';
  const DEA_ATTR = 'Satellite data &copy; <a href="https://www.dea.ga.gov.au/">Digital Earth Australia</a> (Geoscience Australia; Landsat, Copernicus Sentinel-2), CC BY 4.0';
  function deaWms(L, params, opts) {
    return L.tileLayer.wms(DEA_OWS, Object.assign({
      format: 'image/png', transparent: true, version: '1.3.0', tileSize: 512, zoomOffset: 0,
    }, params, opts));
  }

  // Basemaps offered in the layer switcher. The first is the default.
  const BASEMAPS = [
    { name: 'Satellite (Esri)', url: () => 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      opts: { attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics and the GIS User Community', maxZoom: 19 } },
    { name: 'Latest satellite, infrared (DEA)', wms: { layers: 's2_ls_combined', styles: 'false_colour' },
      opts: { attribution: DEA_ATTR, maxZoom: 19, maxNativeZoom: 16, minZoom: 7 } },
    { name: 'Latest satellite, true colour (DEA)', wms: { layers: 's2_ls_combined', styles: 'true_colour' },
      opts: { attribution: DEA_ATTR, maxZoom: 19, maxNativeZoom: 16, minZoom: 7 } },
    { name: 'Streets', url: () => (isDark() ? TILES.dark : TILES.light),
      opts: { attribution: TILE_ATTR, subdomains: 'abcd', maxZoom: 19 } },
    { name: 'OpenStreetMap', url: () => 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      opts: { attribution: OSM_ATTR, maxZoom: 19 } },
    { name: 'Queensland aerial imagery', url: () => 'https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer/tile/{z}/{y}/{x}',
      opts: { attribution: 'Imagery &copy; Planet Labs Netherlands B.V. under licence from Planet and Geoplex; ' + QLD_ATTR, maxZoom: 20 } },
    { name: 'Queensland topographic', url: () => QLD_GIS + 'QldMap_Topo/MapServer/tile/{z}/{y}/{x}',
      opts: { attribution: QLD_ATTR, maxZoom: 20 } },
    { name: 'Topographic (OpenTopoMap)', url: () => 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      opts: { attribution: OSM_ATTR + ', SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC BY-SA)', subdomains: 'abc', maxZoom: 17 } },
  ];
  const BASEMAP_KEY = 'bfe.basemap.v2'; // v2: satellite became the default

  // Brisbane City Council Flood Awareness layers (CC BY 4.0), read live from
  // the council's ArcGIS services. Only offered for the Brisbane area.
  const BCC = 'https://services2.arcgis.com/dEKgZETqwmDAh1rP/ArcGIS/rest/services/';
  const BCC_ATTR = 'Flood awareness data &copy; <a href="https://data.brisbane.qld.gov.au/">Brisbane City Council</a>, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>';
  const LIKELIHOOD = { High: '#b3261e', Medium: '#e8710a', Low: '#f2c12e', 'Very Low': '#fff3a8' };
  const OVERLAYS = [
    { name: 'Creek flooding likelihood (council)', service: 'Flood_Awareness_Creek', kind: 'likelihood', minZoom: 13 },
    { name: 'Overland flow likelihood (council)', service: 'Flood_Awareness_Overland_Flow', kind: 'likelihood', minZoom: 14 },
    { name: 'Recorded flood: Feb 2022 (river + creek)', service: 'Flood_Awareness_Historic_Brisbane_River_and_Creek_Floods_Feb2022', kind: 'outline', color: '#ff3d9a' },
    { name: 'Recorded flood: Jan 2011 (river)', service: 'Flood_Awareness_Historic_Brisbane_River_Floods_Jan2011', kind: 'outline', color: '#ffd400' },
    { name: 'Recorded flood: Jan 1974 (river)', service: 'Flood_Awareness_Historic_Brisbane_River_Floods_Jan1974', kind: 'outline', color: '#ff7a00' },
  ];

  // Available on every real-place map, anywhere in Australia
  const NATIONAL_OVERLAYS = [
    { name: 'Water seen by satellite since 1987 (DEA)', layers: 'ga_ls_wo_fq_myear_3', styles: 'mysummary_wofs_frequency_3',
      legend: 'How often satellites have seen water there: pale = rarely (floods), dark blue = usually (rivers, lakes)' },
  ];

  function makeWmsOverlay(L, o) {
    const st = (status.overlays[o.name] = { features: 0, errors: 0 });
    const layer = deaWms(L, { layers: o.layers, styles: o.styles }, { attribution: DEA_ATTR, opacity: 0.75, maxZoom: 19, maxNativeZoom: 16, zIndex: 5 });
    layer.on('tileload', () => { st.features++; });
    layer.on('tileerror', () => { st.errors++; });
    o.layer = layer;
    o.kind = 'wms';
    return layer;
  }

  function makeOverlay(o) {
    const esri = window.L && window.L.esri;
    if (!esri) return null;
    const st = (status.overlays[o.name] = { features: 0, errors: 0 });
    const style = o.kind === 'likelihood'
      ? (f) => ({ color: LIKELIHOOD[f.properties.FLOOD_RISK] || '#999', weight: 0.6,
          fillColor: LIKELIHOOD[f.properties.FLOOD_RISK] || '#999', fillOpacity: 0.45 })
      : () => ({ color: o.color, weight: 2.4, dashArray: '6 4', fill: false });
    const layer = esri.featureLayer({
      url: BCC + o.service + '/FeatureServer/0',
      style, minZoom: o.minZoom || 0, simplifyFactor: 0.5, precision: 6,
      attribution: BCC_ATTR,
    });
    layer.on('createfeature', () => { st.features++; });
    layer.on('requesterror', () => { st.errors++; });
    if (o.kind === 'likelihood') {
      layer.bindPopup((l) => escapeHtml(`${o.name.replace(' (council)', '')}: ${l.feature.properties.FLOOD_RISK || 'unknown'} likelihood`));
    }
    o.layer = layer;
    return layer;
  }

  function renderOverlayLegend() {
    const box = $('overlayLegend');
    if (!box || !state.lmap) return;
    const on = OVERLAYS.filter((o) => o.layer && state.lmap.hasLayer(o.layer));
    const parts = [];
    if (on.some((o) => o.kind === 'likelihood')) {
      parts.push(...Object.entries(LIKELIHOOD).map(([k, c]) => `<span><i style="background:${c}"></i>${k} likelihood</span>`));
      const z = state.lmap.getZoom();
      const hidden = on.filter((o) => o.minZoom && z < o.minZoom);
      if (hidden.length) parts.push(`<span class="hint">Zoom in to see ${hidden.map((o) => o.name.split(' ')[0].toLowerCase()).join(' and ')} layers</span>`);
    }
    NATIONAL_OVERLAYS.filter((o) => o.layer && state.lmap.hasLayer(o.layer)).forEach((o) => {
      parts.push(`<span><i style="background:linear-gradient(90deg,#e6f3fb,#5aa9d6,#08306b)"></i>${escapeHtml(o.legend)}</span>`);
    });
    on.filter((o) => o.kind === 'outline').forEach((o) => {
      parts.push(`<span><i style="background:transparent;border:2px dashed ${o.color};height:8px"></i>${o.name.replace('Recorded flood: ', 'Recorded ')}</span>`);
    });
    box.innerHTML = parts.join('');
    box.hidden = !parts.length || $('legendToggle').getAttribute('aria-expanded') === 'false';
  }
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const status = (window.__floodStatus = { mode: 'static', overlayUpdates: 0, tilesLoaded: 0, tileErrors: 0, floodPixels: 0, overlays: {} });

  let leafletPromise = null;
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve();
    if (!leafletPromise) {
      leafletPromise = new Promise((resolve, reject) => {
        const css = document.createElement('link');
        css.rel = 'stylesheet'; css.href = LEAFLET + 'leaflet.css';
        document.head.appendChild(css);
        const js = document.createElement('script');
        js.src = LEAFLET + 'leaflet.js';
        js.onload = () => {
          // esri-leaflet reads the council's ArcGIS feature layers; optional
          const ej = document.createElement('script');
          ej.src = 'https://unpkg.com/esri-leaflet@3.0.12/dist/esri-leaflet.js';
          ej.onload = () => resolve();
          ej.onerror = () => resolve();
          document.head.appendChild(ej);
        };
        js.onerror = () => { leafletPromise = null; reject(new Error('The street map could not load.')); };
        document.head.appendChild(js);
      });
    }
    return leafletPromise;
  }

  function isDark() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }

  async function enterGeoMode(b) {
    try {
      await loadLeaflet();
    } catch (err) {
      leaveGeoMode();
      say(`${err.message} Showing the terrain picture instead.`);
      return false;
    }
    const L = window.L;
    state.geo = { west: b[0], south: b[1], east: b[2], north: b[3] };
    $('map').hidden = true;
    $('lmap').hidden = false;
    $('geoControls').hidden = false;
    $('layersStaticNote').hidden = true;
    const bounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
    if (!state.lmap) {
      const m = L.map('lmap', { maxBounds: bounds.pad(0.6), minZoom: 9, zoomSnap: 0.5, zoomControl: false });
      if (!finePointer()) { /* pinch to zoom on touch screens */ } else L.control.zoom({ position: 'bottomright' }).addTo(m);
      const layers = {};
      status.basemaps = {};
      for (const bm of BASEMAPS) {
        const layer = bm.wms ? deaWms(L, bm.wms, bm.opts) : L.tileLayer(bm.url(), bm.opts);
        const st = (status.basemaps[bm.name] = { loaded: 0, errors: 0 });
        layer.on('tileload', () => { st.loaded++; status.tilesLoaded++; });
        layer.on('tileerror', () => { st.errors++; status.tileErrors++; });
        layers[bm.name] = layer;
        bm.layer = layer;
      }
      let saved = null;
      try { saved = localStorage.getItem(BASEMAP_KEY); } catch (e) { /* storage blocked */ }
      const first = layers[saved] ? saved : BASEMAPS[0].name;
      layers[first].addTo(m);
      state.tiles = layers.Streets; // the one that follows light/dark mode
      status.basemap = first;
      status.overlays = {};
      const overlays = {};
      for (const o of NATIONAL_OVERLAYS) overlays[o.name] = makeWmsOverlay(L, o);
      if (state.areaMeta && state.areaMeta.brisbaneGauge) {
        for (const o of OVERLAYS) { const l = makeOverlay(o); if (l) overlays[o.name] = l; }
      }
      const fhLayers = floodHubOverlays(L);
      Object.assign(overlays, fhLayers);
      const fh = state.floodhub;
      const alerting = fh && fh.configured && (((fh.flashFloodEvents || []).length > 0)
        || (fh.gauges || []).some((g) => g.status && sev(g.status.severity).rank >= 2));
      if (alerting) Object.values(fhLayers).forEach((l) => l.addTo(m));
      buildLayerLists(m, layers, overlays, first);
      m.on('overlayadd overlayremove zoomend', renderOverlayLegend);
      m.on('layeradd layerremove', syncLayerLists);
      window.__floodTestZoom = (lat, lng, z) => m.setView([lat, lng], z, { animate: false });
      window.__floodSetOverlay = (name, on) => {
        const l = overlays[name];
        if (!l) return false;
        if (on) l.addTo(m); else m.removeLayer(l);
        renderOverlayLegend();
        return true;
      };
      m.on('baselayerchange', (e) => {
        status.basemap = e.name;
        try { localStorage.setItem(BASEMAP_KEY, e.name); } catch (err) { /* storage blocked */ }
      });
      // for the automated browser check
      window.__floodSetBasemap = (name) => setBasemap(m, layers, name);
      state.overlay = L.imageOverlay(BLANK, bounds, {
        opacity: parseFloat($('floodOpacity').value) / 100, className: 'flood-layer',
      }).addTo(m);
      state.gaugeMarker = L.circleMarker(bounds.getCenter(), {
        radius: 8, color: '#ffffff', weight: 2.5, fillColor: '#c66f1d', fillOpacity: 1,
      }).addTo(m);
      state.gaugeMarker.bindTooltip('Gauge', { direction: 'top', offset: [0, -8] });
      L.control.scale({ imperial: false }).addTo(m);
      m.on('click', onGeoClick);
      m.on('mousemove', onGeoMove);
      m.on('locationfound', onLocated);
      m.on('locationerror', (e) => { say(`Couldn’t get your location: ${e.message}`); });
      state.lmap = m;
    } else {
      state.overlay.setBounds(bounds);
    }
    state.lmap.invalidateSize();
    state.lmap.fitBounds(bounds);
    status.mode = 'map';
    return true;
  }


  function finePointer() {
    try { return window.matchMedia('(pointer: fine)').matches; } catch (e) { return true; }
  }

  // Basemap radios and overlay checkboxes in the Layers panel
  let layerRegistry = null;
  function setBasemap(m, layers, name) {
    if (!layers[name]) return;
    Object.values(layers).forEach((l) => m.hasLayer(l) && m.removeLayer(l));
    layers[name].addTo(m);
    layers[name].bringToBack();
    status.basemap = name;
    try { localStorage.setItem(BASEMAP_KEY, name); } catch (err) { /* storage blocked */ }
    syncLayerLists();
  }

  function buildLayerLists(m, layers, overlays, first) {
    layerRegistry = { m, layers, overlays };
    const bl = $('basemapList');
    bl.innerHTML = '';
    Object.keys(layers).forEach((name, i) => {
      const id = 'bm-' + i;
      const lab = document.createElement('label');
      lab.className = 'check';
      lab.innerHTML = `<input type="radio" name="basemap" id="${id}"> ${escapeHtml(name)}`;
      const input = lab.querySelector('input');
      input.checked = name === first;
      input.addEventListener('change', () => input.checked && setBasemap(m, layers, name));
      bl.appendChild(lab);
    });
    const ol = $('overlayList');
    ol.innerHTML = '';
    const names = Object.keys(overlays);
    $('overlaySet').hidden = !names.length;
    names.forEach((name, i) => {
      const id = 'ov-' + i;
      const lab = document.createElement('label');
      lab.className = 'check';
      lab.innerHTML = `<input type="checkbox" id="${id}"> ${escapeHtml(name)}`;
      const input = lab.querySelector('input');
      input.dataset.layer = name;
      input.checked = m.hasLayer(overlays[name]);
      input.addEventListener('change', () => {
        if (input.checked) overlays[name].addTo(m); else m.removeLayer(overlays[name]);
        renderOverlayLegend();
      });
      ol.appendChild(lab);
    });
  }

  function syncLayerLists() {
    if (!layerRegistry) return;
    const { m, overlays } = layerRegistry;
    document.querySelectorAll('#overlayList input').forEach((inp) => {
      const l = overlays[inp.dataset.layer];
      if (l) inp.checked = m.hasLayer(l);
    });
    document.querySelectorAll('#basemapList input').forEach((inp, i) => {
      inp.checked = Object.keys(layerRegistry.layers)[i] === status.basemap;
    });
  }

  function leaveGeoMode() {
    state.geo = null;
    status.mode = 'static';
    $('map').hidden = false;
    $('lmap').hidden = true;
    $('geoControls').hidden = true;
    $('layersStaticNote').hidden = false;
  }

  function cellLatLng(i) {
    const a = state.a, g = state.geo;
    const x = (i % a.W) + 0.5, y = Math.floor(i / a.W) + 0.5;
    return [g.north - (y / a.H) * (g.north - g.south), g.west + (x / a.W) * (g.east - g.west)];
  }

  function latLngCell(ll) {
    const a = state.a, g = state.geo;
    const x = Math.floor(((ll.lng - g.west) / (g.east - g.west)) * a.W);
    const y = Math.floor(((g.north - ll.lat) / (g.north - g.south)) * a.H);
    if (x < 0 || y < 0 || x >= a.W || y >= a.H) return null;
    return { x, y, i: y * a.W + x };
  }

  let overlayGen = 0, overlayUrl = null;
  function drawGeoMap() {
    const a = state.a;
    const relief = $('showRelief').checked;
    const img = composeImage(relief);
    let n = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i]) n++;
    status.floodPixels = relief ? -1 : n;
    const off = state.offscreen;
    off.width = a.W; off.height = a.H;
    off.getContext('2d').putImageData(img, 0, 0);
    const gen = ++overlayGen;
    off.toBlob((blob) => {
      if (!blob || gen !== overlayGen) return;
      const url = URL.createObjectURL(blob);
      const old = overlayUrl;
      overlayUrl = url;
      state.overlay.setUrl(url);
      status.overlayUpdates++;
      if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    }, 'image/png');
    if (state.gauge >= 0) {
      state.gaugeMarker.setLatLng(cellLatLng(state.gauge));
      state.gaugeMarker.setTooltipContent(state.eventsApply ? 'Brisbane City gauge' : 'Gauge');
    }
  }

  function onGeoClick(e) {
    const c = latLngCell(e.latlng);
    if (!c) return;
    const s = $('moveGauge').checked ? F.snapToStream(state.a, c.x, c.y, 6, gaugeFloor()) : -1;
    let text;
    if (s >= 0 && s !== state.gauge) {
      state.gauge = s;
      state.base = null;
      runScenario();
      text = `Gauge moved here. ${describe(s)}`;
    } else {
      text = describe(c.i);
    }
    say(text);
    window.L.popup({ closeButton: false, autoPanPadding: [24, 24] })
      .setLatLng(e.latlng).setContent(escapeHtml(text)).openOn(state.lmap);
  }

  function onGeoMove(e) {
    const c = latLngCell(e.latlng);
    if (c) say(describe(c.i));
  }

  function onLocated(e) {
    const L = window.L;
    if (state.youMarker) state.youMarker.remove();
    state.youMarker = L.circleMarker(e.latlng, {
      radius: 7, color: '#ffffff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1,
    }).addTo(state.lmap);
    const c = latLngCell(e.latlng);
    say(c
      ? `Your location: ${describe(c.i)}`
      : 'Your location is outside the modelled area.');
  }

  $('floodOpacity').addEventListener('input', (e) => {
    if (state.overlay) state.overlay.setOpacity(parseFloat(e.target.value) / 100);
    $('floodOpacityOut').textContent = e.target.value + '%';
  });
  $('showRelief').addEventListener('change', () => { if (state.geo) drawGeoMap(); });
  $('locate').addEventListener('click', () => {
    if (!state.lmap || !state.geo) { say('Your location can be shown on maps of real places, such as the Lower Brisbane River.'); return; }
    say('Finding your location…');
    state.lmap.locate({ setView: true, maxZoom: 15 });
  });

  // Only sizeable rivers can carry the gauge: at least 5% of the main
  // river's flow accumulation where it leaves the grid.
  function gaugeFloor() {
    const a = state.a;
    return a.mainOutlet >= 0 ? a.acc[a.mainOutlet] * 0.05 : 0;
  }

  function isFlood(i) { return !(state.base && state.base.wet[i]) && !state.a.ocean[i]; }

  function drawStats(s) {
    const st = F.stats(state.a, state.run, state.base);
    const cells = [
      ['Land newly flooded', fmt(st.floodedKm2, 1), 'km²'],
      ['Deeper than 1 m', fmt(st.deepKm2, 1), 'km²'],
      ['Deepest water', fmt(st.maxDepth, 1), 'm'],
      ['Level at gauge', fmt(s.gaugeLevel, 2), 'm'],
    ];
    const ev = state.eventsApply && state.events.find((e) => Math.abs(e.level - parseFloat(ctl.gaugeLevel.value)) < 0.001);
    $('summaryLine').innerHTML = `<b>${ev ? ev.label + ' peak' : 'Gauge'}</b> ${fmt(s.gaugeLevel, 2)} m · ` +
      `${fmt(st.floodedKm2, 1)} km² newly flooded` + (parseFloat(ctl.slr.value) ? ` · +${ctl.slr.value} m sea level` : '');
    $('stats').innerHTML = cells.map(([k, v, u]) =>
      `<div class="stat"><div class="label">${k}</div><div class="v">${v}<small>${u}</small></div></div>`).join('');
  }

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function profilePath() {
    const a = state.a;
    if (state.gauge < 0) return [];
    const up = [];
    let c = state.gauge;
    for (;;) {
      const W = a.W, cx = c % W, cy = Math.floor(c / W);
      let best = -1, bAcc = -1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= a.H) continue;
        const n = ny * W + nx;
        if (a.rec[n] === c && a.stream[n] && a.acc[n] > bAcc) { bAcc = a.acc[n]; best = n; }
      }
      if (best < 0) break;
      up.push(best); c = best;
    }
    const down = [];
    c = state.gauge;
    while (c >= 0) { down.push(c); c = a.rec[c]; }
    return up.reverse().concat(down);
  }

  function drawProfile(s) {
    const a = state.a, run = state.run, base = state.base;
    const canvas = $('profile');
    if ($('panel-profile').hidden) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const path = profilePath();
    const ink = cssVar('--ink'), muted = cssVar('--muted'), line = cssVar('--line'), accent = cssVar('--accent'), gaugeC = cssVar('--gauge');
    if (path.length < 2) {
      ctx.fillStyle = muted; ctx.font = '13px Archivo, sans-serif';
      ctx.fillText('No river found. Tap a channel on the map to place the gauge.', 8, 24);
      $('profileNote').textContent = '';
      return;
    }
    const chainKm = path.map((c) => a.chain[c] / 1000);
    const bed = path.map((c) => a.dem[c]);
    const wse = path.map((c) => run.wse[c]);
    const norm = path.map((c) => base.wse[c]);
    const xMax = chainKm[0], xMin = chainKm[chainKm.length - 1];
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < path.length; i++) {
      yMin = Math.min(yMin, bed[i]); yMax = Math.max(yMax, wse[i], bed[i] > 40 ? 0 : bed[i]);
    }
    yMax = Math.min(Math.max(yMax, s.gaugeLevel + 1), Math.max(s.gaugeLevel + 4, 12));
    yMin = Math.max(Math.floor(yMin), -15);
    const L = { l: 40, r: 12, t: 10, b: 26 };
    const X = (km) => L.l + ((xMax - km) / (xMax - xMin || 1)) * (cw - L.l - L.r);
    const Y = (z) => ch - L.b - ((z - yMin) / (yMax - yMin || 1)) * (ch - L.t - L.b);

    // grid + y ticks
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.strokeStyle = line; ctx.fillStyle = muted; ctx.lineWidth = 1;
    const step = niceStep((yMax - yMin) / 4);
    for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) {
      ctx.beginPath(); ctx.moveTo(L.l, Y(v)); ctx.lineTo(cw - L.r, Y(v)); ctx.stroke();
      ctx.fillText(`${+v.toFixed(1)}`, 4, Y(v) + 4);
    }
    const xs = niceStep((xMax - xMin) / 5);
    for (let v = Math.ceil(xMin / xs) * xs; v <= xMax; v += xs) {
      ctx.fillText(`${+v.toFixed(1)}`, X(v) - 8, ch - 8);
    }
    ctx.fillText('m', 4, L.t + 2);

    // bed
    ctx.beginPath();
    ctx.moveTo(X(chainKm[0]), Y(Math.max(yMin, Math.min(yMax, bed[0]))));
    for (let i = 1; i < path.length; i++) ctx.lineTo(X(chainKm[i]), Y(Math.max(yMin, Math.min(yMax, bed[i]))));
    ctx.lineTo(X(chainKm[path.length - 1]), ch - L.b); ctx.lineTo(X(chainKm[0]), ch - L.b); ctx.closePath();
    ctx.fillStyle = 'rgba(150,128,104,0.55)'; ctx.fill();

    // normal water (dashed) and flood surface
    const lineOf = (arr, color, width, dash) => {
      ctx.beginPath();
      for (let i = 0; i < path.length; i++) {
        const v = Math.max(yMin, Math.min(yMax, arr[i]));
        if (i) ctx.lineTo(X(chainKm[i]), Y(v)); else ctx.moveTo(X(chainKm[i]), Y(v));
      }
      ctx.setLineDash(dash || []); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke(); ctx.setLineDash([]);
    };
    lineOf(norm, muted, 1.2, [4, 4]);
    lineOf(wse, accent, 2.4);

    // gauge
    const gk = a.chain[state.gauge] / 1000;
    ctx.strokeStyle = gaugeC; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(X(gk), L.t); ctx.lineTo(X(gk), ch - L.b); ctx.stroke();
    ctx.fillStyle = gaugeC; ctx.font = '600 11px Archivo, sans-serif';
    ctx.fillText('gauge', Math.min(X(gk) + 4, cw - 40), L.t + 10);
    ctx.fillStyle = ink;
    $('profileNote').textContent = 'Blue: flood level · dashed: normal level · brown: riverbed · x: km to the mouth';
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }


  /* ------------------------------------------------- Google Flood Hub */
  // Forecasts are fetched by the GitHub build (pipeline/fetch_floodhub.py)
  // and published as data/floodhub.json and data/floodhub.geojson, so no API
  // key is exposed in the page.

  const SEVERITY = {
    EXTREME: { label: 'Extreme', color: '#6a1b9a', rank: 4 },
    SEVERE: { label: 'Severe', color: '#c62828', rank: 3 },
    ABOVE_NORMAL: { label: 'Above normal', color: '#e65100', rank: 2 },
    NO_FLOODING: { label: 'No flooding', color: '#2e7d32', rank: 1 },
    UNKNOWN: { label: 'Unknown', color: '#607d8b', rank: 0 },
  };
  const sev = (k) => SEVERITY[k] || SEVERITY.UNKNOWN;
  const FH_ATTR = 'Forecasts &copy; <a href="https://sites.research.google/floods/">Google Flood Hub</a>, CC BY 4.0';

  async function loadFloodHub() {
    status.floodhub = { loaded: false };
    try {
      const r = await fetch('data/floodhub.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(String(r.status));
      state.floodhub = await r.json();
      if (state.floodhub.configured) {
        const g = await fetch('data/floodhub.geojson', { cache: 'no-cache' });
        state.floodhubAreas = g.ok ? await g.json() : null;
      }
    } catch (e) {
      state.floodhub = null;
    }
    const fh = state.floodhub;
    status.floodhub = { loaded: !!fh, configured: !!(fh && fh.configured), gauges: fh && fh.gauges ? fh.gauges.length : 0 };
    renderFloodHub();
  }

  function ago(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const h = (Date.now() - t) / 3.6e6;
    if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
    if (h < 48) return `${Math.round(h)} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }

  function unitOf(g) {
    const u = g.model && g.model.gaugeValueUnit;
    return u === 'METERS' ? 'm' : u === 'CUBIC_METERS_PER_SECOND' ? 'm³/s' : '';
  }

  function gaugeLine(g) {
    const st = g.status || {};
    const parts = [];
    const trend = { RISE: 'rising', FALL: 'falling', NO_CHANGE: 'steady' }[st.forecastTrend];
    if (trend) parts.push(trend);
    if (g.forecast && g.forecast.values.length) {
      const peak = Math.max(...g.forecast.values.map((v) => v[1]).filter(Number.isFinite));
      if (Number.isFinite(peak)) parts.push(`forecast peak ${peak.toFixed(peak < 10 ? 2 : 0)} ${unitOf(g)}`);
    }
    const th = g.model && g.model.thresholds;
    if (th && th.warningLevel != null) parts.push(`warning ${th.warningLevel} ${unitOf(g)}`);
    if (g.status && g.status.qualityVerified === false) parts.push('unverified model');
    return parts.join(' · ');
  }

  function renderFloodHub() {
    const box = $('floodhubBody');
    const fh = state.floodhub;
    if (!fh) {
      box.innerHTML = '<p class="hint">Forecast data isn’t available right now.</p>';
      return;
    }
    if (!fh.configured) {
      box.innerHTML = '<p class="hint">Live Google river and flash flood forecasts aren’t switched on for this site yet. See the project README to connect them.</p>';
      return;
    }
    const gauges = (fh.gauges || []).filter((g) => g.status);
    gauges.sort((a, b) => sev(b.status.severity).rank - sev(a.status.severity).rank);
    const flooding = gauges.filter((g) => sev(g.status.severity).rank >= 2);
    const flash = (fh.flashFloodEvents || []).length;
    $('forecastBadge').hidden = !(flooding.length || flash);
    let html = '';
    if (!flooding.length && !flash) {
      html += `<p>No flooding forecast at ${gauges.length} Flood Hub gauge${gauges.length === 1 ? '' : 's'} in South East Queensland.</p>`;
    } else {
      const bits = [];
      if (flooding.length) bits.push(`${flooding.length} gauge${flooding.length === 1 ? '' : 's'} forecast above normal`);
      if (flash) bits.push(`${flash} flash flood forecast${flash === 1 ? '' : 's'} nearby`);
      html += `<p><strong>${escapeHtml(bits.join(' and '))}.</strong> Their locations are shown on the Brisbane street map.</p>`;
    }
    const show = gauges.slice(0, 6);
    if (show.length) {
      html += '<ul class="fh-list">' + show.map((g) => {
        const s = sev(g.status.severity);
        const name = [g.siteName, g.river].filter(Boolean).join(', ') || `Gauge ${g.gaugeId}`;
        return `<li><span class="sev" style="background:${s.color}">${s.label}</span>` +
          `<span class="where">${escapeHtml(name)}</span><span class="detail">${escapeHtml(gaugeLine(g))}</span></li>`;
      }).join('') + '</ul>';
    }
    html += `<p class="fh-meta">Updated ${escapeHtml(ago(fh.fetched))} from Google Flood Hub (CC BY 4.0). Google’s forecasts are experimental; follow <a href="https://www.bom.gov.au/qld/warnings/" target="_blank" rel="noopener">Bureau of Meteorology warnings</a>.</p>`;
    if (fh.errors && fh.errors.length) html += `<p class="fh-meta">Some forecast data could not be fetched on the last update.</p>`;
    box.innerHTML = html;
  }

  // Map layers for Flood Hub gauges and forecast / flash-flood areas
  function floodHubOverlays(L) {
    const fh = state.floodhub;
    const out = {};
    if (!fh || !fh.configured) return out;
    const gauges = (fh.gauges || []).filter((g) => g.location);
    if (gauges.length) {
      const grp = L.layerGroup();
      gauges.forEach((g) => {
        const s = sev(g.status && g.status.severity);
        const name = [g.siteName, g.river].filter(Boolean).join(', ') || `Gauge ${g.gaugeId}`;
        L.circleMarker([g.location.latitude, g.location.longitude], {
          radius: 7, color: '#ffffff', weight: 2, fillColor: g.status ? s.color : '#90a4ae', fillOpacity: 1,
          attribution: FH_ATTR,
        }).bindPopup(`<strong>${escapeHtml(name)}</strong><br>${g.status ? escapeHtml(s.label) : 'No forecast'}` +
          `${gaugeLine(g) ? '<br>' + escapeHtml(gaugeLine(g)) : ''}<br><small>Google Flood Hub</small>`).addTo(grp);
      });
      grp.getAttribution = () => FH_ATTR;
      out['Google Flood Hub gauges'] = grp;
    }
    const areas = state.floodhubAreas && state.floodhubAreas.features;
    if (areas && areas.length) {
      const lvl = { HIGH: 0.55, HIGHLY_LIKELY: 0.55, MEDIUM: 0.4, LOW: 0.25, LIKELY: 0.3 };
      out['Google Flood Hub flood areas'] = L.geoJSON(state.floodhubAreas, {
        attribution: FH_ATTR,
        style: (f) => {
          const flash = f.properties.kind === 'flash-flood';
          const c = flash ? '#d81b60' : '#1565c0';
          return { color: c, weight: 1.5, fillColor: c, fillOpacity: lvl[f.properties.level] || 0.3 };
        },
        onEachFeature: (f, layer) => {
          const p = f.properties;
          const what = p.kind === 'flash-flood'
            ? `Flash flood forecast (${(p.level || '').replace('_', ' ').toLowerCase()})${p.hours ? `, next ${p.hours} h` : ''}`
            : `River flood forecast area, ${String(p.level || '').toLowerCase()} ${p.mapType === 'DEPTH' ? 'depth' : 'likelihood'}`;
          layer.bindPopup(escapeHtml(what) + '<br><small>Google Flood Hub</small>');
        },
      });
    }
    return out;
  }

  /* -------------------------------------------------------- interaction */

  function cellAt(ev) {
    const canvas = $('map'), r = canvas.getBoundingClientRect(), a = state.a;
    const x = Math.floor(((ev.clientX - r.left) / r.width) * a.W);
    const y = Math.floor(((ev.clientY - r.top) / r.height) * a.H);
    if (x < 0 || y < 0 || x >= a.W || y >= a.H) return null;
    return { x, y, i: y * a.W + x };
  }

  function describe(i) {
    const a = state.a, run = state.run;
    if (!a.valid[i]) return 'No data here.';
    const parts = [`Ground ${fmt(a.dem[i], 1)} m`];
    if (a.ocean[i]) parts.push('sea');
    else if (run.wet[i]) parts.push(`water ${fmt(run.depth[i], 2)} m deep`, `level ${fmt(run.level[i], 2)} m`);
    else parts.push('dry');
    return parts.join(' · ');
  }

  $('map').addEventListener('mousemove', (ev) => {
    if (!state.a) return;
    const c = cellAt(ev);
    if (c) say(describe(c.i));
  });
  $('map').addEventListener('click', (ev) => {
    if (!state.a) return;
    const c = cellAt(ev);
    if (!c) return;
    const s = F.snapToStream(state.a, c.x, c.y, 8, gaugeFloor());
    if (s >= 0 && s !== state.gauge) {
      state.gauge = s;
      state.base = null;
      runScenario();
      say(`Gauge moved. ${describe(s)}`);
    } else {
      say(describe(c.i));
    }
  });

  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      if (!state.run) return;
      if (state.geo && state.lmap) state.lmap.invalidateSize(); else drawMap();
      drawProfile(scenario());
    }, 120);
  });
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.tiles) state.tiles.setUrl(isDark() ? TILES.dark : TILES.light);
      if (state.run) drawProfile(scenario());
    });
  } catch (e) { /* older browsers */ }

  $('area').addEventListener('change', (ev) => {
    if (ev.target.value === 'upload') return;
    loadArea(ev.target.value);
  });

  /* ------------------------------------------------------------- text */

  function renderNotice() {
    const m = state.areaMeta || {};
    let html;
    if (m.synthetic) {
      html = '<strong>Illustrative terrain.</strong> This sample is generated, not real Brisbane elevation. It shows how the model behaves. Pick a processed area or load a DEM for real ground levels.';
    } else if (m.upload) {
      html = `<strong>Your terrain.</strong> ${m.routedBy === 'pointers' ? 'Flow directions come from your d8.tif.' : 'Flow directions were computed in your browser.'} Set the gauge level for your river; the historic Brisbane peaks don’t apply here.`;
    } else {
      html = `<strong>Screening only.</strong> ${escapeHtml(m.source || '')} A surface model includes buildings and trees, so expect errors in built-up areas. Do not use for evacuation or property decisions.`;
    }
    $('notice').innerHTML = html;
    $('noticePill').textContent = m.synthetic ? 'Illustrative terrain' : m.upload ? 'Your terrain' : 'Screening only';
  }

  function renderInfo() {
    const m = state.areaMeta || {}, a = state.a;
    const lines = [];
    lines.push(`<span class="label">Terrain</span><br>${a.W} × ${a.H} cells at ${fmt(a.cell, 0)} m.`);
    if (m.synthetic) lines.push('Flow routing computed in the browser (priority-flood and D8).');
    else if (m.processedWith) lines.push(`Flow directions from ${escapeHtml(m.processedWith)}, run ${escapeHtml(m.generated || '')}.`);
    if (m.source) lines.push(escapeHtml(m.source));
    $('dataInfo').innerHTML = lines.join(' ');
    const dl = $('downloads');
    dl.innerHTML = '';
    (m.rasters || []).forEach((r) => {
      const link = document.createElement('a');
      link.href = `data/${m.id}/${r.file}`; link.textContent = r.name; link.target = '_blank'; link.rel = 'noopener';
      dl.appendChild(link);
    });
    if ((m.rasters || []).length) {
      const t = document.createElement('span'); t.className = 'hint'; t.textContent = 'GeoTIFFs for RustGIS or QGIS:';
      dl.prepend(t);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showError(msg) {
    $('notice').innerHTML = `<strong>Problem.</strong> ${escapeHtml(msg)}`;
  }


  /* --------------------------------------------------------- panels */
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

  function openPanel(id) {
    const target = $(id);
    if (!target) return;
    document.querySelectorAll('[data-panel]').forEach((p) => {
      if (p === target) return;
      if (isPhone() || p.dataset.side === target.dataset.side) p.hidden = true;
    });
    target.hidden = false;
    syncPanels();
    if (id === 'panel-profile' && state.run) drawProfile(scenario());
  }

  function closePanel(id) {
    $(id).hidden = true;
    syncPanels();
  }

  function syncPanels() {
    document.querySelectorAll('.tool[data-open]').forEach((b) => {
      b.setAttribute('aria-pressed', String(!$(b.dataset.open).hidden));
    });
    document.body.classList.toggle('sheet-open', !!document.querySelector('[data-panel]:not([hidden])'));
  }

  document.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.open;
      if (b.classList.contains('tool') && !$(id).hidden) closePanel(id);
      else openPanel(id);
    });
  });
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => closePanel(b.closest('[data-panel]').id));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = Array.from(document.querySelectorAll('[data-panel]:not([hidden])'));
    const right = open.find((p) => p.dataset.side === 'right');
    if (right || open[0]) closePanel((right || open[0]).id);
  });
  window.__floodOpenPanel = openPanel;

  let sayT = 0;
  function say(text) {
    const r = $('readout');
    r.textContent = text;
    r.hidden = !text;
    clearTimeout(sayT);
    sayT = setTimeout(() => { r.hidden = true; }, 5000);
  }

  $('legendToggle').addEventListener('click', (e) => {
    const shown = e.target.getAttribute('aria-expanded') === 'true';
    $('depthLegend').hidden = shown;
    if (shown) $('overlayLegend').hidden = true; else renderOverlayLegend();
    e.target.setAttribute('aria-expanded', String(!shown));
    e.target.textContent = shown ? 'Show key' : 'Hide key';
  });

  /* -------------------------------------------------------------- start */

  (async function start() {
    ctl.bayLevel.value = 1.0;
    ctl.grad.value = 0.3;
    ctl.extra.value = 0;
    ctl.gaugeLevel.value = 4.46;
    syncOutputs();
    if (!isPhone()) openPanel('panel-scenario');
    const areas = await listAreas();
    await loadFloodHub();
    await loadArea(areas[0].id);
  })();
})();
