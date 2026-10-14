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
    const wrap = $('mapWrap');
    const maxH = Math.max(260, window.innerHeight * 0.68);
    const cssW = Math.min(wrap.parentElement.clientWidth - 20, (maxH * a.W) / a.H);
    wrap.style.maxWidth = cssW + 'px';
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
  const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  const status = (window.__floodStatus = { mode: 'static', overlayUpdates: 0, tilesLoaded: 0, tileErrors: 0, floodPixels: 0 });

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
        js.onload = () => resolve();
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
      $('readout').textContent = `${err.message} Showing the terrain picture instead.`;
      return false;
    }
    const L = window.L;
    state.geo = { west: b[0], south: b[1], east: b[2], north: b[3] };
    $('map').hidden = true;
    $('lmap').hidden = false;
    $('geoControls').hidden = false;
    $('mapWrap').style.maxWidth = '';
    const bounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
    if (!state.lmap) {
      const m = L.map('lmap', { maxBounds: bounds.pad(0.6), minZoom: 9, zoomSnap: 0.5 });
      state.tiles = L.tileLayer(isDark() ? TILES.dark : TILES.light, {
        attribution: TILE_ATTR, subdomains: 'abcd', maxZoom: 19,
      }).addTo(m);
      state.tiles.on('tileload', () => { status.tilesLoaded++; });
      state.tiles.on('tileerror', () => { status.tileErrors++; });
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
      m.on('locationerror', (e) => { $('readout').textContent = `Couldn’t get your location: ${e.message}`; });
      state.lmap = m;
    } else {
      state.overlay.setBounds(bounds);
    }
    state.lmap.invalidateSize();
    state.lmap.fitBounds(bounds);
    status.mode = 'map';
    return true;
  }

  function leaveGeoMode() {
    state.geo = null;
    status.mode = 'static';
    $('map').hidden = false;
    $('lmap').hidden = true;
    $('geoControls').hidden = true;
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
    const s = F.snapToStream(state.a, c.x, c.y, 6);
    let text;
    if (s >= 0 && s !== state.gauge && $('moveGauge').checked) {
      state.gauge = s;
      state.base = null;
      runScenario();
      text = `Gauge moved here. ${describe(s)}`;
    } else {
      text = describe(c.i);
    }
    $('readout').textContent = text;
    window.L.popup({ closeButton: false, autoPanPadding: [24, 24] })
      .setLatLng(e.latlng).setContent(escapeHtml(text)).openOn(state.lmap);
  }

  function onGeoMove(e) {
    const c = latLngCell(e.latlng);
    if (c) $('readout').textContent = describe(c.i);
  }

  function onLocated(e) {
    const L = window.L;
    if (state.youMarker) state.youMarker.remove();
    state.youMarker = L.circleMarker(e.latlng, {
      radius: 7, color: '#ffffff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1,
    }).addTo(state.lmap);
    const c = latLngCell(e.latlng);
    $('readout').textContent = c
      ? `Your location: ${describe(c.i)}`
      : 'Your location is outside the modelled area.';
  }

  $('floodOpacity').addEventListener('input', (e) => {
    if (state.overlay) state.overlay.setOpacity(parseFloat(e.target.value) / 100);
    $('floodOpacityOut').textContent = e.target.value + '%';
  });
  $('showRelief').addEventListener('change', () => { if (state.geo) drawGeoMap(); });
  $('locate').addEventListener('click', () => {
    if (!state.lmap) return;
    $('readout').textContent = 'Finding your location…';
    state.lmap.locate({ setView: true, maxZoom: 15 });
  });

  function isFlood(i) { return !(state.base && state.base.wet[i]) && !state.a.ocean[i]; }

  function drawStats(s) {
    const st = F.stats(state.a, state.run, state.base);
    const cells = [
      ['Land newly flooded', fmt(st.floodedKm2, 1), 'km²'],
      ['Deeper than 1 m', fmt(st.deepKm2, 1), 'km²'],
      ['Deepest water', fmt(st.maxDepth, 1), 'm'],
      ['Level at gauge', fmt(s.gaugeLevel, 2), 'm'],
    ];
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
    if (c) $('readout').textContent = describe(c.i);
  });
  $('map').addEventListener('click', (ev) => {
    if (!state.a) return;
    const c = cellAt(ev);
    if (!c) return;
    const s = F.snapToStream(state.a, c.x, c.y, 8);
    if (s >= 0 && s !== state.gauge) {
      state.gauge = s;
      state.base = null;
      runScenario();
      $('readout').textContent = `Gauge moved. ${describe(s)}`;
    } else {
      $('readout').textContent = describe(c.i);
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

  /* -------------------------------------------------------------- start */

  (async function start() {
    ctl.bayLevel.value = 1.0;
    ctl.grad.value = 0.3;
    ctl.extra.value = 0;
    ctl.gaugeLevel.value = 4.46;
    syncOutputs();
    const areas = await listAreas();
    await loadArea(areas[0].id);
  })();
})();
