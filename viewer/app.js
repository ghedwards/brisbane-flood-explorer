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
      controls: (state.controls || []).map((c) => ({ cell: c.cell, level: c.level })),
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

  // One-tap places to model: a point on the river near the town's flood
  // gauge, or on the shore for coasts. The model snaps to the main channel.
  // Well-known flood sites and populated flood-prone places, by state.
  const PRESETS = [
    { id: 'ipswich', name: 'Ipswich, Bremer River (Qld)', state: 'Qld', lat: -27.6135, lon: 152.7625, kind: 'river' },
    { id: 'logan', name: 'Logan River, Waterford (Qld)', state: 'Qld', lat: -27.6960, lon: 153.1440, kind: 'river' },
    { id: 'grantham', name: 'Grantham, Lockyer Creek (Qld)', state: 'Qld', lat: -27.5790, lon: 152.2010, kind: 'river' },
    { id: 'gympie', name: 'Gympie, Mary River (Qld)', state: 'Qld', lat: -26.1835, lon: 152.6620, kind: 'river' },
    { id: 'maryborough', name: 'Maryborough, Mary River (Qld)', state: 'Qld', lat: -25.5340, lon: 152.7050, kind: 'river' },
    { id: 'bundaberg', name: 'Bundaberg, Burnett River (Qld)', state: 'Qld', lat: -24.8650, lon: 152.3480, kind: 'river' },
    { id: 'rockhampton', name: 'Rockhampton, Fitzroy River (Qld)', state: 'Qld', lat: -23.3765, lon: 150.5125, kind: 'river' },
    { id: 'emerald', name: 'Emerald, Nogoa River (Qld)', state: 'Qld', lat: -23.5240, lon: 148.1550, kind: 'river' },
    { id: 'mackay', name: 'Mackay, Pioneer River (Qld)', state: 'Qld', lat: -21.1410, lon: 149.1820, kind: 'river' },
    { id: 'townsville', name: 'Townsville, Ross River (Qld)', state: 'Qld', lat: -19.2880, lon: 146.7900, kind: 'river' },
    { id: 'ingham', name: 'Ingham, Herbert River (Qld)', state: 'Qld', lat: -18.6400, lon: 146.1600, kind: 'river' },
    { id: 'charleville', name: 'Charleville, Warrego River (Qld)', state: 'Qld', lat: -26.4020, lon: 146.2350, kind: 'river' },
    { id: 'stgeorge', name: 'St George, Balonne River (Qld)', state: 'Qld', lat: -28.0370, lon: 148.5820, kind: 'river' },
    { id: 'goondiwindi', name: 'Goondiwindi, Macintyre River (Qld)', state: 'Qld', lat: -28.5400, lon: 150.3100, kind: 'river' },
    { id: 'lismore', name: 'Lismore, Wilsons River (NSW)', state: 'NSW', lat: -28.8090, lon: 153.2765, kind: 'river' },
    { id: 'murwillumbah', name: 'Murwillumbah, Tweed River (NSW)', state: 'NSW', lat: -28.3270, lon: 153.3960, kind: 'river' },
    { id: 'grafton', name: 'Grafton, Clarence River (NSW)', state: 'NSW', lat: -29.6915, lon: 152.9355, kind: 'river' },
    { id: 'kempsey', name: 'Kempsey, Macleay River (NSW)', state: 'NSW', lat: -31.0800, lon: 152.8380, kind: 'river' },
    { id: 'portmacquarie', name: 'Port Macquarie, Hastings River (NSW)', state: 'NSW', lat: -31.4300, lon: 152.9050, kind: 'river' },
    { id: 'taree', name: 'Taree, Manning River (NSW)', state: 'NSW', lat: -31.9030, lon: 152.4620, kind: 'river' },
    { id: 'maitland', name: 'Maitland, Hunter River (NSW)', state: 'NSW', lat: -32.7280, lon: 151.5560, kind: 'river' },
    { id: 'windsor', name: 'Windsor, Hawkesbury River (NSW)', state: 'NSW', lat: -33.6045, lon: 150.8225, kind: 'river' },
    { id: 'liverpool', name: 'Liverpool, Georges River (NSW)', state: 'NSW', lat: -33.9250, lon: 150.9320, kind: 'river' },
    { id: 'moree', name: 'Moree, Mehi River (NSW)', state: 'NSW', lat: -29.4710, lon: 149.8450, kind: 'river' },
    { id: 'dubbo', name: 'Dubbo, Macquarie River (NSW)', state: 'NSW', lat: -32.2470, lon: 148.6000, kind: 'river' },
    { id: 'forbes', name: 'Forbes, Lachlan River (NSW)', state: 'NSW', lat: -33.3850, lon: 148.0100, kind: 'river' },
    { id: 'wagga', name: 'Wagga Wagga, Murrumbidgee River (NSW)', state: 'NSW', lat: -35.1030, lon: 147.3680, kind: 'river' },
    { id: 'gundagai', name: 'Gundagai, Murrumbidgee River (NSW)', state: 'NSW', lat: -35.0650, lon: 148.1050, kind: 'river' },
    { id: 'maribyrnong', name: 'Maribyrnong River, Melbourne (Vic)', state: 'Vic', lat: -37.7760, lon: 144.8890, kind: 'river' },
    { id: 'echuca', name: 'Echuca, Murray River (Vic)', state: 'Vic', lat: -36.1240, lon: 144.7520, kind: 'river' },
    { id: 'rochester', name: 'Rochester, Campaspe River (Vic)', state: 'Vic', lat: -36.3630, lon: 144.7050, kind: 'river' },
    { id: 'shepparton', name: 'Shepparton, Goulburn River (Vic)', state: 'Vic', lat: -36.3720, lon: 145.4070, kind: 'river' },
    { id: 'seymour', name: 'Seymour, Goulburn River (Vic)', state: 'Vic', lat: -37.0270, lon: 145.1460, kind: 'river' },
    { id: 'benalla', name: 'Benalla, Broken River (Vic)', state: 'Vic', lat: -36.5510, lon: 145.9830, kind: 'river' },
    { id: 'kerang', name: 'Kerang, Loddon River (Vic)', state: 'Vic', lat: -35.7320, lon: 143.9200, kind: 'river' },
    { id: 'traralgon', name: 'Traralgon, Traralgon Creek (Vic)', state: 'Vic', lat: -38.1950, lon: 146.5360, kind: 'river' },
    { id: 'bairnsdale', name: 'Bairnsdale, Mitchell River (Vic)', state: 'Vic', lat: -37.8320, lon: 147.6200, kind: 'river' },
    { id: 'murraybridge', name: 'Murray Bridge, Murray River (SA)', state: 'SA', lat: -35.1180, lon: 139.2750, kind: 'river' },
    { id: 'gawler', name: 'Gawler, Gawler River (SA)', state: 'SA', lat: -34.6010, lon: 138.7360, kind: 'river' },
    { id: 'guildford', name: 'Guildford, Swan River, Perth (WA)', state: 'WA', lat: -31.9000, lon: 115.9700, kind: 'river' },
    { id: 'carnarvon', name: 'Carnarvon, Gascoyne River (WA)', state: 'WA', lat: -24.8800, lon: 113.6650, kind: 'river' },
    { id: 'fitzroycrossing', name: 'Fitzroy Crossing, Fitzroy River (WA)', state: 'WA', lat: -18.1960, lon: 125.5780, kind: 'river' },
    { id: 'launceston', name: 'Launceston, Tamar River (Tas)', state: 'Tas', lat: -41.4330, lon: 147.1430, kind: 'river' },
    { id: 'latrobe', name: 'Latrobe, Mersey River (Tas)', state: 'Tas', lat: -41.2370, lon: 146.4140, kind: 'river' },
    { id: 'huonville', name: 'Huonville, Huon River (Tas)', state: 'Tas', lat: -43.0300, lon: 147.0480, kind: 'river' },
    { id: 'katherine', name: 'Katherine, Katherine River (NT)', state: 'NT', lat: -14.4660, lon: 132.2635, kind: 'river' },
    { id: 'cairns', name: 'Cairns waterfront (Qld)', state: 'Qld', lat: -16.9200, lon: 145.7800, kind: 'coast' },
    { id: 'herveybay', name: 'Hervey Bay (Qld)', state: 'Qld', lat: -25.2880, lon: 152.8400, kind: 'coast' },
    { id: 'maroochydore', name: 'Maroochydore, Sunshine Coast (Qld)', state: 'Qld', lat: -26.6530, lon: 153.0920, kind: 'coast' },
    { id: 'goldcoast', name: 'Gold Coast Broadwater (Qld)', state: 'Qld', lat: -27.9650, lon: 153.4100, kind: 'coast' },
    { id: 'ballina', name: 'Ballina, Richmond River mouth (NSW)', state: 'NSW', lat: -28.8700, lon: 153.5650, kind: 'coast' },
    { id: 'newcastle', name: 'Newcastle harbour (NSW)', state: 'NSW', lat: -32.9250, lon: 151.7800, kind: 'coast' },
    { id: 'elwood', name: 'Elwood, Port Phillip (Vic)', state: 'Vic', lat: -37.8830, lon: 144.9810, kind: 'coast' },
    { id: 'lakesentrance', name: 'Lakes Entrance (Vic)', state: 'Vic', lat: -37.8810, lon: 147.9810, kind: 'coast' },
    { id: 'portadelaide', name: 'Port Adelaide (SA)', state: 'SA', lat: -34.8460, lon: 138.5050, kind: 'coast' },
    { id: 'mandurah', name: 'Mandurah (WA)', state: 'WA', lat: -32.5300, lon: 115.7230, kind: 'coast' },
    { id: 'hobart', name: 'Hobart, Derwent estuary (Tas)', state: 'Tas', lat: -42.8820, lon: 147.3330, kind: 'coast' },
    { id: 'darwin', name: 'Darwin harbour (NT)', state: 'NT', lat: -12.4630, lon: 130.8420, kind: 'coast' },
  ];
  window.__floodPresets = PRESETS;

  function addGroup(sel, label, id) {
    const g = document.createElement('optgroup');
    g.label = label;
    if (id) g.id = id;
    sel.appendChild(g);
    return g;
  }
  function addOption(parent, value, text) {
    const op = document.createElement('option');
    op.value = value; op.textContent = text;
    parent.appendChild(op);
    return op;
  }

  async function listAreas() {
    const sel = $('area');
    sel.innerHTML = '';
    addOption(sel, 'australia', 'Australia: tap a river, dam or coast');
    addGroup(sel, 'Your modelled places', 'modelledGroup').hidden = true;
    const detailed = addGroup(sel, 'Detailed models');
    try {
      const r = await fetch('data/areas.json', { cache: 'no-cache' });
      if (r.ok) (await r.json()).forEach((x) => addOption(detailed, x.id, x.name.replace(/ \(Copernicus.*\)$/, '')));
    } catch (e) { /* no processed areas published yet */ }
    const groups = [
      ['Rivers: Queensland', (p) => p.kind === 'river' && p.state === 'Qld'],
      ['Rivers: New South Wales', (p) => p.kind === 'river' && p.state === 'NSW'],
      ['Rivers: Victoria', (p) => p.kind === 'river' && p.state === 'Vic'],
      ['Rivers: SA, WA, Tasmania, NT', (p) => p.kind === 'river' && !['Qld', 'NSW', 'Vic'].includes(p.state)],
      ['Coasts and estuaries', (p) => p.kind === 'coast'],
    ];
    for (const [label, test] of groups) {
      const g = addGroup(sel, label);
      PRESETS.filter(test).forEach((p) => addOption(g, `preset:${p.id}`, p.name));
    }
    return [{ id: 'australia' }];
  }

  // The illustrative sample terrain is only an offline fallback (when the
  // map library cannot load); it is not offered in the menu.
  function useSampleOption() {
    const sel = $('area');
    if (!sel.querySelector('option[value="sample"]')) addOption(sel, 'sample', 'Offline sample terrain (illustrative)');
    sel.value = 'sample';
  }

  function addModelledOption(key, name) {
    const g = $('modelledGroup');
    g.hidden = false;
    const op = addOption(g, key, name);
    return op;
  }

  async function loadArea(id) {
    if (areaReg.has(id)) { activateArea(id, { fit: true }); return; }
    if (id.startsWith('preset:')) {
      const p = PRESETS.find((x) => `preset:${x.id}` === id);
      if (!p) return;
      const done = Array.from(areaReg.values()).find((a) => a.areaMeta && a.areaMeta.presetId === p.id);
      if (done) { activateArea(done.key, { fit: true }); openPanel('panel-scenario'); return; }
      if (!state.lmap || $('lmap').hidden) await enterNational({ fit: false });
      await modelHere(p.lat, p.lon, { kind: p.kind, name: p.name.replace(/ \((NSW|Qld|Vic|Tas|SA|NT|WA)\)$/, ''), presetId: p.id });
      return;
    }
    if (id === 'australia') {
      setBusy(true, 'Loading the Australia-wide map…');
      try { await enterNational(); } finally { setBusy(false); }
      return;
    }
    setBusy(true, 'Loading terrain…');
    await nextFrame();
    try {
      if (id === 'sample') {
        const g = F.syntheticTerrain();
        state.areaMeta = { id: 'sample', name: 'Sample terrain', synthetic: true, streamAreaKm2: 4 };
        await useGrid(g, 'sample', { events: true });
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
        await useGrid({ W: meta.W, H: meta.H, cell: meta.cell, dem, valid, d8 }, id, { events: !!meta.brisbaneGauge });
      }
    } catch (err) {
      showError(`Could not load that terrain: ${err.message}`);
      if (id !== 'sample') { useSampleOption(); return loadArea('sample'); }
    } finally {
      setBusy(false);
    }
  }

  function okBuf(r) {
    if (!r.ok) throw new Error(`${r.url.split('/').pop()} returned ${r.status}`);
    return r.arrayBuffer();
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  // The flow analysis is the slow step (seconds on big areas): run it in a
  // background worker, falling back to the page if workers are unavailable.
  let worker = null, workerSeq = 0;
  const workerJobs = new Map();
  function getWorker() {
    if (worker === false) return null;
    if (!worker) {
      try {
        worker = new Worker('flood-worker.js');
        worker.onmessage = (e) => {
          const job = workerJobs.get(e.data.id);
          if (!job) return;
          workerJobs.delete(e.data.id);
          if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.a);
        };
        worker.onerror = (e) => {
          if (e && e.preventDefault) e.preventDefault();
          worker = false;           // e.g. opened from a file: do the work here
          workerJobs.forEach((job) => job.fallback());
          workerJobs.clear();
        };
      } catch (err) { worker = false; return null; }
    }
    return worker;
  }
  function analyseAsync(grid, opts) {
    const w = getWorker();
    if (!w) return nextFrame().then(() => F.analyse(grid, opts));
    return new Promise((resolve, reject) => {
      const id = ++workerSeq;
      workerJobs.set(id, { resolve, reject, fallback: () => resolve(F.analyse(grid, opts)) });
      w.postMessage({ id, grid, opts });
    });
  }

  async function useGrid(grid, id, opts) {
    // keep the area we're leaving on the map as it is
    const meta = state.areaMeta;
    const prev = state.areaKey && areaReg.get(state.areaKey);
    if (prev) { state.areaMeta = prev.areaMeta; saveActive(); state.areaMeta = meta; }
    state.areaKey = null;
    state.base = null; state.run = null;
    state.controls = [];
    state.grid = grid;
    state.areaId = id;
    status.area = id;
    state.eventsApply = !!opts.events;
    const areaKm2 = (grid.W * grid.H * grid.cell * grid.cell) / 1e6;
    state.streamAreaKm2 = (state.areaMeta && state.areaMeta.streamAreaKm2)
      || Math.min(4, Math.max(0.05, areaKm2 * 0.01));
    ctl.streamArea.value = sliderFromStream(state.streamAreaKm2);
    renderEvents();
    await reanalyse(true);
    // default levels
    ctl.gaugeLevel.min = 0;
    $('levelHint').hidden = true;
    if (state.eventsApply) ctl.gaugeLevel.value = 4.46;
    else if (state.gauge >= 0) {
      const surface = state.a.dem[state.gauge];
      ctl.gaugeLevel.min = Math.max(0, Math.floor(surface - 2));
      ctl.gaugeLevel.value = Math.round((surface + 3) * 20) / 20;
      $('levelHint').hidden = false;
      $('levelHint').textContent = `Heights are metres above sea level. The river surface at the gauge is about ${surface.toFixed(1)} m in the elevation model; the default is 3 m above that.`;
    }
    ctl.gaugeLevel.max = Math.max(10, Math.ceil(parseFloat(ctl.gaugeLevel.value) + 8));
    showScenarioEmpty(false);
    syncOutputs();
    renderInfo();
    const bl = state.areaMeta && state.areaMeta.bounds_lonlat;
    if (bl) {
      const m = state.areaMeta;
      const key = m.areaKey || (m.areaKey = m.local ? `local-${++localCount}` : m.id);
      state.geo = { west: bl[0], south: bl[1], east: bl[2], north: bl[3] };
      state.pendingGeo = true;
      const token = ++geoToken;
      enterGeoMode(bl).then((ok) => {
        if (token !== geoToken) return;   // switched to another area meanwhile
        state.pendingGeo = false;
        if (!ok) { state.geo = null; drawMap(); return; }
        const area = ensureArea(key);
        state.areaKey = key;
        setActiveLayers(area);
        renderAreaList();
        drawMap();
      });
    } else {
      leaveGeoMode();
    }
    runScenario();
  }

  async function reanalyse(resetGauge) {
    const g = state.grid;
    const a = await analyseAsync(g, { streamAreaKm2: state.streamAreaKm2 });
    if (state.grid !== g) return;   // another area was opened meanwhile
    state.a = a;
    let gauge = a.defaultGauge;
    if (!resetGauge && state.gauge >= 0) {
      const x = state.gauge % a.W, y = Math.floor(state.gauge / a.W);
      const s = F.snapToStream(a, x, y, 12);
      if (s >= 0) gauge = s;
    } else if (resetGauge && state.areaMeta && state.areaMeta.gauge) {
      const { col, row } = state.areaMeta.gauge;
      // biggest channel within ~1 km, then the nearest cell at least 30% of it
      let big = 0;
      for (let dy = -33; dy <= 33; dy++) for (let dx = -33; dx <= 33; dx++) {
        const x = col + dx, y = row + dy;
        if (x < 0 || y < 0 || x >= a.W || y >= a.H) continue;
        const i = y * a.W + x;
        if (a.stream[i] && a.acc[i] > big) big = a.acc[i];
      }
      const s = F.snapToStream(a, col, row, 33, big * 0.3);
      if (s >= 0) gauge = s;
      status.snap = { big, acc: s >= 0 ? a.acc[s] : null };
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
      await useGrid(grid, 'upload', { events: false });
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
    if (!state.base) {
      const base = state.eventsApply || state.gauge < 0
        ? BASELINE
        : { gaugeLevel: a.dem[state.gauge] + 0.3, bayLevel: 0 };
      state.base = F.inundate(a, Object.assign({}, s, base, { upstreamGradient: s.upstreamGradient }));
    }
    state.run = F.inundate(a, s);
    state.edges = floodEdges(a, state.run);
    drawMap();
    drawStats(s);
    renderEdgeNote();
    renderLevelPoints();
    drawProfile(s);
    renderNotice();
  }

  // Which sides of the model window the flood runs into (ignoring the sea
  // and the river channel itself, which always cross the edge).
  function floodEdges(a, run) {
    const { W, H } = a, hit = { north: 0, south: 0, west: 0, east: 0 };
    const land = (c) => run.wet[c] && !(a.ocean && a.ocean[c]) && !(a.stream && a.stream[c]);
    for (let x = 0; x < W; x++) { if (land(x)) hit.north++; if (land((H - 1) * W + x)) hit.south++; }
    for (let y = 0; y < H; y++) { if (land(y * W)) hit.west++; if (land(y * W + W - 1)) hit.east++; }
    const sides = Object.keys(hit).filter((k) => hit[k] >= 4);
    status.edges = sides;
    return sides;
  }

  const MODEL_SIZES = [[10, 30], [20, 30], [40, 60]];   // half-width km, cell m
  function renderEdgeNote() {
    const box = $('edgeNote');
    if (!box) return;
    const m = state.areaMeta || {}, sides = state.edges || [];
    const level = MODEL_SIZES.findIndex(([h]) => h === (m.halfKm || 10));
    const canGrow = m.local && level >= 0 && level < MODEL_SIZES.length - 1;
    box.hidden = scenarioEmpty || !m.local || !sides.length;
    if (box.hidden) return;
    const km = 2 * (m.halfKm || 10);
    const list = sides.length > 1 ? `${sides.slice(0, -1).join(', ')} and ${sides[sides.length - 1]}` : sides[0];
    box.innerHTML = `<p><strong>The flood reaches the ${list} edge${sides.length > 1 ? 's' : ''}</strong> of this ${km} km model, so it may go further than shown.</p>`
      + (canGrow ? `<button type="button" class="btn small" id="extendModel">Extend model area to ${2 * MODEL_SIZES[level + 1][0]} km</button>`
        : '<p class="hint">This is the largest model area. Model another place further along the river to see beyond it.</p>');
    const b = $('extendModel');
    if (b) b.addEventListener('click', () => extendModel());
  }

  // Rebuild the active on-demand model over a larger window, shifted toward
  // the edges the flood reaches; it keeps its number and scenario settings.
  async function extendModel() {
    const area = state.areaKey && areaReg.get(state.areaKey);
    const m = state.areaMeta || {};
    if (!area || !m.local || !m.gaugeLatLon) return false;
    const level = MODEL_SIZES.findIndex(([h]) => h === (m.halfKm || 10));
    if (level < 0 || level >= MODEL_SIZES.length - 1) return false;
    const [half, cell] = MODEL_SIZES[level + 1], grow = half - (m.halfKm || 10);
    const sides = state.edges || [];
    const [glat, glon] = m.gaugeLatLon, [clat, clon] = m.centerLatLon || m.gaugeLatLon;
    const dy = (sides.includes('north') ? 1 : 0) - (sides.includes('south') ? 1 : 0);
    const dx = (sides.includes('east') ? 1 : 0) - (sides.includes('west') ? 1 : 0);
    const center = [clat + (dy * grow * 1000) / 110574, clon + (dx * grow * 1000) / (111320 * Math.cos((clat * Math.PI) / 180))];
    const saved = {};
    CTL_KEYS.forEach((k) => { saved[k] = ctl[k].value; });
    const keep = { n: area.n, key: area.key, name: area.name };
    const ok = await modelHere(glat, glon, {
      kind: m.kind, name: area.name, reportId: m.reportId, presetId: m.presetId, pinN: m.pinN,
      halfKm: half, cellM: cell, center, keepN: area.n, streamAreaKm2: m.streamAreaKm2, replaceKey: keep.key,
    });
    if (!ok) return false;
    CTL_KEYS.forEach((k) => { if (k !== 'streamArea') ctl[k].value = saved[k]; });
    state.base = null;
    syncOutputs();
    runScenario();
    say(`Extended ${keep.name} to ${2 * half} km across.`);
    return true;
  }
  window.__floodExtendModel = extendModel;

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
    if (state.pendingGeo) return;            // the street map is still opening
    if (state.geo && state.lmap && state.overlay) drawGeoMap();
    else if (!state.geo) drawStaticMap();
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
    { name: 'Creek flooding likelihood (council)', service: 'Flood_Awareness_Creek', kind: 'likelihood', minZoom: 13, image: 'creek' },
    { name: 'Overland flow likelihood (council)', service: 'Flood_Awareness_Overland_Flow', kind: 'likelihood', minZoom: 14, image: 'overland' },
    { name: 'Recorded flood: Feb 2022 (river + creek)', service: 'Flood_Awareness_Historic_Brisbane_River_and_Creek_Floods_Feb2022', kind: 'outline', color: '#ff3d9a' },
    { name: 'Recorded flood: Jan 2011 (river)', service: 'Flood_Awareness_Historic_Brisbane_River_Floods_Jan2011', kind: 'outline', color: '#ffd400' },
    { name: 'Recorded flood: Jan 1974 (river)', service: 'Flood_Awareness_Historic_Brisbane_River_Floods_Jan1974', kind: 'outline', color: '#ff7a00' },
  ];

  // Available on every real-place map, anywhere in Australia
  const NATIONAL_OVERLAYS = [
    { name: 'Water seen by satellite since 1987 (DEA)', layers: 'ga_ls_wo_fq_myear_3', styles: 'mysummary_wofs_frequency_3', mosaic: 'water_frequency',
      legend: 'How often satellites have seen water there: pale = rarely (floods), dark blue = usually (rivers, lakes)' },
  ];

  // State flood mapping, drawn as images by each state's map server (so no
  // cross-site data access is needed). Shown wherever the state has data.
  const STATE_OVERLAYS = [
    { name: 'Queensland floodplain assessment (state)', state: 'QLD',
      url: 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/Boundaries/AdminBoundariesFramework/MapServer',
      layers: [15], opacity: 0.45,
      attribution: 'Queensland Floodplain Assessment Overlay &copy; State of Queensland, CC BY 4.0',
      legend: 'Queensland floodplain assessment: land that may be on a floodplain (statewide, broad scale)', swatch: '#4a7fc1' },
    { name: 'NSW flood planning areas (state)', state: 'NSW',
      url: 'https://mapprod3.environment.nsw.gov.au/arcgis/rest/services/Planning/Hazard/MapServer',
      layers: [1], opacity: 0.6, minZoom: 6,
      // the service hides this layer beyond 1:50,000; dynamic layers lift that
      dynamicLayers: [{ id: 1, source: { type: 'mapLayer', mapLayerId: 1 }, minScale: 0, maxScale: 0 }],
      attribution: 'Flood planning &copy; State of New South Wales (Department of Planning), from local environmental plans',
      legend: 'NSW flood planning areas from council planning schemes', swatch: '#3b6fb6' },
  ];

  function makeStateOverlay(o) {
    const esri = window.L && window.L.esri;
    if (!esri) return null;
    const st = (status.overlays[o.name] = { features: 0, errors: 0 });
    const layer = esri.dynamicMapLayer(Object.assign({
      url: o.url, layers: o.layers, opacity: o.opacity, attribution: o.attribution, f: 'image', format: 'png32',
      transparent: true, minZoom: o.minZoom || 0, zIndex: 4,
    }, o.dynamicLayers ? { dynamicLayers: o.dynamicLayers } : {}));
    if (o.minZoom) layer.zoomNote = { min: o.minZoom, text: 'state-wide view' };
    layer.on('load', () => { st.features++; });
    layer.on('requesterror', () => { st.errors++; });
    o.layer = layer;
    o.kind = 'state';
    return layer;
  }

  // Australia-wide images of DEA layers, stitched by the build from tiles at
  // the coarsest zoom DEA will draw (pipeline/render_dea_mosaic.py)
  let deaMosaic = null;
  async function loadDeaMosaic() {
    if (deaMosaic) return deaMosaic;
    try {
      const r = await fetch('data/dea/dea.json', { cache: 'no-cache' });
      deaMosaic = r.ok ? await r.json() : {};
    } catch (e) { deaMosaic = {}; }
    return deaMosaic;
  }

  function makeWmsOverlay(L, o) {
    const st = (status.overlays[o.name] = { features: 0, errors: 0 });
    // DEA's server only draws this from about zoom 7 (regional scale)
    const live = deaWms(L, { layers: o.layers, styles: o.styles }, { attribution: DEA_ATTR, opacity: 0.75, maxZoom: 19, maxNativeZoom: 16, minZoom: 7, zIndex: 5 });
    live.on('tileload', () => { st.features++; });
    live.on('tileerror', () => { st.errors++; });
    const img = deaMosaic && deaMosaic[o.mosaic];
    let layer = live;
    if (img) {
      // zoomed out: the stitched national image, scaled to fit
      const b = img.bounds;
      const pic = L.imageOverlay(`data/dea/${img.file}`, [[b[1], b[0]], [b[3], b[2]]], {
        opacity: 0.8, attribution: DEA_ATTR, zIndex: 5,
      });
      pic.on('load', () => { st.features++; st.image = true; });
      pic.on('error', () => { st.errors++; });
      layer = zoomSwitch(pic, live, 7, DEA_ATTR);
    } else {
      live.zoomNote = { min: 7, text: 'regional view' };
    }
    o.layer = layer;
    o.kind = 'wms';
    return layer;
  }

  // A layer that shows `low` below zoom `z` and `high` from zoom `z` up:
  // a pre-rendered image for the whole area, and live detail close in.
  function zoomSwitch(low, high, z, attribution) {
    const L = window.L;
    const Switch = L.Layer.extend({
      onAdd(map) { this._map = map; map.on('zoomend', this._update, this); this._update(); },
      onRemove(map) {
        map.off('zoomend', this._update, this);
        [low, high].forEach((l) => l && map.hasLayer(l) && map.removeLayer(l));
      },
      getAttribution() { return attribution; },
      _update() {
        const hi = this._map.getZoom() >= z || !low;
        const want = hi ? high : low, other = hi ? low : high;
        if (other && this._map.hasLayer(other)) this._map.removeLayer(other);
        if (want && !this._map.hasLayer(want)) want.addTo(this._map);
      },
    });
    return new Switch();
  }

  let councilImages = null;
  async function loadCouncilImages() {
    if (councilImages) return councilImages;
    try {
      const r = await fetch('data/council/council.json', { cache: 'no-cache' });
      councilImages = r.ok ? await r.json() : { layers: {} };
    } catch (e) { councilImages = { layers: {} }; }
    return councilImages;
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
      const img = councilImages && councilImages.layers && councilImages.layers[o.image];
      if (img) {
        const b = img.bounds;
        const pic = window.L.imageOverlay(`data/council/${img.file}`, [[b[1], b[0]], [b[3], b[2]]], {
          opacity: 0.6, className: 'flood-layer', attribution: BCC_ATTR, zIndex: 3,
        });
        pic.on('load', () => { st.features++; st.image = true; });
        pic.on('error', () => { st.errors++; });
        o.layer = zoomSwitch(pic, layer, o.minZoom, BCC_ATTR);
        o.layer.zoomNote = null;
        return o.layer;
      }
      layer.zoomNote = { min: o.minZoom, text: 'detailed layer' };
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
      const hidden = on.filter((o) => o.layer.zoomNote && z < o.layer.zoomNote.min);
      if (hidden.length) parts.push(`<span class="hint">Zoom in to see ${hidden.map((o) => o.name.split(' ')[0].toLowerCase()).join(' and ')} layers</span>`);
    }
    STATE_OVERLAYS.filter((o) => o.layer && state.lmap.hasLayer(o.layer)).forEach((o) => {
      const z = state.lmap.getZoom();
      parts.push(`<span><i style="background:${o.swatch};opacity:.6"></i>${escapeHtml(o.legend)}${o.layer.zoomNote && z < o.layer.zoomNote.min ? ' <em>(zoom in)</em>' : ''}</span>`);
    });
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
  status.worker = () => (worker ? 'worker' : worker === false ? 'page' : 'unused');

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

  async function enterGeoMode(b, opts) {
    const fit = !opts || opts.fit !== false;
    try {
      await loadLeaflet();
    } catch (err) {
      leaveGeoMode();
      say(`${err.message} Showing the terrain picture instead.`);
      return false;
    }
    const L = window.L;
    $('map').hidden = true;
    $('lmap').hidden = false;
    $('geoControls').hidden = false;
    $('layersStaticNote').hidden = true;
    const bounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
    if (!state.lmap) await loadDeaMosaic();
    if (!state.lmap) {
      // the wheel is handled by smoothWheelZoom below (continuous zoom)
      const m = L.map('lmap', { minZoom: 4, zoomSnap: 0, zoomDelta: 0.5, scrollWheelZoom: false, zoomControl: false, preferCanvas: false });
      enableSmoothWheelZoom(L, m);
      if (!finePointer()) { /* pinch to zoom on touch screens */ } else L.control.zoom({ position: 'bottomright' }).addTo(m);
      const layers = {};
      status.basemaps = {};
      for (const bm of BASEMAPS) {
        // DEA draws imagery from about zoom 6; at zoom 5 fetch zoom-6 tiles
        // and scale them down to fit (minNativeZoom)
        const own = bm.wms ? deaWms(L, bm.wms, Object.assign({}, bm.opts, { minZoom: 5, minNativeZoom: 6 })) : L.tileLayer(bm.url(), bm.opts);
        const st = (status.basemaps[bm.name] = { loaded: 0, errors: 0 });
        own.on('tileload', () => { st.loaded++; status.tilesLoaded++; });
        own.on('tileerror', () => { st.errors++; status.tileErrors++; });
        // below zoom 5 (whole-country view), Esri imagery underneath shows
        const layer = bm.wms
          ? L.featureGroup([L.tileLayer(BASEMAPS[0].url(), Object.assign({}, BASEMAPS[0].opts, { zIndex: 0 })), own])
          : own;
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
      for (const o of STATE_OVERLAYS) { const l = makeStateOverlay(o); if (l) overlays[o.name] = l; }
      const fhLayers = floodHubOverlays(L);
      Object.assign(overlays, fhLayers);
      const fh = state.floodhub;
      const alerting = fh && fh.configured && (((fh.flashFloodEvents || []).length > 0)
        || (fh.gauges || []).some((g) => g.status && sev(g.status.severity).rank >= 2));
      if (alerting) Object.values(fhLayers).forEach((l) => l.addTo(m));
      buildLayerLists(m, layers, overlays, first);
      m.on('overlayadd overlayremove zoomend', renderOverlayLegend);
      m.on('zoomend', syncLayerLists);
      m.on('layeradd layerremove', syncLayerLists);
      window.__floodTestZoom = (lat, lng, z) => m.setView([lat, lng], z, { animate: false });
      // simulate a tap on the map (not on a marker) at a place, for tests
      window.__floodTapAt = (lat, lng) => m.fire('click', { latlng: L.latLng(lat, lng) });
      window.__floodZoom = () => m.getZoom();
      window.__floodSetOverlay = (name, on) => {
        const l = layerRegistry.overlays[name];
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
      L.control.scale({ imperial: false }).addTo(m);
      m.on('click', onGeoClick);
      wireStudy();
      m.on('mousemove', onGeoMove);
      m.on('locationfound', onLocated);
      m.on('locationerror', (e) => { say(`Couldn’t get your location: ${e.message}`); });
      state.lmap = m;
    }
    // area-specific layers: Brisbane City Council's, once per session
    if (state.areaMeta && state.areaMeta.brisbaneGauge && !state.councilAdded) {
      await loadCouncilImages();
      for (const o of OVERLAYS) { const l = makeOverlay(o); if (l) registerOverlay(o.name, l); }
      state.councilAdded = true;
    }
    if (state.areaMeta && !state.areaMeta.national && nat.data) addNationalLayers(state.lmap);
    state.lmap.invalidateSize();
    if (fit) state.lmap.fitBounds(bounds);
    status.mode = 'map';
    return true;
  }


  // Fluid wheel / trackpad zoom. Leaflet's own wheel zoom jumps in animated
  // steps; this eases the zoom toward a target every frame, keeping the
  // point under the cursor still (the approach of Leaflet.SmoothWheelZoom).
  function enableSmoothWheelZoom(L, map) {
    const el = map.getContainer();
    let goal = null, raf = 0, endT = 0, mouse = null, anchor = null, moved = false;
    const PX_PER_LEVEL = 260;   // wheel pixels for one zoom level
    function frame() {
      const z = map.getZoom();
      let next = z + (goal - z) * 0.28;
      if (Math.abs(goal - next) < 0.002) next = goal;
      const delta = mouse.subtract(map.getSize().divideBy(2));
      const center = map.unproject(map.project(anchor, next).subtract(delta), next);
      if (!moved) { map._moveStart(true, false); moved = true; }
      map._move(center, next);
      if (next !== goal) raf = requestAnimationFrame(frame);
      else raf = 0;
    }
    function finish() {
      if (raf) { endT = setTimeout(finish, 60); return; }
      goal = null;
      if (moved) map._moveEnd(true);
      moved = false;
    }
    L.DomEvent.on(el, 'wheel', (e) => {
      L.DomEvent.preventDefault(e);
      L.DomEvent.stopPropagation(e);
      if (map._animatingZoom) return;
      const px = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY;
      const pinch = e.ctrlKey;           // trackpad pinch arrives as ctrl+wheel
      if (goal == null) {
        map.stop();
        goal = map.getZoom();
      }
      mouse = map.mouseEventToContainerPoint(e);
      anchor = map.containerPointToLatLng(mouse);
      goal = Math.max(map.getMinZoom(), Math.min(Math.min(map.getMaxZoom(), 20), goal - px / (pinch ? 100 : PX_PER_LEVEL)));
      if (!raf) raf = requestAnimationFrame(frame);
      clearTimeout(endT);
      endT = setTimeout(finish, 180);
    });
    status.smoothWheel = true;
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
    if (layers[name].bringToBack) layers[name].bringToBack();
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
      const zn = overlays[name].zoomNote;
      let hint = null;
      if (zn) {
        hint = document.createElement('button');
        hint.type = 'button'; hint.className = 'zoom-hint'; hint.hidden = true;
        hint.dataset.min = zn.min; hint.dataset.for = name;
        hint.textContent = `Zoom in to see this layer (${zn.text})`;
        hint.addEventListener('click', () => m.setZoom(zn.min));
      }
      input.checked = m.hasLayer(overlays[name]);
      input.addEventListener('change', () => {
        overlays[name].userOn = input.checked;
        if (input.checked) overlays[name].addTo(m); else m.removeLayer(overlays[name]);
        renderOverlayLegend();
        syncLayerLists();
      });
      ol.appendChild(lab);
      if (hint) ol.appendChild(hint);
    });
  }

  function registerOverlay(name, layer) {
    if (!layerRegistry || layerRegistry.overlays[name] === layer) return;
    layerRegistry.overlays[name] = layer;
    buildLayerLists(layerRegistry.m, layerRegistry.layers, layerRegistry.overlays, status.basemap);
  }

  function syncLayerLists() {
    if (!layerRegistry) return;
    const { m, overlays } = layerRegistry;
    const z = m.getZoom();
    document.querySelectorAll('#overlayList input').forEach((inp) => {
      const l = overlays[inp.dataset.layer];
      if (l) inp.checked = m.hasLayer(l);
    });
    document.querySelectorAll('#overlayList .zoom-hint').forEach((hint) => {
      const l = overlays[hint.dataset.for];
      hint.hidden = !(l && m.hasLayer(l) && z < +hint.dataset.min);
    });
    document.querySelectorAll('#basemapList input').forEach((inp, i) => {
      inp.checked = Object.keys(layerRegistry.layers)[i] === status.basemap;
    });
  }

  function leaveGeoMode() {
    state.geo = null;
    state.areaKey = null;
    if (areaReg.size) setActiveLayers(null);
    status.mode = 'static';
    $('map').hidden = false;
    $('lmap').hidden = true;
    $('geoControls').hidden = true;
    $('layersStaticNote').hidden = false;
  }


  /* ---------------------------------------------------- modelled areas */
  // Every place modelled on the street map stays there with its own terrain,
  // scenario, flood layer and gauge. One is active at a time: the Scenario
  // panel, profile and stats show that one; tapping inside another makes it
  // active.
  const areaReg = new Map();
  let localCount = 0;
  let geoToken = 0;   // bumped whenever the active area changes
  const CTL_KEYS = ['gaugeLevel', 'bayLevel', 'slr', 'extra', 'grad', 'streamArea'];

  function areaFields() {
    return {
      grid: state.grid, areaId: state.areaId, areaMeta: state.areaMeta, eventsApply: state.eventsApply,
      streamAreaKm2: state.streamAreaKm2, a: state.a, gauge: state.gauge, base: state.base, run: state.run,
      terrain: state.terrain, geo: state.geo, controls: state.controls || [],
      ctl: Object.fromEntries(CTL_KEYS.map((k) => [k, ctl[k].value])),
      gmin: ctl.gaugeLevel.min, gmax: ctl.gaugeLevel.max,
      levelHint: $('levelHint').hidden ? null : $('levelHint').textContent,
    };
  }

  // Saving happens as an area is left. An inactive area keeps only its
  // terrain, settings and the flood picture on the map; the flow analysis
  // and flood grids (most of the memory) are rebuilt when it is reopened,
  // so any number of areas can stay on the map.
  function saveActive() {
    const area = state.areaKey && areaReg.get(state.areaKey);
    if (area) Object.assign(area, areaFields(), { a: null, base: null, run: null, terrain: null });
  }

  function ensureArea(key) {
    const L = window.L, m = state.lmap;
    let area = areaReg.get(key);
    const b = state.areaMeta.bounds_lonlat;
    const bounds = L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
    if (!area) {
      const fromReport = state.areaMeta.reportId && reports.find((r) => r.id === state.areaMeta.reportId);
      const fromPin = state.areaMeta.pinN != null && pins.find((x) => x.n === state.areaMeta.pinN);
      area = { key, name: state.areaMeta.name || key, n: state.areaMeta.keepN != null ? state.areaMeta.keepN : fromReport ? fromReport.n : fromPin ? fromPin.n : nextNumber(), reportId: state.areaMeta.reportId || null };
      area.overlay = L.imageOverlay(BLANK, bounds, {
        opacity: parseFloat($('floodOpacity').value) / 100, className: 'flood-layer', zIndex: 6,
      }).addTo(m);
      area.outline = L.rectangle(bounds, { color: '#c66f1d', weight: 1.5, dashArray: '5 5', fill: false, interactive: false }).addTo(m);
      area.marker = L.marker(bounds.getCenter(), { icon: numIcon(area.n, AREA_COLOR, true), keyboard: false, zIndexOffset: 900 }).addTo(m);
      area.marker.bindTooltip(`${area.n}. ${area.name}: flood model gauge`, { direction: 'top', offset: [0, -12] });
      area.marker.on('click', () => selectPlace(area.n));
      areaReg.set(key, area);
      selectedNum = area.n;
      if (hiddenNums.has(area.n)) setPlaceHidden(area.n, false);
    } else {
      area.overlay.setBounds(bounds);
    }
    Object.assign(area, areaFields());
    return area;
  }

  const AREA_COLOR = '#c66f1d';
  function setActiveLayers(area) {
    state.overlay = area ? area.overlay : null;
    state.gaugeMarker = area ? area.marker : null;
    for (const a of areaReg.values()) {
      const on = a === area;
      a.outline.setStyle({ color: on ? AREA_COLOR : '#8a6a4a', weight: on ? 2.5 : 1.2, dashArray: on ? null : '5 5' });
      a.marker.setIcon(numIcon(a.n, on ? AREA_COLOR : '#8a6a4a', on));
    }
    reports.forEach(refreshReportLink);
    renderPlaces();
  }

  function areaByNumber(n) { return Array.from(areaReg.values()).find((a) => a.n === n) || null; }
  function areaForReport(r) { return Array.from(areaReg.values()).find((a) => a.reportId === r.id) || null; }

  // Show or hide everything with this number: the area's flood layer, outline
  // and gauge, and the report's pin. Hidden areas keep their scenario.
  function setPlaceHidden(n, hidden) {
    const m = state.lmap;
    if (!m) return;
    if (hidden) hiddenNums.add(n); else hiddenNums.delete(n);
    const area = areaByNumber(n);
    if (area) [area.overlay, area.outline, area.marker].forEach((l) => (hidden ? m.removeLayer(l) : l.addTo(m)));
    reports.filter((r) => r.n === n && r.pin).forEach((r) => (hidden ? m.removeLayer(r.pin) : r.pin.addTo(m)));
    pins.filter((p) => p.n === n && p.marker).forEach((p) => (hidden ? m.removeLayer(p.marker) : p.marker.addTo(m)));
    if (hidden && area && area.key === state.areaKey) say(`${n}. ${area.name} is hidden. Its scenario is kept; show it again from Places.`);
    reports.forEach(refreshReportLink);
    renderPlaces();
  }
  window.__floodSetPlaceHidden = setPlaceHidden;

  function refreshReportLink(r) {
    const box = r.el.querySelector('.js-link');
    if (!box) return;
    const area = areaForReport(r);
    const btn = r.el.querySelector('.js-model');
    if (btn) btn.textContent = area ? 'Open its flood scenario' : (r.kind === 'tide' ? 'Model coastal flooding here' : 'Model flooding here');
    if (!area) { box.innerHTML = ''; return; }
    const hidden = hiddenNums.has(r.n);
    box.innerHTML = `<div class="link-row"><span class="pin-num" style="background:${AREA_COLOR}">${r.n}</span>
      <span>Flood model ${hidden ? '(hidden)' : 'on the map'}</span></div>`;
  }

  function activateArea(key, opts) {
    const area = areaReg.get(key);
    if (!area) return false;
    geoToken++;          // abandon any area still opening
    if (state.areaKey !== key) saveActive();
    if (hiddenNums.has(area.n)) setPlaceHidden(area.n, false);
    Object.assign(state, {
      grid: area.grid, areaId: area.areaId, areaMeta: area.areaMeta, eventsApply: area.eventsApply,
      streamAreaKm2: area.streamAreaKm2, a: area.a, gauge: area.gauge, base: area.base, run: area.run,
      terrain: area.terrain, geo: area.geo, areaKey: key, pendingGeo: false, controls: area.controls || [],
    });
    status.area = area.areaId === 'local' ? key : area.areaId;
    CTL_KEYS.forEach((k) => { ctl[k].value = area.ctl[k]; });
    ctl.gaugeLevel.min = area.gmin; ctl.gaugeLevel.max = area.gmax;
    ctl.gaugeLevel.value = area.ctl.gaugeLevel;
    $('levelHint').hidden = !area.levelHint;
    if (area.levelHint) $('levelHint').textContent = area.levelHint;
    setActiveLayers(area);
    if (!state.lmap || $('lmap').hidden) {
      const b = area.areaMeta.bounds_lonlat;
      enterGeoMode(b, { fit: !!(opts && opts.fit) });
    } else if (opts && opts.fit) {
      const b = area.areaMeta.bounds_lonlat;
      state.lmap.fitBounds([[b[1], b[0]], [b[3], b[2]]]);
    }
    $('area').value = key;
    renderEvents();
    showScenarioEmpty(false);
    syncOutputs();
    renderInfo();
    renderNotice();
    if (!state.a && state.grid) {
      // reopened: rebuild the flow analysis (in the background) and rerun
      // its scenario; the flood picture stays on the map meanwhile
      const grid = state.grid;
      setBusy(true, 'Reopening this model…');
      state.ready = analyseAsync(grid, { streamAreaKm2: state.streamAreaKm2 }).then((a) => {
        if (state.areaKey !== key || state.grid !== grid) return;
        state.a = a;
        state.terrain = terrainRGBA(a);
        state.base = null;
        runScenario();
        state.edges = floodEdges(a, state.run);
        renderEdgeNote();
      }).finally(() => setBusy(false));
    } else {
      state.ready = Promise.resolve();
      if (state.run) { drawStats(scenario()); drawProfile(scenario()); }
    }
    state.edges = state.run && state.a ? floodEdges(state.a, state.run) : [];
    renderEdgeNote();
    renderAreaList();
    return true;
  }

  function deactivate() {
    geoToken++;
    state.pendingGeo = false;
    saveActive();
    state.areaKey = null;
    setActiveLayers(null);
    renderAreaList();
  }

  function removeArea(key, opts) {
    const area = areaReg.get(key);
    if (!area) return;
    const m = state.lmap;
    [area.overlay, area.outline, area.marker].forEach((l) => l && m && m.removeLayer(l));
    if (area.overlay && area.overlay._floodUrl) URL.revokeObjectURL(area.overlay._floodUrl);
    areaReg.delete(key);
    if (!reports.some((r) => r.n === area.n)) hiddenNums.delete(area.n);
    reports.forEach(refreshReportLink);
    const op = $('area').querySelector(`option[value="${CSS.escape(key)}"]`);
    if (op && area.areaMeta && area.areaMeta.local) op.remove();
    if ($('modelledGroup') && !$('modelledGroup').children.length) $('modelledGroup').hidden = true;
    if (state.areaKey === key) {
      state.areaKey = null;
      if (!(opts && opts.quiet)) { $('area').value = 'australia'; enterNational({ fit: false }); }
    }
    renderAreaList();
  }

  function areaAt(latlng) {
    const inside = (a) => !hiddenNums.has(a.n) && a.geo && latlng.lat <= a.geo.north && latlng.lat >= a.geo.south
      && latlng.lng >= a.geo.west && latlng.lng <= a.geo.east;
    const active = state.areaKey && areaReg.get(state.areaKey);
    if (active && inside(active)) return active;
    return Array.from(areaReg.values()).reverse().find(inside) || null;
  }

  function renderAreaList() { renderPlaces(); }

  // One row per number: its report, its flood model, a pinned spot, or a mix.
  // Choosing a row does exactly what tapping that number on the map does
  // (selectPlace); the icons open its report and zoom to it.
  let selectedNum = null;
  let scenarioEmpty = false;   // the Scenario panel has no flood model to show
  function placeLatLon(n) {
    const a = areaByNumber(n), r = reports.find((x) => x.n === n), pin = pins.find((x) => x.n === n);
    if (r) return [r.lat, r.lon];
    if (pin) return [pin.lat, pin.lon];
    if (a) { const b = a.areaMeta.bounds_lonlat; return [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2]; }
    return null;
  }

  // The one way a numbered place is chosen, from its map pin or its row:
  // its flood scenario becomes active and its report shows (on a phone,
  // the scenario wins); a bare pin just becomes the selected row.
  function selectPlace(n, opts) {
    const a = areaByNumber(n), r = reports.find((x) => x.n === n);
    const fromList = !!(opts && opts.fromList);
    selectedNum = n;
    if (hiddenNums.has(n)) setPlaceHidden(n, false);
    if (r && !(a && isPhone())) showReport(r);
    if (a) { activateArea(a.key, { fit: fromList }); openPanel('panel-scenario'); }
    else {
      // not modelled yet: the Scenario panel offers to model it
      if (state.areaKey) deactivate();
      showScenarioEmpty(true);
      if (!isPhone()) setScenarioCollapsed(false);
      else if (!r) openPanel('panel-scenario');
    }
    if (fromList && !a && state.lmap) {
      const ll = placeLatLon(n);
      if (ll && !state.lmap.getBounds().pad(-0.1).contains(ll)) state.lmap.panTo(ll);
    }
    setPlacesCollapsed(false);
    renderPlaces();
  }
  window.__floodSelectPlace = (n) => selectPlace(n, { fromList: true });

  const ICON_REPORT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/></svg>';
  const ICON_ZOOM = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5M11 8v6M8 11h6"/></svg>';

  function renderPlaces() {
    const box = $('areaList');
    if (!box) return;
    const nums = Array.from(new Set([...reports.map((r) => r.n), ...Array.from(areaReg.values()).map((a) => a.n), ...pins.map((p) => p.n)])).sort((a, b) => a - b);
    status.areas = Array.from(areaReg.keys());
    $('placesCount').hidden = !nums.length;
    $('placesCount').textContent = String(nums.length);
    $('placesHeadCount').hidden = !nums.length;
    $('placesHeadCount').textContent = String(nums.length);
    const act = state.areaKey && areaReg.get(state.areaKey);
    $('placesNow').textContent = act ? `Scenario: ${act.n}. ${act.name}` : (activeReport ? `Report: ${activeReport.n}. ${activeReport.name || ''}` : '');
    renderScenarioTitle();
    if (!nums.length) {
      box.innerHTML = `<div class="places-empty"><p><strong>No places yet.</strong></p>
        <p class="hint">Tap a flood gauge, tide gauge or dam on the map for a report, or tap anywhere to add a place or model flooding there. Each place gets a number that matches its pin on the map.</p></div>${studiesHtml()}`;
      wireStudyRows(box);
      return;
    }
    if (!nums.includes(selectedNum)) selectedNum = act ? act.n : null;
    status.selectedPlace = selectedNum;
    const rows = nums.map((n) => {
      const r = reports.find((x) => x.n === n), a = areaByNumber(n), pin = pins.find((x) => x.n === n);
      const hidden = hiddenNums.has(n), isActive = a && a.key === state.areaKey, sel = selectedNum === n;
      const name = (r && r.name) || (pin && pin.name) || (a && a.name) || `Place ${n}`;
      const tags = [r ? (r.kind === 'storage' ? 'dam report' : r.kind === 'tide' ? 'tide report' : 'gauge report') : null, pin ? 'pinned place' : null, a ? 'flood model' : null].filter(Boolean).join(' + ');
      const color = a ? (isActive ? AREA_COLOR : '#8a6a4a') : r ? (GAUGE_STYLE[r.kind] || GAUGE_STYLE.river).color : PIN_COLOR;
      const repLabel = r ? `Open the report for ${name}` : `Report on the gauge or dam nearest ${name}`;
      return `<li class="place${sel ? ' on' : ''}${hidden ? ' off' : ''}">
        <button type="button" class="place-main" data-num="${n}" aria-pressed="${sel}" title="Select ${escapeHtml(name)}">
          <span class="pin-num" style="background:${color}">${n}</span>
          <span class="place-text"><span class="place-name">${escapeHtml(name)}</span><span class="place-tags">${tags}</span></span>
        </button>
        <button type="button" class="icon-btn" data-act="${r ? 'report' : 'nearest'}" data-n="${n}" aria-label="${escapeHtml(repLabel)}" title="${r ? 'Report' : 'Report on nearest gauge'}">${ICON_REPORT}</button>
        <button type="button" class="icon-btn" data-act="zoom" data-n="${n}" aria-label="Zoom to ${escapeHtml(name)}" title="Zoom to">${ICON_ZOOM}</button>
        <button type="button" class="icon-btn" data-drop="${n}" aria-label="Remove ${escapeHtml(name)}" title="Remove">×</button>
      </li>`;
    }).join('');
    box.innerHTML = `<ul class="places">${rows}</ul>
      <p class="hint">Choosing a place here works like tapping its number on the map.</p>${studiesHtml()}`;
    wireStudyRows(box);
    box.querySelectorAll('[data-num]').forEach((b) => b.addEventListener('click', () => selectPlace(+b.dataset.num, { fromList: true })));
    box.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => placeAction(b.dataset.act, +b.dataset.n)));
    box.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', () => {
      const n = +b.dataset.drop, a = areaByNumber(n);
      reports.filter((r) => r.n === n).forEach(closeReport);
      if (a) removeArea(a.key);
      for (let i = pins.length - 1; i >= 0; i--) if (pins[i].n === n) {
        if (pins[i].marker && state.lmap) state.lmap.removeLayer(pins[i].marker);
        pins.splice(i, 1);
      }
      hiddenNums.delete(n);
      if (selectedNum === n) selectedNum = null;
      renderPlaces();
    }));
  }

  function setPlacesCollapsed(collapsed) {
    $('placesCard').classList.toggle('collapsed', collapsed);
    $('placesToggle').setAttribute('aria-expanded', String(!collapsed));
    document.querySelectorAll('[data-places-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(!collapsed)));
    status.placesOpen = !collapsed;
  }
  $('placesToggle').addEventListener('click', () => setPlacesCollapsed(!$('placesCard').classList.contains('collapsed')));
  document.querySelectorAll('[data-places-toggle]').forEach((b) => b.addEventListener('click', () => {
    const collapsed = !$('placesCard').classList.contains('collapsed');
    setPlacesCollapsed(collapsed);
    if (!collapsed && isPhone()) document.querySelectorAll('[data-panel]').forEach((p) => { if (p.dataset.side === 'left') p.hidden = true; });
    syncPanels();
  }));
  document.querySelectorAll('[data-places-open]').forEach((b) => b.addEventListener('click', () => {
    setPlacesCollapsed(false);
    if (isPhone()) document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = true; });
    syncPanels();
  }));
  window.__floodSetPlacesCollapsed = setPlacesCollapsed;

  function placeAction(act, n) {
    const a = areaByNumber(n), r = reports.find((x) => x.n === n), pin = pins.find((x) => x.n === n);
    if (pin && !r && (act === 'model' || act === 'modelcoast')) {
      selectedNum = n;
      modelHere(pin.lat, pin.lon, { kind: act === 'modelcoast' ? 'coast' : 'river', name: pin.name, pinN: n });
      return;
    }
    if (act === 'nearest') {
      const ll = placeLatLon(n);
      const near = ll && nearestNamed(ll[0], ll[1], 100);
      if (near) { openReport(near.f); if (state.lmap) state.lmap.setView([near.f.geometry.coordinates[1], near.f.geometry.coordinates[0]], Math.max(state.lmap.getZoom(), 11)); }
      else say('No Bureau of Meteorology gauge or dam within 100 km of this place.');
      return;
    }
    if (act === 'report' && r) {
      selectedNum = n;
      showReport(r);
      renderPlaces();
    } else if ((act === 'scenario' || act === 'select') && (a || r || pin)) {
      selectPlace(n, { fromList: true });
    } else if ((act === 'model' || act === 'modelcoast') && r && !a) {
      selectedNum = n;
      const kind = act === 'modelcoast' || (act === 'model' && r.kind === 'tide') ? 'coast' : 'river';
      modelHere(r.lat, r.lon, { kind, name: r.name, reportId: r.id });
    } else if (act === 'zoom' && state.lmap) {
      if (a) { const b = a.areaMeta.bounds_lonlat; state.lmap.fitBounds([[b[1], b[0]], [b[3], b[2]]]); }
      else if (r) state.lmap.setView([r.lat, r.lon], Math.max(state.lmap.getZoom(), 12));
      else if (pin) state.lmap.setView([pin.lat, pin.lon], Math.max(state.lmap.getZoom(), 12));
    }
  }
  window.__floodPlaceAction = placeAction;

  // The Scenario panel follows the selected place: its flood scenario when it
  // has one, otherwise the options to model it.
  function unmodelledSelection() {
    if (selectedNum == null || state.areaKey || areaByNumber(selectedNum)) return null;
    const r = reports.find((x) => x.n === selectedNum), pin = pins.find((x) => x.n === selectedNum);
    return r || pin ? { n: selectedNum, r, pin, name: (r && r.name) || pin.name } : null;
  }

  function renderScenarioTitle() {
    const el = $('scenarioPlace');
    if (!el) return;
    const a = state.areaKey && areaReg.get(state.areaKey), u = unmodelledSelection();
    el.textContent = a ? `${a.n}. ${a.name}` : u ? `${u.n}. ${u.name}: not modelled yet` : '';
    const many = areaReg.size > (a ? 1 : 0);
    $('scenarioPrev').hidden = $('scenarioNext').hidden = !many;
    renderScenarioModel(u);
  }

  function renderScenarioModel(u) {
    const box = $('scenarioModel');
    if (!box) return;
    const show = scenarioEmpty && !!u;
    box.hidden = !show;
    $('scenarioEmpty').hidden = !scenarioEmpty || show;
    status.modelOptions = show ? u.n : null;
    if (!show) { box.innerHTML = ''; return; }
    const coastFirst = u.r && u.r.kind === 'tide';
    const color = u.r ? (GAUGE_STYLE[u.r.kind] || GAUGE_STYLE.river).color : PIN_COLOR;
    const river = `<button type="button" class="btn${coastFirst ? '' : ' primary'}" data-model="model">Model river flooding</button>`;
    const coast = `<button type="button" class="btn${coastFirst ? ' primary' : ''}" data-model="modelcoast">Model coastal flooding</button>`;
    box.innerHTML = `<div class="place-row"><span class="pin-num" style="background:${color}">${u.n}</span><span>${escapeHtml(u.name)}</span></div>
      <p class="hint">Model flooding around this ${u.r ? (u.r.kind === 'storage' ? 'dam' : 'gauge') : 'place'} from Geoscience Australia's elevation data (about 30 m). It keeps number ${u.n}.</p>
      <div class="btns">${coastFirst ? coast + river : river + coast}</div>`;
    box.querySelectorAll('[data-model]').forEach((b) => b.addEventListener('click', () => placeAction(b.dataset.model, u.n)));
  }

  const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 4.4-1"/></svg>';
  window.__floodPlaces = () => Array.from(new Set([...reports.map((r) => r.n), ...Array.from(areaReg.values()).map((a) => a.n), ...pins.map((p) => p.n)])).sort((a, b) => a - b).map((n) => {
    const a = areaByNumber(n), r = reports.find((x) => x.n === n), pin = pins.find((x) => x.n === n);
    return { n, report: !!r, area: !!a, pin: !!pin, hidden: hiddenNums.has(n), onMap: !!(a && state.lmap && state.lmap.hasLayer(a.overlay)), reportName: r && r.name, areaName: a && a.name, pinName: pin && pin.name };
  });

  window.__floodActivateArea = (key) => activateArea(key, { fit: true });
  window.__floodAreaInfo = () => Array.from(areaReg.values()).map((a) => ({
    key: a.key, name: a.name, drawn: !!a.overlay._floodUrl, active: a.key === state.areaKey,
  }));

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

  let overlayGen = 0;
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
    const ov = state.overlay;
    off.toBlob((blob) => {
      if (!blob || gen !== overlayGen) return;
      const url = URL.createObjectURL(blob);
      const old = ov._floodUrl;
      ov._floodUrl = url;
      ov.setUrl(url);
      status.overlayUpdates++;
      if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    }, 'image/png');
    if (state.gauge >= 0) {
      state.gaugeMarker.setLatLng(cellLatLng(state.gauge));
      state.gaugeMarker.setTooltipContent(state.eventsApply ? 'Brisbane City gauge' : `Gauge: ${(state.areaMeta && state.areaMeta.name) || 'modelled area'}`);
    }
  }

  function onGeoClick(e) {
    if (Date.now() < suppressClickUntil) return;   // the end of a box drag
    if (state.pendingGeo) { say('Still loading this area…'); return; }
    const hit = areaAt(e.latlng);
    if (!hit) { onNationalClick(e); return; }
    if (hit.key !== state.areaKey) {
      activateArea(hit.key);
      say(`Switched to ${hit.name}.`);
    }
    if (!state.a) return;   // still reopening
    if (state.addingPoint) { addLevelPointAt(e.latlng); return; }
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
    if (state.pendingGeo || !state.a || !state.geo || !state.areaKey) return;
    const c = latLngCell(e.latlng);
    if (c) say(describe(c.i));
  }

  function onLocated(e) {
    const L = window.L;
    if (state.youMarker) state.youMarker.remove();
    state.youMarker = L.circleMarker(e.latlng, {
      radius: 7, color: '#ffffff', weight: 2, fillColor: '#1a73e8', fillOpacity: 1,
    }).addTo(state.lmap);
    const hit = state.pendingGeo ? null : areaAt(e.latlng);
    if (hit && hit.key !== state.areaKey) activateArea(hit.key);
    const c = hit && state.a ? latLngCell(e.latlng) : null;
    say(c
      ? `Your location: ${describe(c.i)}`
      : 'Your location is outside the modelled areas. Tap the map near you to model flooding there.');
  }

  $('floodOpacity').addEventListener('input', (e) => {
    for (const a of areaReg.values()) a.overlay.setOpacity(parseFloat(e.target.value) / 100);
    $('floodOpacityOut').textContent = e.target.value + '%';
  });
  $('showRelief').addEventListener('change', () => { if (state.geo) drawGeoMap(); });
  $('locate').addEventListener('click', () => {
    if (!state.lmap || $('lmap').hidden) { say('Your location can be shown on the street map. Pick Australia or a modelled area from the menu.'); return; }
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
    $('forecastBadge').hidden = !(flooding.length || flash || nat.warningCount);
    let html = '';
    if (!flooding.length && !flash) {
      html += `<p>No flooding forecast at ${gauges.length} Flood Hub gauge${gauges.length === 1 ? '' : 's'} in Australia.</p>`;
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
    if (m.national) {
      const nm = nat.data && nat.data.meta;
      html = '<strong>Australia-wide.</strong> Tap a flood gauge, tide gauge or dam for a report, or tap anywhere to model flooding there from the national elevation model. Gauges, dams and readings: Bureau of Meteorology'
        + (nm && nm.fetched ? `, updated ${escapeHtml(ago(nm.fetched))}` : '') + '. Not official warnings.';
    } else if (m.local) {
      html = `<strong>Screening only.</strong> ${escapeHtml(m.source || '')} It includes buildings and trees in some places and misses levees and drains. Do not use for evacuation or property decisions.`;
    } else if (m.synthetic) {
      html = '<strong>Illustrative terrain.</strong> This sample is generated, not real Brisbane elevation. It shows how the model behaves. Pick a processed area or load a DEM for real ground levels.';
    } else if (m.upload) {
      html = `<strong>Your terrain.</strong> ${m.routedBy === 'pointers' ? 'Flow directions come from your d8.tif.' : 'Flow directions were computed in your browser.'} Set the gauge level for your river; the historic Brisbane peaks don’t apply here.`;
    } else {
      html = `<strong>Screening only.</strong> ${escapeHtml(m.source || '')} A surface model includes buildings and trees, so expect errors in built-up areas. Do not use for evacuation or property decisions.`;
    }
    $('notice').innerHTML = html;
    $('noticePill').textContent = m.national ? 'About this map' : m.synthetic ? 'Illustrative terrain' : m.upload ? 'Your terrain' : 'Screening only';
  }

  function renderInfo() {
    const m = state.areaMeta || {}, a = state.a;
    const lines = [];
    if (!a) {
      const nm = (nat.data && nat.data.meta) || {};
      lines.push(`<span class="label">Data</span><br>${(nm.gauges || 0).toLocaleString('en-AU')} gauges and ${(nm.storages || 0).toLocaleString('en-AU')} dams from the Bureau of Meteorology${nm.fetched ? `, fetched ${escapeHtml(ago(nm.fetched))}` : ''}. On-demand terrain: Geoscience Australia DEM-H (about 30 m).`);
      $('dataInfo').innerHTML = lines.join(' ');
      $('downloads').innerHTML = '';
      return;
    }
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



  /* ------------------------------------------------------- Australia-wide */
  // The national view: BoM gauges, tide gauges and dams (fetched by the
  // build, see pipeline/fetch_national.py), a report for whatever is tapped,
  // and on-demand flood modelling from Geoscience Australia's 1-second
  // hydrologically enforced elevation model (DEM-H), read straight from GA.

  const AUS_BOUNDS = [112.5, -44, 154, -10];
  const DEMH_WCS = 'https://services.ga.gov.au/gis/services/DEM_SRTM_1Second_Hydro_Enforced_2024/MapServer/WCSServer';
  const BOM_ATTR = 'Gauges and storages &copy; Commonwealth of Australia (Bureau of Meteorology), CC BY 4.0';
  const GAUGE_STYLE = {
    forecast: { label: 'Flood forecast gauge', color: '#1565c0', radius: 5.5 },
    information: { label: 'Flood information gauge', color: '#5c6bc0', radius: 4.5 },
    river: { label: 'River gauge', color: '#78909c', radius: 3.5 },
    tide: { label: 'Tide gauge', color: '#00897b', radius: 5.5 },
    storage: { label: 'Dam or water storage', color: '#6d4c41', radius: 6 },
  };
  status.national = { loaded: false };
  status.local = {};
  const nat = { data: null, readings: null, layers: {}, picked: null };

  async function loadNationalData() {
    if (nat.data) return nat.data;
    const get = async (f) => {
      const r = await fetch(`data/national/${f}`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${f}: ${r.status}`);
      return r.json();
    };
    try {
      const [gauges, storages, readings, meta] = await Promise.all([
        get('gauges.geojson'), get('storages.geojson'), get('readings.json'), get('meta.json')]);
      nat.data = { gauges: gauges.features || [], storages: storages.features || [], meta };
      nat.readings = readings;
      const opt = async (f) => { try { const r = await fetch(`data/national/${f}`, { cache: 'no-cache' }); return r.ok ? r.json() : null; } catch (e) { return null; } };
      [nat.floodclass, nat.warnings] = await Promise.all([opt('floodclass.json'), opt('warnings.json')]);
      nat.floodclass = nat.floodclass || {};
      renderWarnings();
    } catch (e) {
      nat.data = { gauges: [], storages: [], meta: { errors: [String(e)] } };
      nat.readings = { level: {}, storage: {} };
    }
    status.national = {
      loaded: true, gauges: nat.data.gauges.length, storages: nat.data.storages.length,
      levelReadings: Object.keys(nat.readings.level || {}).length,
      storageReadings: Object.keys(nat.readings.storage || {}).length,
    };
    return nat.data;
  }

  function storageFill(p) {
    const r = nat.readings && nat.readings.storage && nat.readings.storage[p.station];
    if (!r || !p.capacity_ml) return null;
    return r.latest[1] / p.capacity_ml;
  }

  function storageColor(p) {
    const f = storageFill(p);
    if (f == null) return GAUGE_STYLE.storage.color;
    if (f >= 1) return '#6a1b9a';     // spilling or above full supply
    if (f >= 0.8) return '#1565c0';
    if (f >= 0.5) return '#43a047';
    if (f >= 0.25) return '#f9a825';
    return '#c62828';
  }

  function buildNationalLayers(L, m) {
    if (Object.keys(nat.layers).length) return nat.layers;
    const renderer = L.canvas({ padding: 0.3 });
    const groups = {
      'Flood forecast gauges (BoM)': ['forecast'],
      'Tide gauges (BoM)': ['tide'],
      'Flood information gauges (BoM)': ['information'],
      'Other river gauges (BoM)': ['river'],
    };
    for (const [name, kinds] of Object.entries(groups)) {
      const feats = nat.data.gauges.filter((f) => kinds.includes(f.properties.kind));
      if (!feats.length) continue;
      const st = GAUGE_STYLE[kinds[0]];
      nat.layers[name] = L.geoJSON({ type: 'FeatureCollection', features: feats }, {
        attribution: BOM_ATTR,
        pointToLayer: (f, ll) => L.circleMarker(ll, {
          renderer, radius: st.radius, color: '#ffffff', weight: 1.5, fillColor: st.color, fillOpacity: 0.95,
        }),
        onEachFeature: (f, layer) => {
          layer.bindTooltip(f.properties.name || 'Gauge', { direction: 'top', offset: [0, -4] });
          layer.on('click', (e) => { L.DomEvent.stop(e); onDotClick(f, e.latlng); });
        },
      });

    }
    const warned = nat.data.gauges.filter((f) => f.properties.kind !== 'river' && warningsFor(f.properties).length);
    status.warnedGauges = warned.length;
    if (warned.length) {
      nat.layers['Gauges under a current flood warning (BoM)'] = L.layerGroup(warned.map((f) => {
        const [lo, la] = f.geometry.coordinates;
        return L.circleMarker([la, lo], { renderer, radius: 10, color: '#c62828', weight: 2.5, fill: false, interactive: false });
      }));
    }
    if (nat.data.storages.length) {
      nat.layers['Dams and water storages (BoM)'] = L.geoJSON({ type: 'FeatureCollection', features: nat.data.storages }, {
        attribution: BOM_ATTR,
        pointToLayer: (f, ll) => L.circleMarker(ll, {
          renderer, radius: GAUGE_STYLE.storage.radius, color: '#ffffff', weight: 2,
          fillColor: storageColor(f.properties), fillOpacity: 0.95,
        }),
        onEachFeature: (f, layer) => {
          layer.bindTooltip(f.properties.name || 'Storage', { direction: 'top', offset: [0, -4] });
          layer.on('click', (e) => { L.DomEvent.stop(e); onDotClick(f, e.latlng); });
        },
      });
    }
    return nat.layers;
  }

  function addNationalLayers(m) {
    const L = window.L;
    buildNationalLayers(L, m);
    const defaultsOn = ['Flood forecast gauges (BoM)', 'Tide gauges (BoM)', 'Dams and water storages (BoM)', 'Gauges under a current flood warning (BoM)'];
    for (const [name, layer] of Object.entries(nat.layers)) {
      registerOverlay(name, layer);
      if (nat.defaultsApplied) continue;   // respect what the viewer has switched since
      if (defaultsOn.includes(name)) { layer.userOn = true; layer.addTo(m); } else layer.userOn = false;
    }
    nat.defaultsApplied = true;
    syncLayerLists();
  }

  async function enterNational(opts) {
    deactivate();
    state.areaId = 'australia';
    status.area = 'australia';
    state.areaMeta = { id: 'australia', name: 'Australia', national: true };
    state.grid = null; state.a = null; state.run = null; state.base = null; state.gauge = -1; state.geo = null;
    showScenarioEmpty(true);
    const ok = await enterGeoMode(AUS_BOUNDS, { fit: !opts || opts.fit !== false });
    if (!ok) {
      useSampleOption();
      await loadArea('sample');
      say('The street map could not load, so the Australia-wide view is unavailable. Showing the sample terrain.');
      return;
    }
    await loadNationalData();
    addNationalLayers(state.lmap);
    loadStudies();
    renderNotice();
    renderInfo();
    $('summaryLine').innerHTML = '<b>Australia</b> · tap a gauge, dam or tide gauge, or tap anywhere to model flooding';
  }

  function showScenarioEmpty(empty) {
    scenarioEmpty = empty;
    Array.from($('scenarioEmpty').parentElement.children).forEach((el) => {
      if (el.id !== 'scenarioEmpty' && el.id !== 'scenarioModel' && el.id !== 'edgeNote' && el.id !== 'levelPointsSet') el.hidden = empty || (el.id === 'eventsSet' && !state.eventsApply);
    });
    if (empty) { $('stats').innerHTML = ''; state.edges = []; }
    renderEdgeNote();
    renderLevelPoints();
    renderScenarioTitle();
  }

  /* ---------- reports */

  function fmtDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso || '';
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function sparkline(series) {
    const vals = series.map((s) => s[1]).filter(Number.isFinite);
    if (vals.length < 2) return '';
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
    const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${40 - ((v - lo) / span) * 34 - 3}`).join(' ');
    const last = pts.split(' ').pop().split(',');
    return `<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="1.8" fill="var(--accent)"/></svg>`;
  }

  function nearestFloodHubGauge(lat, lon, km) {
    const fh = state.floodhub;
    if (!fh || !fh.configured || !fh.gauges) return null;
    let best = null, bd = km;
    for (const g of fh.gauges) {
      if (!g.location) continue;
      const d = distKm(lat, lon, g.location.latitude, g.location.longitude);
      if (d < bd) { bd = d; best = g; }
    }
    return best;
  }

  function distKm(a, b, c, d) {
    const r = Math.PI / 180;
    const x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
    return Math.hypot(x, y) * 6371;
  }

  // Reports are kept for every numbered place, but the panel shows one at a
  // time (like the flood Scenario): pick another from Places, its map pin, or
  // the ‹ › buttons. The Report button shows or hides the panel.
  const reports = [];
  let activeReport = null;

  function showReport(r, opts) {
    if (!r) return;
    activeReport = r;
    layoutReports();
    if (!opts || opts.open !== false) openPanel('panel-report');
    r.el.classList.add('flash');
    setTimeout(() => r.el.classList.remove('flash'), 700);
  }

  // ‹ › in the Report and Scenario panels step to the next place that has a
  // report / a flood model and select it, so every panel follows along.
  function stepPlace(nums, current, dir) {
    if (!nums.length) return;
    nums.sort((a, b) => a - b);
    let next;
    if (current != null && nums.includes(current)) next = nums[(nums.indexOf(current) + dir + nums.length) % nums.length];
    else if (dir > 0) next = nums.find((n) => current == null || n > current) ?? nums[0];
    else next = nums.slice().reverse().find((n) => current == null || n < current) ?? nums[nums.length - 1];
    selectPlace(next, { fromList: true });
  }
  function stepReport(dir) {
    const cur = reports.some((r) => r.n === selectedNum) ? selectedNum : activeReport ? activeReport.n : selectedNum;
    stepPlace(reports.map((r) => r.n), cur, dir);
  }
  function stepScenario(dir) {
    const cur = state.areaKey && areaReg.get(state.areaKey);
    stepPlace(Array.from(areaReg.values()).map((a) => a.n), cur ? cur.n : selectedNum, dir);
  }
  window.__floodStepScenario = stepScenario;
  window.__floodStepReport = stepReport;
  $('reportPrev').addEventListener('click', () => stepReport(-1));
  $('reportNext').addEventListener('click', () => stepReport(1));
  $('scenarioPrev').addEventListener('click', () => stepScenario(-1));
  $('scenarioNext').addEventListener('click', () => stepScenario(1));

  // Reports and modelled areas share one set of numbers: an area modelled
  // from report 2 is also 2. A number is free once neither uses it.
  // Places can also be plain pins dropped on the map ("Add as a place").
  const pins = [];
  const PIN_COLOR = '#455a64';

  function nearestNamed(lat, lon, km) {
    let best = null, bd = km;
    const all = nat.data ? [...nat.data.gauges, ...nat.data.storages] : [];
    for (const f of all) {
      const [x, y] = f.geometry.coordinates;
      const d = distKm(lat, lon, y, x);
      if (d < bd) { bd = d; best = f; }
    }
    return best ? { f: best, km: bd } : null;
  }

  function addPin(lat, lon) {
    const near = nearestNamed(lat, lon, 25);
    const name = near ? `Near ${near.f.properties.name}` : `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    const pin = { n: nextNumber(), name, lat, lon, marker: null };
    if (state.lmap) {
      pin.marker = window.L.marker([lat, lon], { icon: numIcon(pin.n, PIN_COLOR), keyboard: false, zIndexOffset: 800 }).addTo(state.lmap);
      pin.marker.bindTooltip(`${pin.n}. ${name}`, { direction: 'top', offset: [0, -12] });
      pin.marker.on('click', () => selectPlace(pin.n));
    }
    pins.push(pin);
    say(`Added place ${pin.n}: ${name}.`);
    selectPlace(pin.n);   // the new place is selected everywhere, like any other
    return pin;
  }
  window.__floodAddPin = (lat, lon) => addPin(lat, lon).n;

  function nextNumber() {
    const used = new Set([...reports.map((r) => r.n), ...Array.from(areaReg.values()).map((a) => a.n), ...pins.map((p) => p.n)]);
    for (let n = 1; ; n++) if (!used.has(n)) return n;
  }
  const hiddenNums = new Set();

  function numIcon(n, color, active) {
    return window.L.divIcon({
      className: `report-pin${active ? ' active' : ''}`,
      html: `<span style="background:${color}">${n}</span>`, iconSize: [24, 24], iconAnchor: [12, 12],
    });
  }

  function closeReport(r) {
    const i = reports.indexOf(r);
    if (i < 0) return;
    reports.splice(i, 1);
    r.el.remove();
    if (activeReport === r) {
      const list = reports.slice().sort((a, b) => a.n - b.n);
      activeReport = list.find((x) => x.n > r.n) || list[list.length - 1] || null;
    }
    if (r.pin && state.lmap) state.lmap.removeLayer(r.pin);
    if (!areaByNumber(r.n)) hiddenNums.delete(r.n);
    layoutReports();
    renderPlaces();
  }

  function layoutReports() {
    const n = reports.length;
    if (!reports.includes(activeReport)) activeReport = reports[0] || null;
    const r = activeReport;
    reports.forEach((x) => { x.el.hidden = x !== r; });
    $('reportEmpty').hidden = !!r;
    $('h-report').textContent = r ? r.title : 'Report';
    $('reportPlace').textContent = r ? `${r.n}. ${r.name || ''}` : '';
    $('reportPrev').hidden = $('reportNext').hidden = n < 2;
    reports.forEach((x) => {
      if (!x.pin) return;
      x.pin.setIcon(numIcon(x.n, (GAUGE_STYLE[x.kind] || GAUGE_STYLE.river).color, x === r));
    });
    reports.forEach(refreshReportLink);
    renderPlaces();
    status.report = { count: n, names: reports.map((x) => x.name), active: r ? r.name : null };
  }

  function openReport(f) {
    nat.picked = f;
    const p = f.properties;
    const [lon, lat] = f.geometry.coordinates;
    const id = `${p.kind}:${p.id}`;
    const existing = reports.find((r) => r.id === id);
    if (existing) { selectPlace(existing.n); return; }
    const st = GAUGE_STYLE[p.kind] || GAUGE_STYLE.river;
    const num = nextNumber();
    let html = `<div class="card-head"><span class="pin-num" style="background:${st.color}">${num}</span><div style="min-width:0"><span class="kind">${escapeHtml(st.label)}</span><h3>${escapeHtml(p.name || 'Unnamed')}</h3></div><button type="button" class="close js-close" aria-label="Remove this report" title="Remove this report">×</button></div>`;
    const facts = [];
    if (p.kind === 'storage') {
      if (p.river) facts.push(['River', p.river]);
      if (p.capacity_ml) facts.push(['Capacity', `${Math.round(p.capacity_ml).toLocaleString('en-AU')} ML`]);
      if (p.year) facts.push(['Completed', p.year]);
      if (p.owner) facts.push(['Data owner', p.owner]);
    } else {
      if (p.basin) facts.push(['Basin', p.basin]);
      if (p.station) facts.push(['Station', p.station]);
      if (p.agency) facts.push(['Operated by', p.agency]);
    }
    if (p.state) facts.push(['State', p.state]);
    facts.push(['Location', `${lat.toFixed(4)}, ${lon.toFixed(4)}`]);
    html += `<dl class="facts">${facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join('')}</dl>`;

    // latest reading
    if (p.kind === 'storage') {
      const r = nat.readings.storage && nat.readings.storage[p.station];
      if (r) {
        const fill = storageFill(p);
        html += `<div class="reading"><span class="label">Storage volume</span>
          <div class="big">${fill != null ? Math.round(fill * 100) + '<small>% full</small>' : Math.round(r.latest[1]).toLocaleString('en-AU') + '<small>ML</small>'}</div>
          ${fill != null ? `<div class="bar"><span style="width:${Math.min(100, fill * 100)}%;background:${storageColor(p)}"></span></div>` : ''}
          <span class="hint">${Math.round(r.latest[1]).toLocaleString('en-AU')} ML, daily average for ${escapeHtml(fmtDate(r.latest[0]))}</span>
          ${sparkline(r.series)}</div>`;
        if (fill != null && fill >= 1) html += '<p class="hint"><strong>At or above full supply.</strong> Dams at full supply may be releasing or spilling water downstream.</p>';
      } else {
        html += '<p class="hint">No recent storage reading is published for this dam.</p>';
      }
    } else {
      const r = nat.readings.level && nat.readings.level[p.station];
      if (r) {
        html += `<div class="reading"><span class="label">${p.kind === 'tide' ? 'Water level' : 'River level'}</span>
          <div class="big">${r.latest[1].toFixed(2)}<small>m</small></div>
          <span class="hint">Daily average for ${escapeHtml(fmtDate(r.latest[0]))}, on the gauge's own datum. Last ${r.series.length} days:</span>
          ${sparkline(r.series)}</div>`;
      } else {
        html += '<p class="hint">No recent reading is published for this gauge on Water Data Online.</p>';
      }
      html += classHtml(p, r);
    }
    html += warningsHtml(p);

    if (p.kind === 'storage') html += '<div class="js-history"></div>';

    // Google Flood Hub near this point
    const fhg = p.kind !== 'storage' ? nearestFloodHubGauge(lat, lon, 15) : null;
    if (fhg && fhg.status) {
      const s = sev(fhg.status.severity);
      html += `<div class="reading"><span class="label">Google Flood Hub forecast nearby</span>
        <div><span class="sev" style="background:${s.color}">${s.label}</span> ${escapeHtml([fhg.siteName, fhg.river].filter(Boolean).join(', '))}</div>
        <span class="hint">${escapeHtml(gaugeLine(fhg))}</span></div>`;
    }

    // what can be done here
    const kind = p.kind === 'tide' ? 'coast' : 'river';
    html += `<div class="actions">
      <button type="button" class="btn primary js-model">${kind === 'coast' ? 'Model coastal flooding here' : 'Model flooding here'}</button>
      <button type="button" class="btn js-zoom">Zoom to</button>
      ${stateLayerFor(p.state) ? `<button type="button" class="btn js-state">Show ${escapeHtml(stateLayerFor(p.state).state)} flood mapping</button>` : ''}
    </div>`;
    const links = [];
    if (p.url) links.push(`<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">BoM water storage page</a>`);
    links.push('<a href="https://www.bom.gov.au/water/data/" target="_blank" rel="noopener">Water Data Online</a>');
    if (p.kind !== 'storage') links.push(`<a href="https://www.bom.gov.au/australia/flood/" target="_blank" rel="noopener">BoM flood warnings</a>`);
    html += `<p class="hint">${links.join(' · ')}</p>`;
    html += '<p class="hint">Readings: Water Data Online (Bureau of Meteorology and data owners). Not an official warning.</p>';

    const el = document.createElement('article');
    el.className = 'report-card';
    el.innerHTML = html;
    const q = (sel) => el.querySelector(sel);
    const title = p.kind === 'storage' ? 'Dam report' : p.kind === 'tide' ? 'Tide gauge report' : 'River gauge report';
    const r = { id, n: num, name: p.name, title, el, pin: null, lat, lon, kind: p.kind };
    if (state.lmap) {
      r.pin = window.L.marker([lat, lon], { icon: numIcon(num, st.color), keyboard: false, zIndexOffset: 1000 });
      if (!hiddenNums.has(num)) r.pin.addTo(state.lmap);
      r.pin.on('click', () => selectPlace(r.n));
    }
    q('.js-close').addEventListener('click', () => closeReport(r));
    q('.js-model').addEventListener('click', () => {
      const linked = areaForReport(r);
      if (linked) { activateArea(linked.key, { fit: true }); openPanel('panel-scenario'); return; }
      modelHere(lat, lon, { kind, name: p.name, reportId: id });
    });
    q('.js-zoom').addEventListener('click', () => state.lmap && state.lmap.setView([lat, lon], 13));
    const sl = stateLayerFor(p.state);
    if (sl && q('.js-state')) q('.js-state').addEventListener('click', () => {
      if (sl.layer && state.lmap) {
        sl.layer.userOn = true; sl.layer.addTo(state.lmap);
        state.lmap.setView([lat, lon], Math.max(state.lmap.getZoom(), sl.minZoom || 11));
        syncLayerLists(); renderOverlayLegend();
      }
    });
    if (p.kind === 'storage') addWaterHistory(p.id, q('.js-history'));
    const link = document.createElement('div');
    link.className = 'js-link';
    q('.actions').before(link);
    reports.push(r);
    selectedNum = num;
    $('reportBody').appendChild(el);
    selectPlace(r.n);
  }
  window.__floodOpenStorage = (index) => {
    const f = nat.data && nat.data.storages[index || 0];
    if (f) openReport(f);
    return !!f;
  };
  function stateLayerFor(st) {
    const code = String(st || '').toUpperCase();
    const norm = { QUEENSLAND: 'QLD', 'NEW SOUTH WALES': 'NSW' }[code] || code;
    return STATE_OVERLAYS.find((o) => o.state === norm && o.layer) || null;
  }

  window.__floodOpenReport = (index) => {
    const f = nat.data && nat.data.gauges.filter((g) => g.properties.kind === 'forecast')[index || 0];
    if (f) openReport(f);
    return !!f;
  };

  // A tap on empty map in the national view
  const ICON_ADD_PLACE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"/><path d="M12 7v6M9 10h6"/></svg>';
  // Tapping the map shows a small popup with one add-a-place button: an
  // empty spot becomes a pinned place, a gauge or dam becomes a report.
  function spotPopup(latlng, html, label, onAdd) {
    const div = document.createElement('div');
    div.className = 'spot';
    div.innerHTML = `<div class="spot-text">${html}</div>
      <button type="button" class="spot-add" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${ICON_ADD_PLACE}</button>`;
    div.querySelector('.spot-add').addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.lmap.closePopup();
      onAdd();
    });
    window.L.popup({ closeButton: false, className: 'spot-popup', offset: [0, -4], autoPanPadding: [24, 24] })
      .setLatLng(latlng).setContent(div).openOn(state.lmap);
  }

  function onNationalClick(e) {
    const { lat, lng } = e.latlng;
    const near = nearestNamed(lat, lng, 25);
    const coord = `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lng).toFixed(4)}° ${lng < 0 ? 'W' : 'E'}`;
    spotPopup(e.latlng, `<span class="spot-coord">${coord}</span>
      ${near ? `<span class="spot-near">${near.km.toFixed(1)} km from ${escapeHtml(near.f.properties.name)}</span>` : ''}`,
    'Add as a place', () => addPin(lat, lng));
  }

  function onDotClick(f, latlng) {
    if (Date.now() < suppressClickUntil) return;
    const p = f.properties;
    const existing = reports.find((r) => r.id === `${p.kind}:${p.id}`);
    if (existing) { selectPlace(existing.n); return; }   // already a place
    const st = GAUGE_STYLE[p.kind] || GAUGE_STYLE.river;
    let sub = st.label;
    if (p.kind === 'storage') {
      const fill = storageFill(p);
      if (fill != null) sub += ` · ${Math.round(fill * 100)}% full`;
    } else {
      const rd = nat.readings && nat.readings.level && nat.readings.level[p.station];
      if (rd && rd.latest) sub += ` · ${Number(rd.latest[1]).toFixed(2)} m`;
    }
    spotPopup(latlng, `<span class="spot-name"><i class="spot-dot" style="background:${p.kind === 'storage' ? storageColor(p) : st.color}"></i>${escapeHtml(p.name || st.label)}</span>
      <span class="spot-near">${escapeHtml(sub)}</span>`,
    'Add as a place and open its report', () => openReport(f));
  }
  window.__floodTapDot = (kind, i) => {
    const list = kind === 'storage' ? nat.data.storages : nat.data.gauges.filter((g) => !kind || g.properties.kind === kind);
    const f = list[i || 0];
    if (!f) return false;
    onDotClick(f, window.L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]));
    return true;
  };




  /* ---------- satellite water history for dams (DEA Waterbodies) */
  // Digital Earth Australia maps every waterbody seen by Landsat since 1987
  // and publishes, for each one, the percentage of its area seen wet on
  // every clear pass. The build fetches these for every BoM dam weekly
  // (pipeline/fetch_waterhistory.py), because DEA's files block browsers.
  status.waterbodies = {};

  let historyPromise = null;
  function loadWaterHistory() {
    if (!historyPromise) {
      historyPromise = fetch('data/national/waterhistory.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    }
    return historyPromise;
  }

  // monthly series -> [[time, pc], ...] without empty months
  function expandMonthly(h) {
    const [y0, m0] = h.start.split('-').map(Number);
    const out = [];
    h.monthly.forEach((v, i) => {
      if (v == null) return;
      out.push([Date.UTC(y0, m0 - 1 + i, 15), v]);
    });
    return out;
  }

  function historyChart(series) {
    const t0 = series[0][0], t1 = series[series.length - 1][0];
    const span = t1 - t0 || 1;
    const X = (t) => 4 + ((t - t0) / span) * 292, Y = (v) => 86 - (Math.max(0, Math.min(100, v)) / 100) * 78;
    const pts = series.map(([t, v]) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    const y0 = new Date(t0).getFullYear(), y1 = new Date(t1).getFullYear();
    const ticks = [];
    const step = Math.max(1, Math.round((y1 - y0) / 4));
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      const x = X(Date.UTC(y, 0, 1));
      if (x > 20 && x < 280) ticks.push(`<line x1="${x}" x2="${x}" y1="8" y2="86" stroke="var(--line)"/><text x="${x}" y="99" text-anchor="middle">${y}</text>`);
    }
    return `<svg viewBox="0 0 300 104" style="width:100%;height:auto;display:block;font:9px var(--font-data);fill:var(--muted)" role="img" aria-label="Percentage of the waterbody seen wet, ${y0} to ${y1}">
      ${ticks.join('')}
      <line x1="4" x2="296" y1="${Y(100)}" y2="${Y(100)}" stroke="var(--line)"/><line x1="4" x2="296" y1="${Y(50)}" y2="${Y(50)}" stroke="var(--line)" stroke-dasharray="2 3"/>
      <text x="6" y="${Y(100) + 9}">100%</text><text x="6" y="${Y(50) - 2}">50%</text>
      <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  async function addWaterHistory(storageId, box) {
    box.innerHTML = '<p class="hint">Looking up satellite records for this dam…</p>';
    const all = await loadWaterHistory();
    const h = all[storageId];
    if (!h || h.missing || !h.monthly) {
      box.innerHTML = '<p class="hint">No satellite water record is available for this dam.</p>';
      status.waterbodies = { ok: false, error: 'no record' };
      return;
    }
    const series = expandMonthly(h);
    const recent = series.filter(([t]) => t > Date.now() - 5 * 365 * 864e5).map(([, v]) => v);
    const lo = recent.length ? Math.min(...recent) : NaN, hi = recent.length ? Math.max(...recent) : NaN;
    box.innerHTML = `<div class="reading"><span class="label">Water seen by satellite</span>
      <div class="big">${Math.round(h.last[1])}<small>% of surface wet</small></div>
      <span class="hint">On ${escapeHtml(fmtDate(h.last[0]))}.${recent.length ? ` Over the last 5 years the monthly average ranged ${Math.round(lo)}–${Math.round(hi)}%.` : ''} ${h.passes.toLocaleString('en-AU')} clear Landsat passes since ${h.start.slice(0, 4)}.</span>
      ${historyChart(series)}
      <span class="hint">Monthly averages. Digital Earth Australia Waterbodies (Geoscience Australia), CC BY 4.0. Surface area, not volume.</span></div>`;
    status.waterbodies = { ok: true, points: series.length };
  }

  window.__floodOpenDam = (name) => {
    const f = nat.data && nat.data.storages.find((x) => !name || (x.properties.name || '').includes(name));
    if (f) openReport(f);
    return !!f;
  };

  /* ---------- flood classes, warnings and level points */
  function classFor(p) { return p && p.bom != null && nat.floodclass ? nat.floodclass[String(p.bom)] || null : null; }
  function floodStatus(v, c) {
    if (!c || v == null) return null;
    if (c.major != null && v >= c.major) return 'major';
    if (c.moderate != null && v >= c.moderate) return 'moderate';
    if (c.minor != null && v >= c.minor) return 'minor';
    return 'below minor';
  }
  function classHtml(p, r) {
    const c = classFor(p);
    if (!c) return '';
    const st = r ? floodStatus(r.latest[1], c) : null;
    const cell = (v) => (v == null ? '–' : `${v.toFixed(2)} m${c.zero != null ? `<br><small>${(c.zero + v).toFixed(2)} m AHD</small>` : ''}`);
    return `<div class="classes"><span class="label">Flood classes (BoM)</span>${st ? ` <strong>· now ${st}</strong>` : ''}
      <table><tr><th>Minor</th><th>Moderate</th><th>Major</th></tr><tr><td>${cell(c.minor)}</td><td>${cell(c.moderate)}</td><td>${cell(c.major)}</td></tr></table>
      <span class="hint">On the gauge board${c.zero != null ? `; gauge zero is ${c.zero.toFixed(2)} m AHD, so these can set a flood model's level` : '; no gauge zero is published, so they can\'t be converted to heights'}.</span></div>`;
  }
  function warningsFor(p) {
    const list = (nat.warnings && nat.warnings.warnings) || [];
    const st = String(p.state || '').toUpperCase().slice(0, 3);
    const keys = [p.basin, p.river_name, p.name].filter(Boolean).map((x) => String(x).toLowerCase().replace(/ (river )?basin$/, '').replace(/\s+r(iver)?\b.*$/, ''))
      .filter((k) => k.length > 3);
    return list.filter((w) => (!st || !w.state || w.state === st || (st === 'QUE' && w.state === 'QLD'))
      && keys.some((k) => w.title.toLowerCase().includes(k)));
  }
  function warningsHtml(p) {
    const ws = warningsFor(p);
    if (!ws.length) return '';
    return `<div>${ws.map((w) => `<a class="warn-item" href="${escapeHtml(w.link)}" target="_blank" rel="noopener"><strong>${escapeHtml(w.title)}</strong><small>Current Bureau of Meteorology warning${w.published ? ` · ${escapeHtml(w.published)}` : ''}</small></a>`).join('')}</div>`;
  }
  function renderWarnings() {
    const box = $('warningsBox');
    if (!box) return;
    const w = nat.warnings;
    status.warnings = w ? { ok: w.ok, count: (w.warnings || []).length } : { ok: false };
    if (!w) { box.innerHTML = '<p class="hint">Current flood warnings could not be loaded.</p>'; return; }
    const list = w.warnings || [];
    box.innerHTML = `<h3 class="places-sub">Current flood warnings (BoM)</h3>${list.length
      ? list.map((x) => `<a class="warn-item" href="${escapeHtml(x.link)}" target="_blank" rel="noopener"><strong>${escapeHtml(x.title)}</strong><small>${escapeHtml(x.state)}${x.published ? ` · ${escapeHtml(x.published)}` : ''}</small></a>`).join('')
      : `<p class="hint">${w.ok ? 'No flood warnings or watches are current.' : 'The warning feeds could not be reached at the last update.'}</p>`}
      <p class="hint">Checked ${escapeHtml(ago(w.fetched))}. Always follow official warnings at <a href="https://www.bom.gov.au/australia/warnings/" target="_blank" rel="noopener">bom.gov.au</a>.</p>`;
    nat.warningCount = list.length;
    if (list.length) $('forecastBadge').hidden = false;
  }

  // Gauges inside the active model: their flood classes (where the gauge
  // zero is known) or current readings become level points.
  function gaugesInModel() {
    const g = state.geo;
    if (!g || !nat.data || !state.a) return [];
    return nat.data.gauges.filter((f) => {
      const [lo, la] = f.geometry.coordinates;
      return la > g.south && la < g.north && lo > g.west && lo < g.east && f.properties.kind !== 'tide';
    });
  }
  function streamCellAt(lat, lon) {
    const c = latLngCell({ lat, lng: lon });
    if (!c) return -1;
    const s = F.snapToStream(state.a, c.x, c.y, 10);
    return s >= 0 ? s : c.i;
  }
  function applyGaugeLevels(which) {
    const pts = [];
    for (const f of gaugesInModel()) {
      const p = f.properties, c = classFor(p);
      if (!c || c.zero == null) continue;
      let v = null;
      if (which === 'now') { const r = nat.readings.level && nat.readings.level[p.station]; v = r ? r.latest[1] : null; } else v = c[which];
      if (v == null) continue;
      const cell = streamCellAt(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      if (cell >= 0) pts.push({ cell, level: Math.round((c.zero + v) * 100) / 100, label: p.name, auto: true });
    }
    if (!pts.length) return 0;
    // the one nearest the model's gauge sets the gauge level; the rest are points
    const gx = state.gauge % state.a.W, gy = Math.floor(state.gauge / state.a.W);
    pts.sort((p1, p2) => Math.hypot(p1.cell % state.a.W - gx, Math.floor(p1.cell / state.a.W) - gy) - Math.hypot(p2.cell % state.a.W - gx, Math.floor(p2.cell / state.a.W) - gy));
    const first = pts[0], d = Math.hypot(first.cell % state.a.W - gx, Math.floor(first.cell / state.a.W) - gy);
    const rest = d <= 12 ? pts.slice(1) : pts;
    if (d <= 12) {
      ctl.gaugeLevel.min = Math.min(parseFloat(ctl.gaugeLevel.min), Math.floor(first.level - 2));
      ctl.gaugeLevel.max = Math.max(parseFloat(ctl.gaugeLevel.max), Math.ceil(first.level + 3));
      ctl.gaugeLevel.value = first.level;
      ctl.extra.value = 0;
    }
    state.controls = (state.controls || []).filter((x) => !x.auto).concat(rest);
    state.base = null;
    syncOutputs();
    runScenario();
    renderLevelPoints();
    say(`Set ${pts.length} gauge level${pts.length === 1 ? '' : 's'} from ${which === 'now' ? 'current readings' : `${which} flood class`}.`);
    return pts.length;
  }
  window.__floodApplyGaugeLevels = applyGaugeLevels;

  function renderLevelPoints() {
    const set = $('levelPointsSet');
    if (!set) return;
    const local = state.a && state.geo;
    set.hidden = !local || scenarioEmpty;
    if (set.hidden) return;
    const inside = gaugesInModel(), withZero = inside.filter((f) => { const c = classFor(f.properties); return c && c.zero != null; });
    const withClass = inside.filter((f) => classFor(f.properties));
    let ch = '';
    if (withZero.length) {
      const hasNow = withZero.some((f) => nat.readings.level && nat.readings.level[f.properties.station]);
      ch = `<p class="hint">${withZero.length} gauge${withZero.length === 1 ? '' : 's'} here ${withZero.length === 1 ? 'has' : 'have'} Bureau flood class levels. Set the river to:</p>
        <div class="class-btns"><button type="button" class="btn small" data-cls="minor">Minor</button><button type="button" class="btn small" data-cls="moderate">Moderate</button><button type="button" class="btn small" data-cls="major">Major</button>${hasNow ? '<button type="button" class="btn small" data-cls="now">Now</button>' : ''}</div>`;
    } else if (withClass.length) {
      ch = `<p class="hint">${withClass.length} gauge${withClass.length === 1 ? '' : 's'} here ${withClass.length === 1 ? 'has' : 'have'} flood classes, but on the gauge board without a published gauge zero, so they can't be placed on the map. See the gauge reports.</p>`;
    }
    $('classLevels').innerHTML = ch;
    $('classLevels').querySelectorAll('[data-cls]').forEach((b) => b.addEventListener('click', () => applyGaugeLevels(b.dataset.cls)));
    const pts = state.controls || [];
    status.levelPoints = pts.length;
    $('levelPoints').innerHTML = pts.map((p, i) => `<div class="level-point"><span>${escapeHtml(p.label || `Point ${i + 1}`)}</span>
      <input type="number" step="0.05" value="${p.level.toFixed(2)}" data-lp="${i}" aria-label="Water level at ${escapeHtml(p.label || `point ${i + 1}`)} in metres">
      <button type="button" class="icon-btn" data-lp-drop="${i}" aria-label="Remove this level point" title="Remove">×</button></div>`).join('');
    $('levelPoints').querySelectorAll('[data-lp]').forEach((inp) => inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (Number.isFinite(v)) { state.controls[+inp.dataset.lp].level = v; state.base = null; runScenario(); }
    }));
    $('levelPoints').querySelectorAll('[data-lp-drop]').forEach((b) => b.addEventListener('click', () => {
      state.controls.splice(+b.dataset.lpDrop, 1); state.base = null; runScenario(); renderLevelPoints();
    }));
    $('addLevelPoint').setAttribute('aria-pressed', String(!!state.addingPoint));
    $('addLevelPoint').textContent = state.addingPoint ? 'Tap the river on the map…' : 'Add a level point';
  }
  $('addLevelPoint').addEventListener('click', () => { state.addingPoint = !state.addingPoint; renderLevelPoints(); });
  function addLevelPointAt(latlng) {
    const s0 = streamCellAt(latlng.lat, latlng.lng);
    state.addingPoint = false;
    if (s0 < 0) { say('That spot is outside this model.'); renderLevelPoints(); return; }
    const lv = state.run && Number.isFinite(state.run.level[s0]) ? state.run.level[s0] : state.a.dem[s0] + 1;
    state.controls = (state.controls || []).concat([{ cell: s0, level: Math.round(lv * 20) / 20, label: `Point ${(state.controls || []).length + 1}` }]);
    state.base = null;
    runScenario();
    renderLevelPoints();
    say('Level point added. Type the water level you want there in Scenario.');
  }
  window.__floodAddLevelPoint = (lat, lon) => addLevelPointAt({ lat, lng: lon });

  /* ---------- on-demand flood modelling */

  async function fetchDemWindow(lat, lon, halfKm, cellM) {
    const dLat = (halfKm * 1000) / 110574;
    const dLon = (halfKm * 1000) / (111320 * Math.cos((lat * Math.PI) / 180));
    const w = lon - dLon, e = lon + dLon, s = lat - dLat, n = lat + dLat;
    const W = Math.round((2 * halfKm * 1000) / cellM), H = W;
    const url = `${DEMH_WCS}?service=WCS&version=1.0.0&request=GetCoverage&coverage=1&crs=EPSG:4326`
      + `&bbox=${w.toFixed(6)},${s.toFixed(6)},${e.toFixed(6)},${n.toFixed(6)}&width=${W}&height=${H}&format=GeoTIFF`;
    // GA's service occasionally drops a request (its error replies carry no
    // CORS header, so the browser reports a network failure): try again
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((ok) => setTimeout(ok, 1500 * attempt));
      try { r = await fetch(url); } catch (err) { r = null; if (attempt === 2) throw new Error('the elevation service could not be reached; try again shortly'); continue; }
      if (r.ok || r.status < 500) break;
    }
    if (!r.ok) throw new Error(`the elevation service returned ${r.status}`);
    const type = r.headers.get('content-type') || '';
    if (!/tiff/i.test(type)) throw new Error('the elevation service did not return elevation data for this place');
    const buf = await r.arrayBuffer();
    let iw, ih, data, nd, tiffBounds = null;
    try {
      // GA's service leaves all-sea tiles out ("sparse" tiles); this reader
      // handles that, unlike the general GeoTIFF library
      const t = F.parseSimpleTiff(buf);
      iw = t.W; ih = t.H; data = t.data; nd = t.nodata; tiffBounds = t.bounds;
    } catch (err) {
      await loadGeoTiffLib();
      const img = await (await window.GeoTIFF.fromArrayBuffer(buf)).getImage();
      iw = img.getWidth(); ih = img.getHeight();
      data = (await img.readRasters({ samples: [0] }))[0];
      nd = img.getGDALNoData();
      try { tiffBounds = img.getBoundingBox(); } catch (e2) { tiffBounds = null; }
    }
    const dem = new Float32Array(iw * ih), valid = new Uint8Array(iw * ih);
    let land = 0;
    for (let i = 0; i < iw * ih; i++) {
      let v = data[i];
      // DEM-H marks the sea as no data; treat it as water just below sea level
      if (!Number.isFinite(v) || v === nd || v < -1000 || v > 9000) v = -1.5; // sea or no data
      else land++;
      dem[i] = v; valid[i] = 1;
    }
    if (land < iw * ih * 0.05) throw new Error('there is almost no land in the elevation data here');
    let bounds = [w, s, e, n];
    if (tiffBounds && tiffBounds.length === 4 && Math.abs(tiffBounds[0] - w) < 0.05 && Math.abs(tiffBounds[3] - n) < 0.05) bounds = tiffBounds;
    const cell = ((bounds[2] - bounds[0]) * 111320 * Math.cos((lat * Math.PI) / 180)) / iw;
    return { grid: { W: iw, H: ih, cell, dem, valid }, bounds };
  }

  async function modelHere(lat, lon, opts) {
    const o = Object.assign({ kind: 'river', name: 'This area' }, opts || {});
    const t0 = performance.now();
    setBusy(true, 'Downloading elevation for this area…');
    status.local = { started: true };
    try {
      // 20 km square at ~30 m; if the elevation file can't be read, try once
      // more at a slightly different size (the service occasionally returns
      // a file the reader rejects)
      let got = null, lastErr = null;
      const H0 = o.halfKm || 10, C0 = o.cellM || 30, [wlat, wlon] = o.center || [lat, lon];
      if (H0 > 10) setBusy(true, `Downloading elevation for a ${2 * H0} km area…`);
      for (const [half, cell] of [[H0, C0], [H0, Math.round(C0 * 1.07)], [H0 * 0.9, C0]]) {
        try { got = await fetchDemWindow(wlat, wlon, half, cell); break; } catch (err) {
          lastErr = err;
          if (/no land/.test(String(err.message))) break;
        }
      }
      if (!got) throw lastErr || new Error('no elevation data');
      const { grid, bounds } = got;
      setBusy(true, 'Working out how water flows here…');
      await nextFrame();
      const col = Math.round(((lon - bounds[0]) / (bounds[2] - bounds[0])) * grid.W);
      const row = Math.round(((bounds[3] - lat) / (bounds[3] - bounds[1])) * grid.H);
      if (col < 0 || row < 0 || col >= grid.W || row >= grid.H) throw new Error('the gauge fell outside the elevation window');
      if (o.replaceKey) removeArea(o.replaceKey, { quiet: true });   // extending: the new window replaces the old
      const key = `local-${++localCount}`;
      state.areaMeta = {
        id: 'local', areaKey: key, local: true, kind: o.kind, name: o.name, bounds_lonlat: bounds, reportId: o.reportId || null, presetId: o.presetId || null, pinN: o.pinN != null ? o.pinN : null,
        keepN: o.keepN != null ? o.keepN : null, halfKm: o.halfKm || 10, gaugeLatLon: [lat, lon], centerLatLon: o.center || [lat, lon],
        gauge: { col, row }, streamAreaKm2: o.streamAreaKm2 || Math.max(0.5, Math.min(4, (grid.W * grid.H * grid.cell * grid.cell) / 1e6 * 0.004)),
        source: 'Terrain: Geoscience Australia 1-second (about 30 m) hydrologically enforced elevation model (DEM-H), CC BY 4.0, read live from GA.',
      };
      addModelledOption(key, o.name);
      $('area').value = key;
      await useGrid(grid, 'local', { events: false });
      if (o.kind === 'coast') {
        ctl.bayLevel.value = 1.5;
        if (state.gauge >= 0) ctl.gaugeLevel.value = Math.max(parseFloat(ctl.gaugeLevel.min), Math.round((state.a.dem[state.gauge] + 0.5) * 20) / 20);
        state.base = null;
        syncOutputs();
        runScenario();
      }
      status.local = { ok: true, key, W: grid.W, H: grid.H, cell: Math.round(grid.cell), ms: Math.round(performance.now() - t0), kind: o.kind, km: 2 * (o.halfKm || 10) };
      openPanel('panel-scenario');
      if (!o.replaceKey) say(o.kind === 'coast'
        ? 'Coastal model ready. Set the bay level and sea-level rise in Scenario.'
        : 'River model ready. Set the peak level at the gauge in Scenario.');
      return true;
    } catch (err) {
      status.local = { ok: false, error: String(err.message || err) };
      say(`Couldn’t model this area: ${err.message || err}.`);
      return false;
    } finally {
      setBusy(false);
    }
  }
  window.__floodModelHere = modelHere;

  /* ---------- study an area: drag a box, pull in everything inside */
  // Opens reports for every gauge and dam in the box, covers the whole box
  // with flood models (each run from a gauge where there is one, or from a
  // pinned spot), and switches on the state flood layer.
  let suppressClickUntil = 0;
  const STUDY_CONFIRM_MODELS = 12;   // ask before building more than this
  status.study = null;

  function setStudyMode(on) {
    const m = state.lmap;
    if (!m) { say('Open the Australia map first.'); return; }
    $('studyArea').setAttribute('aria-pressed', String(on));
    $('studyHint').hidden = !on;
    $('lmap').classList.toggle('selecting', on);
    if (on) { m.dragging.disable(); m.closePopup(); } else m.dragging.enable();
    studyDrag.on = on;
  }
  const studyDrag = { on: false, start: null, rect: null };
  function studyPoint(e) { return state.lmap.mouseEventToLatLng(e); }
  function wireStudy() {
    const el = $('lmap');
    el.addEventListener('pointerdown', (e) => {
      if (!studyDrag.on || e.button > 0) return;
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      studyDrag.start = studyPoint(e);
      studyDrag.rect = window.L.rectangle([studyDrag.start, studyDrag.start], { color: '#0d5f8c', weight: 2, dashArray: '6 4', fillOpacity: 0.08, interactive: false }).addTo(state.lmap);
    }, true);
    el.addEventListener('pointermove', (e) => {
      if (!studyDrag.on || !studyDrag.rect) return;
      e.preventDefault();
      studyDrag.rect.setBounds(window.L.latLngBounds(studyDrag.start, studyPoint(e)));
    }, true);
    el.addEventListener('pointerup', (e) => {
      if (!studyDrag.on || !studyDrag.rect) return;
      const b = window.L.latLngBounds(studyDrag.start, studyPoint(e));
      state.lmap.removeLayer(studyDrag.rect);
      studyDrag.rect = null;
      suppressClickUntil = Date.now() + 500;
      const px = state.lmap.latLngToContainerPoint(b.getNorthEast()).subtract(state.lmap.latLngToContainerPoint(b.getSouthWest()));
      if (Math.abs(px.x) < 12 || Math.abs(px.y) < 12) { say('Drag to draw a box over the area.'); return; }
      setStudyMode(false);
      studyArea(b);
    }, true);
  }
  $('studyArea').addEventListener('click', () => setStudyMode(!studyDrag.on));
  $('studyCancel').addEventListener('click', () => setStudyMode(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && studyDrag.on) setStudyMode(false); });

  const kmBetween = (a, b) => {
    const dy = (a[0] - b[0]) * 110.574, dx = (a[1] - b[1]) * 111.32 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
    return Math.hypot(dx, dy);
  };

  // Studied areas stay on the map as lettered boxes, are listed in Places,
  // and are saved in this browser so they come back next visit (their
  // models are rebuilt on demand with the run button).
  const STUDY_KEY = 'floodExplorer.studies.v1';
  const studies = [];
  let selectedStudy = null;
  const ICON_RUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>';
  function saveStudies() {
    try {
      localStorage.setItem(STUDY_KEY, JSON.stringify(studies.map((x) => ({ letter: x.letter, bounds: x.bounds, name: x.name, created: x.created, summary: x.summary }))));
    } catch (e) { /* storage unavailable: studies last for this visit */ }
  }
  function nextLetter() {
    const used = new Set(studies.map((x) => x.letter));
    for (let i = 0; ; i++) {
      const l = i < 26 ? String.fromCharCode(65 + i) : `A${i - 25}`;
      if (!used.has(l)) return l;
    }
  }
  function drawStudy(st) {
    const L = window.L, m = state.lmap;
    if (!m || st.rect) return;
    const [S, W, N, E] = st.bounds;
    st.rect = L.rectangle([[S, W], [N, E]], { color: '#0d5f8c', weight: 1.5, dashArray: '8 6', fill: false, interactive: false }).addTo(m);
    st.label = L.marker([N, W], {
      icon: L.divIcon({ className: 'study-label', html: `<span>${st.letter}</span>`, iconSize: [26, 26], iconAnchor: [0, 0] }),
      keyboard: false, zIndexOffset: 700,
    }).addTo(m);
    st.label.bindTooltip(`Study area ${st.letter}: ${st.name}`, { direction: 'top', offset: [13, 0] });
    st.label.on('click', () => selectStudy(st.letter));
  }
  function loadStudies() {
    if (studies.length) return;
    try {
      const saved = JSON.parse(localStorage.getItem(STUDY_KEY) || '[]');
      saved.forEach((x) => { if (Array.isArray(x.bounds) && x.bounds.length === 4) studies.push(Object.assign({}, x, { loaded: false })); });
    } catch (e) { /* nothing saved */ }
    studies.forEach(drawStudy);
    renderPlaces();
  }
  function addStudy(b) {
    const bounds = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
    const c = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    const near = nearestNamed(c[0], c[1], 60);
    const st = { letter: nextLetter(), bounds, name: near ? `Around ${near.f.properties.name}` : `${c[0].toFixed(2)}, ${c[1].toFixed(2)}`, created: new Date().toISOString(), summary: null, loaded: false };
    studies.push(st);
    drawStudy(st);
    saveStudies();
    return st;
  }
  function selectStudy(letter) {
    const st = studies.find((x) => x.letter === letter);
    if (!st || !state.lmap) return;
    const [S, W, N, E] = st.bounds;
    state.lmap.fitBounds([[S, W], [N, E]], { padding: [30, 30] });
    studies.forEach((x) => x.rect && x.rect.setStyle({ weight: x === st ? 3 : 1.5 }));
    selectedStudy = letter;
    setPlacesCollapsed(false);
    renderPlaces();
  }
  function studySize(st) {
    const [S, W, N, E] = st.bounds;
    return `${Math.round((E - W) * 111.32 * Math.cos(((S + N) / 2) * Math.PI / 180))} × ${Math.round((N - S) * 110.574)} km`;
  }
  function studiesHtml() {
    if (!studies.length) return '';
    const rows = studies.map((st) => {
      const sm = st.summary;
      const tags = [studySize(st), sm ? `${sm.gauges} gauge${sm.gauges === 1 ? '' : 's'}, ${sm.dams} dam${sm.dams === 1 ? '' : 's'}` : null,
        st.loaded ? `${sm ? sm.models : 0} model${sm && sm.models === 1 ? '' : 's'} on the map` : 'saved: run to load its models'].filter(Boolean).join(' · ');
      return `<li class="place study-row${selectedStudy === st.letter ? ' on' : ''}">
        <button type="button" class="place-main" data-study="${st.letter}" title="Show study area ${st.letter}">
          <span class="pin-num study-badge">${st.letter}</span>
          <span class="place-text"><span class="place-name">${escapeHtml(st.name)}</span><span class="place-tags">${tags}</span></span>
        </button>
        <button type="button" class="icon-btn" data-study-run="${st.letter}" aria-label="${st.loaded ? 'Run again' : 'Run'}: load its gauges, dams and flood models" title="${st.loaded ? 'Run again' : 'Run study'}">${ICON_RUN}</button>
        <button type="button" class="icon-btn" data-study-zoom="${st.letter}" aria-label="Zoom to study area ${st.letter}" title="Zoom to">${ICON_ZOOM}</button>
        <button type="button" class="icon-btn" data-study-drop="${st.letter}" aria-label="Remove study area ${st.letter}" title="Remove">×</button>
      </li>`;
    }).join('');
    return `<h3 class="places-sub">Studied areas</h3><ul class="places">${rows}</ul>`;
  }
  function wireStudyRows(box) {
    box.querySelectorAll('[data-study]').forEach((b) => b.addEventListener('click', () => selectStudy(b.dataset.study)));
    box.querySelectorAll('[data-study-zoom]').forEach((b) => b.addEventListener('click', () => selectStudy(b.dataset.studyZoom)));
    box.querySelectorAll('[data-study-run]').forEach((b) => b.addEventListener('click', () => {
      const st = studies.find((x) => x.letter === b.dataset.studyRun);
      if (st) { const [S, W, N, E] = st.bounds; studyArea(window.L.latLngBounds([S, W], [N, E]), st); }
    }));
    box.querySelectorAll('[data-study-drop]').forEach((b) => b.addEventListener('click', () => {
      const i = studies.findIndex((x) => x.letter === b.dataset.studyDrop);
      if (i < 0) return;
      const st = studies[i];
      [st.rect, st.label].forEach((l) => l && state.lmap && state.lmap.removeLayer(l));
      studies.splice(i, 1);
      if (selectedStudy === st.letter) selectedStudy = null;
      saveStudies();
      renderPlaces();
    }));
  }
  window.__floodStudies = () => studies.map((x) => ({ letter: x.letter, name: x.name, bounds: x.bounds, loaded: x.loaded, summary: x.summary }));

  async function studyArea(b, existing) {
    const study = existing || addStudy(b);
    selectedStudy = study.letter;
    if (!nat.data) await loadNationalData();
    const S = b.getSouth(), N = b.getNorth(), Wl = b.getWest(), E = b.getEast();
    const midLat = (S + N) / 2;
    const wKm = (E - Wl) * 111.32 * Math.cos(midLat * Math.PI / 180), hKm = (N - S) * 110.574;
    // the finest model size that covers the box in a handful of windows;
    // bigger boxes use the largest size and as many windows as they need
    let size = null, nx = 0, ny = 0;
    for (const [half, cell] of MODEL_SIZES) {
      size = [half, cell];
      nx = Math.max(1, Math.ceil(wKm / (2 * half) - 0.05)); ny = Math.max(1, Math.ceil(hKm / (2 * half) - 0.05));
      if (nx * ny <= 4) break;
    }
    const inBox = (f) => { const [lo, la] = f.geometry.coordinates; return la >= S && la <= N && lo >= Wl && lo <= E; };
    const rank = { forecast: 0, information: 1, tide: 2, river: 3 };
    const gauges = nat.data.gauges.filter(inBox).sort((x, y) => (rank[x.properties.kind] ?? 9) - (rank[y.properties.kind] ?? 9));
    const dams = nat.data.storages.filter(inBox);
    // tiles, each modelled from the best gauge inside it
    const tiles = [];
    const dLat = (N - S) / ny, dLon = (E - Wl) / nx;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const t = { s: S + j * dLat, n: S + (j + 1) * dLat, w: Wl + i * dLon, e: Wl + (i + 1) * dLon };
      t.c = [(t.s + t.n) / 2, (t.w + t.e) / 2];
      const inside = gauges.filter((f) => { const [lo, la] = f.geometry.coordinates; return la >= t.s && la <= t.n && lo >= t.w && lo <= t.e && f.properties.kind !== 'tide'; });
      inside.sort((x, y) => ((rank[x.properties.kind] ?? 9) - (rank[y.properties.kind] ?? 9))
        || kmBetween([x.geometry.coordinates[1], x.geometry.coordinates[0]], t.c) - kmBetween([y.geometry.coordinates[1], y.geometry.coordinates[0]], t.c));
      t.gauge = inside[0] || null;
      t.tide = gauges.find((f) => f.properties.kind === 'tide' && (() => { const [lo, la] = f.geometry.coordinates; return la >= t.s && la <= t.n && lo >= t.w && lo <= t.e; })()) || null;
      tiles.push(t);
    }
    // skip parts already covered by a model on the map
    const covered = (t) => Array.from(areaReg.values()).some((a) => {
      const bb = a.areaMeta && a.areaMeta.bounds_lonlat;
      return bb && bb[0] <= t.w && bb[2] >= t.e && bb[1] <= t.s && bb[3] >= t.n;
    });
    const todo = tiles.filter((t) => !covered(t));
    if (todo.length > STUDY_CONFIRM_MODELS
      && !window.confirm(`This box needs ${todo.length} flood models (${2 * size[0]} km each), which takes a while and a lot of memory. Build them all?`)) {
      status.study = { ok: false, error: 'cancelled', models: todo.length };
      return status.study;
    }
    const summary = { ok: true, km: 2 * size[0], tiles: tiles.length, models: 0, reports: 0, gauges: gauges.length, dams: dams.length, layers: [] };
    status.study = Object.assign({ running: true }, summary);
    state.lmap.fitBounds(b, { padding: [30, 30] });
    // state flood layers for the states in the box
    const states = new Set([...gauges, ...dams].map((f) => f.properties.state).filter(Boolean));
    for (const st of states) {
      const sl = stateLayerFor(st);
      if (sl && sl.layer && !state.lmap.hasLayer(sl.layer)) { sl.layer.userOn = true; sl.layer.addTo(state.lmap); summary.layers.push(sl.name); }
    }
    if (summary.layers.length) { syncLayerLists(); renderOverlayLegend(); }
    // reports for every gauge and dam in the box, tile gauges first
    const want = [...tiles.map((t) => t.gauge || t.tide).filter(Boolean), ...dams, ...gauges];
    const seen = new Set();
    for (const f of want) {
      const id = `${f.properties.kind}:${f.properties.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!reports.some((r) => r.id === id)) summary.reports++;
      openReport(f);
    }
    // models, one per tile
    summary.models = tiles.length - todo.length;   // already covered
    for (const [k, t] of todo.entries()) {
      setBusy(true, `Modelling part ${k + 1} of ${todo.length} of the area…`);
      const src = t.gauge || t.tide;
      let ok;
      if (src) {
        const [lo, la] = src.geometry.coordinates, p = src.properties;
        const r = reports.find((x) => x.id === `${p.kind}:${p.id}`);
        if (r && areaForReport(r)) { summary.models++; continue; }
        ok = await modelHere(la, lo, { kind: p.kind === 'tide' ? 'coast' : 'river', name: p.name, reportId: r ? r.id : null, halfKm: size[0], cellM: size[1], center: t.c });
      } else {
        const pin = addPin(t.c[0], t.c[1]);
        ok = await modelHere(t.c[0], t.c[1], { kind: 'river', name: pin.name, pinN: pin.n, halfKm: size[0], cellM: size[1], center: t.c });
      }
      if (ok) summary.models++;
    }
    setBusy(false);
    status.study = summary;
    study.summary = { gauges: summary.gauges, dams: summary.dams, models: summary.models, km: summary.km };
    study.loaded = true;
    saveStudies();
    renderPlaces();
    const first = tiles.map((t) => t.gauge || t.tide).find(Boolean);
    say(`Area study: ${summary.models} flood model${summary.models === 1 ? '' : 's'} (${summary.km} km each), ${summary.gauges} gauge${summary.gauges === 1 ? '' : 's'} and ${summary.dams} dam${summary.dams === 1 ? '' : 's'} inside${summary.layers.length ? `; ${summary.layers.join(', ')} on` : ''}.`);
    if (first) { const r = reports.find((x) => x.id === `${first.properties.kind}:${first.properties.id}`); if (r) selectPlace(r.n); }
    state.lmap.fitBounds(b, { padding: [30, 30] });
    return summary;
  }
  window.__floodStudyArea = (s0, w0, n0, e0) => studyArea(window.L.latLngBounds([s0, w0], [n0, e0]));

  /* --------------------------------------------------------- panels */
  const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

  // On wide screens the Scenario panel always shows under Places and
  // collapses to its header; on phones it is a bottom sheet like the rest.
  function setScenarioCollapsed(collapsed) {
    const p = $('panel-scenario');
    p.classList.toggle('collapsed', collapsed);
    $('scenarioCollapse').setAttribute('aria-expanded', String(!collapsed));
    $('scenarioCollapse').setAttribute('aria-label', collapsed ? 'Expand the flood scenario' : 'Collapse the flood scenario');
    status.scenarioOpen = !collapsed;
    syncPanels();
  }
  window.__floodSetScenarioCollapsed = setScenarioCollapsed;
  $('scenarioCollapse').addEventListener('click', () => setScenarioCollapsed(!$('panel-scenario').classList.contains('collapsed')));
  $('scenarioToggle').addEventListener('click', (e) => {
    if (isPhone() || e.target.closest('button, a')) return;
    setScenarioCollapsed(!$('panel-scenario').classList.contains('collapsed'));
  });

  function openPanel(id) {
    const target = $(id);
    if (!target) return;
    if (id === 'panel-scenario') target.classList.remove('collapsed');
    document.querySelectorAll('[data-panel]').forEach((p) => {
      if (p === target) return;
      if (isPhone() || p.dataset.side === target.dataset.side) p.hidden = true;
    });
    target.hidden = false;
    syncPanels();
    if (id === 'panel-profile' && state.run) drawProfile(scenario());
  }

  function closePanel(id) {
    if (id === 'panel-scenario' && !isPhone()) { setScenarioCollapsed(true); return; }
    $(id).hidden = true;
    syncPanels();
  }

  function syncPanels() {
    if (!isPhone()) $('panel-scenario').hidden = false;
    document.querySelectorAll('.tool[data-open]').forEach((b) => {
      const p = $(b.dataset.open);
      b.setAttribute('aria-pressed', String(!p.hidden && !p.classList.contains('collapsed')));
    });
    document.body.classList.toggle('sheet-open', !!document.querySelector('[data-panel]:not([hidden])'));
  }

  document.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.open;
      const shown = !$(id).hidden && !$(id).classList.contains('collapsed');
      if (b.classList.contains('tool') && shown) closePanel(id);
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
    const target = right || (isPhone() ? open[0] : null);
    if (target) closePanel(target.id);
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
    setPlacesCollapsed(isPhone());
    if (isPhone()) $('panel-scenario').hidden = true;
    syncPanels();
    renderPlaces();
    const areas = await listAreas();
    await loadFloodHub();
    await loadArea(areas[0].id);
  })();
})();
