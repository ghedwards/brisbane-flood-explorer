/*
 * Brisbane Flood Explorer — model core
 *
 * Pure functions, no DOM. Works in the browser (global `FloodCore`)
 * and in Node (`require('./src/flood-core.js')`) for tests.
 *
 * Pipeline
 *   1. Terrain grid (synthetic sample, or a DEM the user loads)
 *   2. Ocean mask: cells at or below 0 m connected to the grid edge
 *   3. Priority-flood depression filling (Barnes et al. 2014, with epsilon)
 *   4. D8 flow directions and flow accumulation
 *   5. Stream network from a contributing-area threshold
 *   6. Water surface along the network, driven by a gauge level and a
 *      downstream (bay) level
 *   7. Connected inundation: a cell floods when it sits below the water
 *      surface of the stream it drains to (HAND-style) AND it touches
 *      water through 4-connected wet cells
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FloodCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 8-neighbour offsets; first four are the 4-neighbours
  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY = [0, 0, 1, -1, 1, -1, 1, -1];
  const DD = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

  /* ---------------------------------------------------------------- RNG + noise */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeValueNoise(seed) {
    const rnd = mulberry32(seed);
    const P = 256;
    const vals = new Float64Array(P * P);
    for (let i = 0; i < vals.length; i++) vals[i] = rnd();
    const at = (ix, iy) => vals[((iy & (P - 1)) * P) + (ix & (P - 1))];
    const fade = (t) => t * t * (3 - 2 * t);
    function noise(x, y) {
      const ix = Math.floor(x), iy = Math.floor(y);
      const fx = fade(x - ix), fy = fade(y - iy);
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
      return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
    }
    return function fbm(x, y, octaves) {
      let sum = 0, amp = 0.5, freq = 1, norm = 0;
      for (let o = 0; o < (octaves || 5); o++) {
        sum += amp * noise(x * freq, y * freq);
        norm += amp; amp *= 0.5; freq *= 2.03;
      }
      return sum / norm; // 0..1
    };
  }

  const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  /* --------------------------------------------------------- distance transform */

  // Two-pass chamfer distance (in cells) from cells where src[i] === 1.
  function chamferDistance(src, W, H) {
    const INF = 1e9;
    const d = new Float64Array(W * H);
    for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : INF;
    const a = 1, b = Math.SQRT2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - W] + a);
        if (x > 0) v = Math.min(v, d[i - W - 1] + b);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + b);
      }
      d[i] = v;
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x; let v = d[i];
      if (x < W - 1) v = Math.min(v, d[i + 1] + a);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + a);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + b);
        if (x > 0) v = Math.min(v, d[i + W - 1] + b);
      }
      d[i] = v;
    }
    return d;
  }

  function rasterisePolyline(pts, W, H, out) {
    for (let k = 0; k < pts.length - 1; k++) {
      const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2) + 1;
      for (let s = 0; s <= n; s++) {
        const x = Math.round(x0 + (x1 - x0) * s / n), y = Math.round(y0 + (y1 - y0) * s / n);
        if (x >= 0 && y >= 0 && x < W && y < H) out[y * W + x] = 1;
      }
    }
  }

  /* ---------------------------------------------------------- synthetic terrain */

  /**
   * Illustrative lower-river terrain: a meandering river running west to
   * east into a bay, low floodplain flats, hills, and two tributary creeks.
   * NOT real Brisbane elevation. Used so the app works with no data loaded.
   */
  function syntheticTerrain(opts) {
    const o = Object.assign({ W: 420, H: 300, cell: 50, seed: 1974 }, opts || {});
    const { W, H, cell } = o;
    const fbm = makeValueNoise(o.seed);
    const fbm2 = makeValueNoise(o.seed + 11);
    const coastX = Math.round(W * 0.84);

    // River centreline: west edge to the coast, with meander loops
    const river = [];
    for (let x = -2; x <= coastX + 6; x += 1) {
      const t = x / coastX;
      const y = H * 0.5
        + 46 * Math.sin(t * Math.PI * 3.1 + 0.4)
        + 22 * Math.sin(t * Math.PI * 7.3 + 1.1) * (1 - t * 0.6)
        + 10 * (fbm2(x / 40, 3.3, 3) - 0.5);
      river.push([x, y]);
    }
    // Two tributary creeks joining from the north and south
    const creekA = [], creekB = [];
    const jA = river[Math.round(coastX * 0.35)], jB = river[Math.round(coastX * 0.62)];
    for (let s = 0; s <= 1.0001; s += 0.02) {
      creekA.push([jA[0] - 30 * s + 8 * Math.sin(s * 9), jA[1] - (jA[1] - 8) * s]);
      creekB.push([jB[0] + 18 * s + 7 * Math.sin(s * 11), jB[1] + (H - 8 - jB[1]) * s]);
    }

    const rMask = new Uint8Array(W * H), cMask = new Uint8Array(W * H);
    rasterisePolyline(river, W, H, rMask);
    rasterisePolyline(creekA, W, H, cMask);
    rasterisePolyline(creekB, W, H, cMask);
    const dR = chamferDistance(rMask, W, H);
    const dC = chamferDistance(cMask, W, H);

    const dem = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const coast = coastX + 10 * (fbm(3.1, y / 30, 3) - 0.5) * 2;
        const t = Math.min(1, Math.max(0, x / coastX));
        const base = 1.2 + 9.5 * Math.pow(1 - t, 1.6); // floodplain base, m
        const dm = dR[i] * cell; // metres from river
        const plainW = 900 + 1400 * fbm(x / 70, y / 70, 3) * (0.6 + 0.6 * t);
        const hills = smoothstep(plainW, plainW + 1600, dm) * (14 + 85 * fbm(x / 55, y / 55, 5));
        let z = base + 1.6 * (dm / 1000) + hills + 1.2 * (fbm(x / 9, y / 9, 3) - 0.5);
        // creek valleys
        const dcm = dC[i] * cell;
        z -= (6 + hills * 0.6) * Math.exp(-dcm / 260);
        if (dcm < 60) z = Math.min(z, base + 1.0 + 0.004 * dm - 1.5);
        // main channel, ~240 m wide, ~6 m deep
        if (dm < 160) {
          const f = 1 - dm / 160;
          z = Math.min(z, base - 6.2 * f * f + 0.4);
        }
        // bay
        if (x > coast) z = Math.min(z, -1.5 - (x - coast) * 0.06);
        else if (x > coast - 14) z = Math.min(z, 0.4 + (coast - x) * 0.09 + (hills * 0.1));
        dem[i] = z;
      }
    }
    // Upstream inflow: the river enters from the west edge carrying a large
    // catchment that is outside the grid. Mark the entry cell so flow
    // accumulation knows about it.
    // (a few cells in from the edge, so the entry cell is not itself an outlet)
    let entry = 0, best = Infinity;
    for (let y = 0; y < H; y++) if (dem[y * W + 4] < best) { best = dem[y * W + 4]; entry = y * W + 4; }
    const inflow = new Float32Array(W * H);
    inflow[entry] = 1e6; // cells; effectively ~2500 km² at 50 m cells

    return {
      W, H, cell, dem,
      valid: null, inflow,
      name: 'Sample terrain (illustrative)',
      synthetic: true,
    };
  }

  /* -------------------------------------------------------------------- heap */

  function MinHeap(cap) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  MinHeap.prototype.push = function (key, val) {
    let i = this.n++;
    const k = this.k, v = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  };
  MinHeap.prototype.pop = function () {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k[--this.n], lv = v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && k[c + 1] < k[c]) c++;
      if (k[c] >= lk) break;
      k[i] = k[c]; v[i] = v[c]; i = c;
    }
    k[i] = lk; v[i] = lv;
    return top;
  };

  /* -------------------------------------------------------------- hydrology */

  /**
   * Run the terrain analysis once per DEM.
   * grid: { W, H, cell, dem, valid?, inflow?, d8? }
   *   d8: optional Whitebox D8 pointer codes (from the RustGIS pipeline).
   *       When present, flow routing comes from it instead of being
   *       computed here.
   * opts: { streamAreaKm2 }
   */
  function analyse(grid, opts) {
    const o = Object.assign({ streamAreaKm2: 4 }, opts || {});
    const { W, H, cell, dem } = grid;
    const N = W * H;
    const valid = grid.valid || new Uint8Array(N).fill(1);

    // --- sea: cells <= 0 m connected to the edge or to nodata (for display,
    //     stats and seeding; the river network still runs through it)
    const ocean = new Uint8Array(N);
    const q = new Int32Array(N);
    let qh = 0, qt = 0;
    const touchesBoundary = (x, y) => {
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return true;
      for (let k = 0; k < 4; k++) if (!valid[(y + DY[k]) * W + x + DX[k]]) return true;
      return false;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (valid[i] && dem[i] <= 0 && touchesBoundary(x, y)) { ocean[i] = 1; q[qt++] = i; }
    }
    while (qh < qt) {
      const c = q[qh++], cx = c % W, cy = (c - cx) / W;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (!ocean[n] && valid[n] && dem[n] <= 0) { ocean[n] = 1; q[qt++] = n; }
      }
    }

    // --- flow routing: receivers (rec), step lengths, and an order in which
    //     every receiver comes before its donors (downstream first)
    const routed = grid.d8
      ? routeFromPointers(grid.d8, W, H, cell, valid)
      : routeByPriorityFlood(dem, W, H, cell, valid, touchesBoundary);
    const { rec, recDist, order, nOrder } = routed;
    const filled = routed.filled || null;

    // --- accumulation (cells), chainage to outlet (m)
    const acc = new Float64Array(N);
    const inflow = grid.inflow;
    for (let j = nOrder - 1; j >= 0; j--) {
      const c = order[j];
      acc[c] += 1 + (inflow ? inflow[c] : 0);
      if (rec[c] >= 0) acc[rec[c]] += acc[c];
    }
    const chain = new Float64Array(N);
    for (let j = 0; j < nOrder; j++) {
      const c = order[j];
      chain[c] = rec[c] >= 0 ? chain[rec[c]] + recDist[c] : 0;
    }

    // --- streams and the stream each cell drains to
    const cellAreaKm2 = (cell * cell) / 1e6;
    const thresh = o.streamAreaKm2 / cellAreaKm2;
    const stream = new Uint8Array(N);
    for (let c = 0; c < N; c++) if (valid[c] && acc[c] >= thresh) stream[c] = 1;
    const recvStream = new Int32Array(N).fill(-1);
    for (let j = 0; j < nOrder; j++) {
      const c = order[j];
      if (stream[c]) recvStream[c] = c;
      else if (rec[c] >= 0) recvStream[c] = recvStream[rec[c]];
    }

    // --- main outlet (largest catchment reaching the sea/edge)
    let mainOutlet = -1, mainAcc = -1;
    for (let c = 0; c < N; c++) {
      if (stream[c] && rec[c] < 0 && acc[c] > mainAcc) { mainAcc = acc[c]; mainOutlet = c; }
    }

    const a = {
      W, H, cell, N, dem, valid, ocean, filled, order, nOrder,
      routedBy: grid.d8 ? 'pointers' : 'priority-flood',
      rec, acc, chain, stream, recvStream, mainOutlet,
      streamAreaKm2: o.streamAreaKm2,
    };
    a.defaultGauge = defaultGauge(a);
    return a;
  }

  /**
   * Route flow ourselves: priority-flood depression filling (Barnes 2014,
   * epsilon variant) then steepest-descent D8. Used for the sample terrain
   * and for raw DEMs loaded in the browser.
   */
  function routeByPriorityFlood(dem, W, H, cell, valid, touchesBoundary) {
    const N = W * H;
    const filled = Float64Array.from(dem);
    const closed = new Uint8Array(N);
    const heap = new MinHeap(N);
    for (let i = 0; i < N; i++) if (!valid[i]) closed[i] = 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!valid[i]) continue;
      // Outlets are the grid edge and nodata. Sea cells are routed through
      // (not treated as sinks) so estuaries stay part of the river network.
      if (touchesBoundary(x, y)) { closed[i] = 1; heap.push(filled[i], i); }
    }
    const order = new Int32Array(N);
    let nOrder = 0;
    const EPS = 1e-5;
    while (heap.n > 0) {
      const c = heap.pop();
      order[nOrder++] = c;
      const cx = c % W, cy = (c - cx) / W;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (closed[n]) continue;
        closed[n] = 1;
        if (filled[n] <= filled[c]) filled[n] = filled[c] + EPS;
        heap.push(filled[n], n);
      }
    }
    const rec = new Int32Array(N).fill(-1);
    const recDist = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      if (!valid[c]) continue;
      const cx = c % W, cy = (c - cx) / W;
      let best = 0, bn = -1, bd = 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (!valid[n]) continue;
        const s = (filled[c] - filled[n]) / DD[k];
        if (s > best) { best = s; bn = n; bd = DD[k]; }
      }
      rec[c] = bn; recDist[c] = bd * cell;
    }
    return { rec, recDist, order, nOrder, filled };
  }

  // Whitebox / GeoLibre D8 pointer codes (esri_pntr=false), as written by
  // the `d8_pointer` tool that RustGIS runs:
  //   64 128   1        NW  N  NE
  //   32   0   2   =>    W  .   E      0 = no outflow, other = nodata
  //   16   8   4        SW  S  SE
  const WBT_CODES = [1, 2, 4, 8, 16, 32, 64, 128];
  const WBT_DX = [1, 1, 1, 0, -1, -1, -1, 0];
  const WBT_DY = [-1, 0, 1, 1, 1, 0, -1, -1];

  /**
   * Route flow from a precomputed D8 pointer raster (the pipeline's
   * `d8.tif`). Builds a downstream-first order with Kahn's algorithm; any
   * cell left over (a cycle, which a valid pointer grid never has) becomes
   * an outlet so the model still runs.
   */
  function routeFromPointers(codes, W, H, cell, valid) {
    const N = W * H;
    const rec = new Int32Array(N).fill(-1);
    const recDist = new Float32Array(N);
    const lut = new Int8Array(256).fill(-1);
    WBT_CODES.forEach((c, k) => { lut[c] = k; });
    for (let c = 0; c < N; c++) {
      if (!valid[c]) continue;
      const code = codes[c];
      const k = code >= 0 && code < 256 ? lut[code] : -1;
      if (k < 0) continue;
      const cx = c % W, cy = (c - cx) / W;
      const nx = cx + WBT_DX[k], ny = cy + WBT_DY[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (!valid[n]) continue;
      rec[c] = n;
      recDist[c] = (WBT_DX[k] && WBT_DY[k] ? Math.SQRT2 : 1) * cell;
    }
    // upstream-first topological order, then reverse it
    const indeg = new Int32Array(N);
    for (let c = 0; c < N; c++) if (rec[c] >= 0) indeg[rec[c]]++;
    const up = new Int32Array(N);
    let n = 0, head = 0;
    for (let c = 0; c < N; c++) if (valid[c] && indeg[c] === 0) up[n++] = c;
    while (head < n) {
      const c = up[head++];
      const r = rec[c];
      if (r >= 0 && --indeg[r] === 0) up[n++] = r;
    }
    if (n < validCount(valid)) {
      // break cycles: cells never released become outlets
      for (let c = 0; c < N; c++) if (valid[c] && indeg[c] > 0) { rec[c] = -1; indeg[c] = 0; }
      return routeFromRec(rec, recDist, valid, N);
    }
    const order = new Int32Array(n);
    for (let j = 0; j < n; j++) order[j] = up[n - 1 - j];
    return { rec, recDist, order, nOrder: n };
  }

  function validCount(valid) { let k = 0; for (let i = 0; i < valid.length; i++) k += valid[i]; return k; }

  function routeFromRec(rec, recDist, valid, N) {
    const indeg = new Int32Array(N);
    for (let c = 0; c < N; c++) if (rec[c] >= 0) indeg[rec[c]]++;
    const up = new Int32Array(N);
    let n = 0, head = 0;
    for (let c = 0; c < N; c++) if (valid[c] && indeg[c] === 0) up[n++] = c;
    while (head < n) {
      const c = up[head++];
      const r = rec[c];
      if (r >= 0 && --indeg[r] === 0) up[n++] = r;
    }
    const order = new Int32Array(n);
    for (let j = 0; j < n; j++) order[j] = up[n - 1 - j];
    return { rec, recDist, order, nOrder: n };
  }

  /** Encode an analysis' receivers as Whitebox D8 codes (tests, exports). */
  function encodeWhiteboxD8(a) {
    const out = new Int16Array(a.N);
    for (let c = 0; c < a.N; c++) {
      if (!a.valid[c]) { out[c] = -32768; continue; }
      const r = a.rec[c];
      if (r < 0) { out[c] = 0; continue; }
      const dx = (r % a.W) - (c % a.W), dy = Math.floor(r / a.W) - Math.floor(c / a.W);
      for (let k = 0; k < 8; k++) if (WBT_DX[k] === dx && WBT_DY[k] === dy) { out[c] = WBT_CODES[k]; break; }
    }
    return out;
  }

  // Largest donor upstream of c (main-stem tracing)
  function mainDonor(a, c) {
    const { W, H, rec, acc } = a;
    const cx = c % W, cy = (c - cx) / W;
    let best = -1, bAcc = -1;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX[k], ny = cy + DY[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (rec[n] === c && a.stream[n] && acc[n] > bAcc) { bAcc = acc[n]; best = n; }
    }
    return best;
  }

  // Main stem from the headwater (or grid edge) down to the main outlet
  function mainStem(a) {
    if (a.mainOutlet < 0) return [];
    const up = [];
    let c = a.mainOutlet;
    while (c >= 0) { up.push(c); c = mainDonor(a, c); }
    return up.reverse(); // upstream -> downstream
  }

  function defaultGauge(a) {
    const stem = mainStem(a);
    if (!stem.length) return -1;
    const L = a.chain[stem[0]];
    // gauge ~45% of the way up the main stem from the mouth
    let best = stem[0], bd = Infinity;
    for (const c of stem) {
      const d = Math.abs(a.chain[c] - 0.45 * L);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  // Snap a clicked cell to the nearest stream cell within r cells whose
  // flow accumulation is at least minAcc cells (default: any stream)
  function snapToStream(a, x, y, r, minAcc) {
    const R = r || 10;
    const floor = minAcc || 0;
    let best = -1, bd = Infinity;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= a.W || ny >= a.H) continue;
      const n = ny * a.W + nx;
      if (!a.stream[n] || a.acc[n] < floor) continue;
      const d = dx * dx + dy * dy - Math.log10(a.acc[n]) * 0.01;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  /* ---------------------------------------------------------- water surface */

  /**
   * Water surface elevation for every stream cell.
   * s: { gauge (cell), gaugeLevel (m), bayLevel (m), upstreamGradient (m/km) }
   *
   * - Between the gauge and the mouth the surface varies linearly with
   *   river distance from bayLevel to gaugeLevel.
   * - Upstream of the gauge, and on tributaries, the surface rises at
   *   upstreamGradient from the point where the reach joins that path.
   * - Streams reaching the sea by another route rise from bayLevel.
   */
  // Water surface along the stream network. The gauge and any extra control
  // points (s.controls: [{cell, level}]) fix the level at those cells; along
  // the flow path below each one the level runs linearly to the next control
  // point downstream (or to the bay level at the outlet). Where two paths
  // share cells (below a junction) the higher level wins. Streams not on a
  // controlled path rise from where they join one at upstreamGradient m/km.
  function streamSurface(a, s) {
    const { N, order, nOrder, rec, chain, stream } = a;
    const ctrl = [];
    if (s.gauge >= 0) ctrl.push({ cell: s.gauge, level: s.gaugeLevel });
    (s.controls || []).forEach((c) => { if (c && c.cell >= 0 && c.cell < N && Number.isFinite(c.level)) ctrl.push(c); });
    const ctrlLevel = new Map();
    ctrl.forEach((c) => ctrlLevel.set(c.cell, Math.max(ctrlLevel.get(c.cell) ?? -Infinity, c.level)));
    const onPath = new Uint8Array(N);
    const pathWse = new Float64Array(N).fill(-Infinity);
    for (const { cell: p0 } of ctrl) {
      const L0 = ctrlLevel.get(p0);
      // find the next control downstream (or the outlet)
      let q = rec[p0], end = -1;
      while (q >= 0) { if (ctrlLevel.has(q)) { end = q; break; } q = rec[q]; }
      const cU = chain[p0], cD = end >= 0 ? chain[end] : 0, LD = end >= 0 ? ctrlLevel.get(end) : s.bayLevel;
      let c = p0;
      while (c >= 0 && c !== end) {
        const t = cU > cD ? (chain[c] - cD) / (cU - cD) : 1;
        const v = LD + (L0 - LD) * t;
        if (v > pathWse[c]) pathWse[c] = v;
        onPath[c] = 1;
        c = rec[c];
      }
      if (end >= 0) onPath[end] = 1;
    }
    for (const [c, v] of ctrlLevel) if (v > pathWse[c]) pathWse[c] = v;
    const grad = s.upstreamGradient / 1000;

    const junc = new Int32Array(N).fill(-1);
    const wse = new Float64Array(N).fill(NaN);
    for (let j = 0; j < nOrder; j++) {
      const c = order[j];
      if (!stream[c]) continue;
      if (onPath[c]) { junc[c] = c; wse[c] = pathWse[c]; continue; }
      const r = rec[c];
      junc[c] = (r >= 0 && stream[r]) ? junc[r] : -1;
      if (junc[c] >= 0) wse[c] = wse[junc[c]] + grad * (chain[c] - chain[junc[c]]);
      else wse[c] = s.bayLevel + grad * chain[c];
    }
    return { wse, onPath };
  }

  /* --------------------------------------------------------------- inundation */

  /**
   * Connected inundation for one scenario.
   * Returns { wet (Uint8), depth (Float32), level (Float32), wse, onPath }
   */
  function inundate(a, s) {
    const { W, H, N, dem, valid, ocean, stream, recvStream } = a;
    const { wse, onPath } = streamSurface(a, s);
    const level = new Float32Array(N).fill(NaN);
    for (let c = 0; c < N; c++) {
      if (!valid[c]) continue;
      if (recvStream[c] >= 0) level[c] = wse[recvStream[c]];
      else level[c] = s.bayLevel; // sea, or land draining straight to it
    }
    const wet = new Uint8Array(N);
    const q = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let c = 0; c < N; c++) {
      if (!valid[c]) continue;
      if ((ocean[c] || stream[c]) && dem[c] < level[c]) { wet[c] = 1; q[qt++] = c; }
    }
    while (qh < qt) {
      const c = q[qh++], cx = c % W, cy = (c - cx) / W;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DX[k], ny = cy + DY[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (wet[n] || !valid[n]) continue;
        if (dem[n] < level[n]) { wet[n] = 1; q[qt++] = n; }
      }
    }
    const depth = new Float32Array(N);
    for (let c = 0; c < N; c++) if (wet[c]) depth[c] = level[c] - dem[c];
    return { wet, depth, level, wse, onPath };
  }

  /**
   * Area statistics comparing a scenario against a baseline run.
   */
  function stats(a, run, base) {
    const cellKm2 = (a.cell * a.cell) / 1e6;
    let land = 0, extra = 0, rawMax = 0, sumD = 0, deep = 0;
    const offChannel = [];
    for (let c = 0; c < a.N; c++) {
      if (!run.wet[c] || a.ocean[c]) continue;
      land++;
      if (base && base.wet[c]) continue;
      extra++;
      const d = run.depth[c];
      sumD += d;
      if (d > rawMax) rawMax = d;
      if (d >= 1) deep++;
      if (!a.stream[c]) offChannel.push(d);
    }
    // "Deepest water" is the 99th percentile of newly flooded land away from
    // stream channels: single pits, quarries and carved channel cells in the
    // elevation model otherwise dominate the maximum.
    let p99 = 0;
    if (offChannel.length) {
      offChannel.sort((x, y) => x - y);
      p99 = offChannel[Math.min(offChannel.length - 1, Math.floor(offChannel.length * 0.99))];
    }
    return {
      wetLandKm2: land * cellKm2,
      floodedKm2: extra * cellKm2,
      deepKm2: deep * cellKm2,
      maxDepth: p99,
      rawMaxDepth: rawMax,
      meanDepth: extra ? sumD / extra : 0,
    };
  }

  /* ---------------------------------------------------------- DEM helpers */

  /** Parse an ESRI ASCII grid (.asc) string into { W, H, cell, dem, valid }. */
  function parseAsciiGrid(text) {
    const lines = text.split(/\r?\n/);
    const hdr = {};
    let li = 0;
    for (; li < lines.length; li++) {
      const m = lines[li].trim().match(/^([A-Za-z_]+)\s+(-?[\d.eE+-]+)$/);
      if (!m) break;
      hdr[m[1].toLowerCase()] = parseFloat(m[2]);
    }
    const W = hdr.ncols, H = hdr.nrows, cell = hdr.cellsize;
    if (!(W > 0 && H > 0 && cell > 0)) throw new Error('Not an ASCII grid: missing ncols, nrows or cellsize.');
    const nd = 'nodata_value' in hdr ? hdr.nodata_value : -9999;
    const vals = lines.slice(li).join(' ').trim().split(/\s+/);
    if (vals.length < W * H) throw new Error(`ASCII grid has ${vals.length} values, expected ${W * H}.`);
    const dem = new Float32Array(W * H), valid = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const v = parseFloat(vals[i]);
      if (Number.isFinite(v) && v !== nd) { dem[i] = v; valid[i] = 1; }
    }
    return { W, H, cell, dem, valid };
  }

  /** Block-average a grid so its longest side is at most maxSide cells. */
  function downsample(grid, maxSide) {
    const { W, H } = grid;
    const f = Math.ceil(Math.max(W, H) / maxSide);
    if (f <= 1) return grid;
    const w = Math.floor(W / f), h = Math.floor(H / f);
    const dem = new Float32Array(w * h), valid = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) {
        const k = (y * f + j) * W + x * f + i;
        if (!grid.valid || grid.valid[k]) { s += grid.dem[k]; n++; }
      }
      // a block is valid if most of it is valid
      if (n * 2 >= f * f) { dem[y * w + x] = s / n; valid[y * w + x] = 1; }
    }
    return Object.assign({}, grid, { W: w, H: h, cell: grid.cell * f, dem, valid });
  }

  /** Mark values outside a plausible elevation range as nodata. */
  function cleanNodata(grid, nodata) {
    const N = grid.W * grid.H;
    const valid = grid.valid || new Uint8Array(N).fill(1);
    for (let i = 0; i < N; i++) {
      const v = grid.dem[i];
      if (!Number.isFinite(v) || v === nodata || v < -500 || v > 9000) valid[i] = 0;
    }
    grid.valid = valid;
    return grid;
  }


  /**
   * Read a single-band, uncompressed 32-bit float GeoTIFF (tiled or
   * stripped), as Geoscience Australia's elevation service returns. Tiles
   * with no data are often left out entirely (offset or byte count 0,
   * "sparse" tiles); they are filled with the no-data value.
   * Returns { W, H, data: Float32Array, nodata, bounds: [w, s, e, n] | null }
   * or throws if the file uses a layout this reader doesn't handle.
   */
  function parseSimpleTiff(buffer) {
    const dv = new DataView(buffer);
    const bo = dv.getUint16(0);
    if (bo !== 0x4949 && bo !== 0x4d4d) throw new Error('not a TIFF file');
    const le = bo === 0x4949;
    if (dv.getUint16(2, le) !== 42) throw new Error('BigTIFF is not supported');
    const ifd = dv.getUint32(4, le);
    const n = dv.getUint16(ifd, le);
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      const tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
      const bytes = (SIZE[type] || 1) * count;
      const at = bytes <= 4 ? e + 8 : dv.getUint32(e + 8, le);
      const vals = [];
      if (type === 2) {
        let str = '';
        for (let k = 0; k < count; k++) { const c = dv.getUint8(at + k); if (c) str += String.fromCharCode(c); }
        tags[tag] = str;
        continue;
      }
      for (let k = 0; k < count; k++) {
        const o = at + k * (SIZE[type] || 1);
        if (type === 3) vals.push(dv.getUint16(o, le));
        else if (type === 4 || type === 16) vals.push(dv.getUint32(o, le));
        else if (type === 11) vals.push(dv.getFloat32(o, le));
        else if (type === 12) vals.push(dv.getFloat64(o, le));
        else vals.push(dv.getUint8(o));
      }
      tags[tag] = vals;
    }
    const W = tags[256][0], H = tags[257][0];
    const bits = (tags[258] || [32])[0], fmt = (tags[339] || [1])[0], comp = (tags[259] || [1])[0];
    const spp = (tags[277] || [1])[0];
    if (comp !== 1 || bits !== 32 || fmt !== 3 || spp !== 1) throw new Error('unsupported TIFF layout');
    const nodata = tags[42113] != null ? parseFloat(tags[42113]) : NaN; // GDAL_NODATA
    const fill = Number.isFinite(nodata) ? nodata : NaN;
    const data = new Float32Array(W * H).fill(fill);
    const read = (off, count, w, h, x0, y0, bw) => {
      if (!off || !count || off + count > buffer.byteLength) return; // sparse or truncated: leave no data
      for (let r = 0; r < h; r++) {
        const y = y0 + r;
        if (y >= H) break;
        for (let c = 0; c < w; c++) {
          const x = x0 + c;
          if (x >= W) break;
          data[y * W + x] = dv.getFloat32(off + (r * bw + c) * 4, le);
        }
      }
    };
    if (tags[322]) {
      const tw = tags[322][0], th = tags[323][0];
      const offs = tags[324], cnts = tags[325];
      const across = Math.ceil(W / tw);
      offs.forEach((off, t) => read(off, cnts[t], tw, th, (t % across) * tw, Math.floor(t / across) * th, tw));
    } else {
      const rps = (tags[278] || [H])[0];
      tags[273].forEach((off, k) => read(off, tags[279][k], W, rps, 0, k * rps, W));
    }
    let bounds = null;
    if (tags[33550] && tags[33922]) {
      const [sx, sy] = tags[33550], tp = tags[33922];
      const west = tp[3] - tp[0] * sx, north = tp[4] + tp[1] * sy;
      bounds = [west, north - H * sy, west + W * sx, north];
    }
    return { W, H, data, nodata, bounds };
  }

  return {
    syntheticTerrain, analyse, mainStem, snapToStream, encodeWhiteboxD8,
    streamSurface, inundate, stats,
    parseAsciiGrid, downsample, cleanNodata, parseSimpleTiff,
    // exposed for tests
    _internal: { MinHeap, chamferDistance, mulberry32 },
  };
});
