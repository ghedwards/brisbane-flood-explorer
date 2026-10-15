// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../viewer/flood-core.js');

const grid = F.syntheticTerrain();
const a = F.analyse(grid);
const scenario = (level, extra) => Object.assign(
  { gauge: a.defaultGauge, gaugeLevel: level, bayLevel: 1, upstreamGradient: 0.3 }, extra || {});

test('sample terrain has a river reaching the sea and a gauge on it', () => {
  assert.ok(a.mainOutlet >= 0, 'main outlet found');
  assert.ok(a.defaultGauge >= 0, 'gauge placed');
  assert.equal(a.stream[a.defaultGauge], 1);
  const stem = F.mainStem(a);
  assert.ok(a.chain[stem[0]] > 20000, 'main stem longer than 20 km');
  let c = a.defaultGauge, reachedSea = false;
  while (c >= 0) { if (a.ocean[c]) reachedSea = true; c = a.rec[c]; }
  assert.ok(reachedSea, 'gauge drains to the sea');
});

test('every cell drains to an outlet (no pits or cycles)', () => {
  assert.equal(a.nOrder, a.N);
  for (let c = 0; c < a.N; c++) {
    let k = 0, x = c;
    while (a.rec[x] >= 0 && k < a.N) { x = a.rec[x]; k++; }
    assert.ok(k < a.N);
  }
});

test('flooded area grows with the gauge level', () => {
  const base = F.inundate(a, scenario(0.5, { bayLevel: 0 }));
  let prev = -1;
  for (const L of [2.3, 3.85, 4.46, 5.45, 8.35]) {
    const s = F.stats(a, F.inundate(a, scenario(L)), base);
    assert.ok(s.floodedKm2 > prev, `area at ${L} m (${s.floodedKm2}) > ${prev}`);
    prev = s.floodedKm2;
  }
});

test('water level equals the gauge level at the gauge and the bay level at the mouth', () => {
  const run = F.inundate(a, scenario(4.46));
  assert.ok(Math.abs(run.wse[a.defaultGauge] - 4.46) < 1e-9);
  assert.ok(Math.abs(run.wse[a.mainOutlet] - 1) < 1e-9);
});

test('sea-level rise floods more land near the coast', () => {
  const base = F.inundate(a, scenario(0.5, { bayLevel: 0 }));
  const today = F.stats(a, F.inundate(a, scenario(2.3, { bayLevel: 1.0 })), base);
  const future = F.stats(a, F.inundate(a, scenario(2.3, { bayLevel: 1.8 })), base);
  assert.ok(future.floodedKm2 > today.floodedKm2);
});

test('flooded cells are connected to the river or sea', () => {
  const run = F.inundate(a, scenario(5.45));
  for (let c = 0; c < a.N; c++) {
    if (!run.wet[c] || a.stream[c] || a.ocean[c]) continue;
    const x = c % a.W, y = Math.floor(c / a.W);
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return nx >= 0 && ny >= 0 && nx < a.W && ny < a.H && run.wet[ny * a.W + nx];
    });
    assert.ok(nb, `isolated wet cell ${c}`);
    assert.ok(run.depth[c] > 0);
  }
});

test('Whitebox D8 pointers from the RustGIS pipeline reproduce the same model', () => {
  const codes = F.encodeWhiteboxD8(a);
  const b = F.analyse(Object.assign({}, grid, { d8: codes }));
  assert.equal(b.routedBy, 'pointers');
  for (let c = 0; c < a.N; c++) assert.equal(b.rec[c], a.rec[c]);
  const ra = F.inundate(a, scenario(4.46)), rb = F.inundate(b, scenario(4.46));
  assert.deepEqual(Array.from(rb.wet), Array.from(ra.wet));
});

test('Whitebox pointer codes follow the documented directions', () => {
  // 3 x 3 grid; the centre cell points each way in turn
  const W = 3, H = 3;
  const expect = { 1: [2, 0], 2: [2, 1], 4: [2, 2], 8: [1, 2], 16: [0, 2], 32: [0, 1], 64: [0, 0], 128: [1, 0] };
  for (const [code, [x, y]] of Object.entries(expect)) {
    const d8 = new Int16Array(9); d8[4] = Number(code);
    const g = { W, H, cell: 10, dem: new Float32Array(9).fill(5), d8 };
    const r = F.analyse(g, { streamAreaKm2: 1 });
    assert.equal(r.rec[4], y * W + x, `code ${code}`);
  }
});

test('ASCII grid parser reads headers and nodata', () => {
  const g = F.parseAsciiGrid('ncols 3\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 5\nNODATA_value -9999\n1 2 3\n4 -9999 6\n');
  assert.equal(g.W, 3); assert.equal(g.H, 2); assert.equal(g.cell, 5);
  assert.equal(g.valid[4], 0); assert.equal(g.dem[5], 6);
});

test('downsample keeps the longest side under the limit', () => {
  const d = F.downsample(grid, 100);
  assert.ok(Math.max(d.W, d.H) <= 100);
  assert.ok(d.cell > grid.cell);
});

// Build a little-endian, tiled, float32 GeoTIFF; tiles listed in `sparse`
// get offset 0 and byte count 0, like GA's elevation service writes for sea.
function buildTiff(W, H, tile, value, sparse) {
  const across = Math.ceil(W / tile), down = Math.ceil(H / tile), nt = across * down;
  const tileBytes = tile * tile * 4;
  const entries = [
    [256, 3, 1, [W]], [257, 3, 1, [H]], [258, 3, 1, [32]], [259, 3, 1, [1]], [262, 3, 1, [1]],
    [277, 3, 1, [1]], [322, 3, 1, [tile]], [323, 3, 1, [tile]], [324, 4, nt, null], [325, 4, nt, null],
    [339, 3, 1, [3]], [33550, 12, 3, [0.001, 0.001, 0]], [33922, 12, 6, [0, 0, 0, 153, -27, 0]],
    [42113, 2, 6, '-9999'],
  ];
  const ifdAt = 8, ifdSize = 2 + entries.length * 12 + 4;
  let extra = ifdAt + ifdSize;
  const extras = [];
  const place = (bytes) => { const at = extra; extra += bytes; if (extra % 2) extra++; return at; };
  const offsAt = place(nt * 4), cntsAt = place(nt * 4), scaleAt = place(24), tieAt = place(48), ndAt = place(8);
  const dataAt = extra;
  const total = dataAt + nt * tileBytes;
  const buf = new ArrayBuffer(total), dv = new DataView(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, ifdAt, true);
  dv.setUint16(ifdAt, entries.length, true);
  let k = 0;
  for (let t = 0; t < nt; t++) {
    const off = sparse.includes(t) ? 0 : dataAt + (k++) * tileBytes;
    dv.setUint32(offsAt + t * 4, off, true);
    dv.setUint32(cntsAt + t * 4, off ? tileBytes : 0, true);
    if (off) for (let i = 0; i < tile * tile; i++) dv.setFloat32(off + i * 4, value + t, true);
  }
  [0.001, 0.001, 0].forEach((v, i) => dv.setFloat64(scaleAt + i * 8, v, true));
  [0, 0, 0, 153, -27, 0].forEach((v, i) => dv.setFloat64(tieAt + i * 8, v, true));
  '-9999\0'.split('').forEach((c, i) => dv.setUint8(ndAt + i, c.charCodeAt(0)));
  entries.forEach(([tag, type, count, vals], i) => {
    const e = ifdAt + 2 + i * 12;
    dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true);
    if (tag === 324) dv.setUint32(e + 8, offsAt, true);
    else if (tag === 325) dv.setUint32(e + 8, cntsAt, true);
    else if (tag === 33550) dv.setUint32(e + 8, scaleAt, true);
    else if (tag === 33922) dv.setUint32(e + 8, tieAt, true);
    else if (tag === 42113) dv.setUint32(e + 8, ndAt, true);
    else if (type === 3) dv.setUint16(e + 8, vals[0], true);
    else dv.setUint32(e + 8, vals[0], true);
  });
  return buf;
}

test('GeoTIFF reader handles sparse tiles from the elevation service', () => {
  const buf = buildTiff(200, 150, 128, 10, [3]);
  const t = F.parseSimpleTiff(buf);
  assert.equal(t.W, 200); assert.equal(t.H, 150);
  assert.equal(t.nodata, -9999);
  assert.equal(t.data[0], 10);                    // tile 0
  assert.equal(t.data[130], 11);                  // tile 1 (x >= 128)
  assert.equal(t.data[130 * 200 + 5], 12);        // tile 2 (y >= 128)
  assert.equal(t.data[140 * 200 + 150], -9999);   // tile 3 is sparse
  assert.deepEqual(t.bounds.map((v) => +v.toFixed(3)), [153, -27.15, 153.2, -27]);
});

test('deepest-water figure ignores a single deep pit', () => {
  const base = F.inundate(a, scenario(0.5, { bayLevel: 0 }));
  const run = F.inundate(a, scenario(4.46));
  const before = F.stats(a, run, base).maxDepth;
  // dig a 30 m pit in one newly flooded, off-channel cell
  let pit = -1;
  for (let c = 0; c < a.N; c++) if (run.wet[c] && !base.wet[c] && !a.stream[c] && !a.ocean[c]) { pit = c; break; }
  run.depth[pit] = 30;
  const s = F.stats(a, run, base);
  assert.ok(Math.abs(s.maxDepth - before) < 0.5, `p99 moved from ${before} to ${s.maxDepth}`);
  assert.equal(s.rawMaxDepth, 30);
});

test('extra control points pin the water surface and interpolate between them', () => {
  // a point halfway between the gauge and the mouth along the main channel
  const path = [];
  for (let c = a.defaultGauge; c >= 0; c = a.rec[c]) path.push(c);
  const mid = path[Math.floor(path.length / 2)];
  const run = F.inundate(a, scenario(4, { controls: [{ cell: mid, level: 3.5 }] }));
  assert.ok(Math.abs(run.wse[mid] - 3.5) < 1e-9, 'level fixed at the control point');
  assert.ok(Math.abs(run.wse[a.defaultGauge] - 4) < 1e-9, 'gauge keeps its level');
  const q = path[Math.floor(path.length / 4)];
  assert.ok(run.wse[q] > 3.5 - 1e-9 && run.wse[q] < 4 + 1e-9, 'between the gauge and the control point');
  const r = path[Math.floor(path.length * 0.75)];
  assert.ok(run.wse[r] > 1 - 1e-9 && run.wse[r] < 3.5 + 1e-9, 'between the control point and the bay');
  const plain = F.inundate(a, scenario(4));
  assert.ok(Math.abs(plain.wse[mid] - 3.5) > 1e-6, 'without it the level differs');
});

test('flash flood: no storm, no water; bigger storms flood more', () => {
  const none = F.flashFlood(a, { rainMm: 0, hours: 1 });
  let wetLand = 0;
  for (let c = 0; c < a.N; c++) if (none.wet[c] && !a.ocean[c]) wetLand++;
  assert.equal(wetLand, 0, 'no rain floods nothing');
  const count = (r) => { let n = 0; for (let c = 0; c < a.N; c++) if (r.wet[c] && !a.ocean[c]) n++; return n; };
  const small = F.flashFlood(a, { rainMm: 40, hours: 1 });
  const big = F.flashFlood(a, { rainMm: 200, hours: 1 });
  assert.ok(count(big) > count(small), 'more rain floods more land');
  assert.ok(big.summary.maxCreekRise > small.summary.maxCreekRise, 'creeks rise higher');
  assert.ok(big.summary.excessMm === 200 - 15 - 2.5, 'losses taken off the rain');
});

test('flash flood: rain that soaks in makes no runoff', () => {
  const r = F.flashFlood(a, { rainMm: 10, hours: 1, initialLoss: 15, contLoss: 2.5 });
  assert.equal(r.summary.excessMm, 0);
  assert.equal(r.summary.creekKm2, 0);
});

test('flash flood: ponds fill dips only up to the runoff draining into them', () => {
  // a bowl draining to the edge, with a dip in the middle
  const Wd = 41, Hd = 41, demB = new Float32Array(Wd * Hd);
  for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
    const r = Math.hypot(x - 20, y - 20);
    demB[y * Wd + x] = 10 + 0.05 * r + (r < 4 ? -1 + r * 0.1 : 0);
  }
  const b = F.analyse({ W: Wd, H: Hd, cell: 10, dem: demB }, { streamAreaKm2: 100 });
  const light = F.flashFlood(b, { rainMm: 20, hours: 1, initialLoss: 0, contLoss: 0 });
  const heavy = F.flashFlood(b, { rainMm: 200, hours: 1, initialLoss: 0, contLoss: 0 });
  const centre = 20 * Wd + 20;
  assert.ok(light.depth[centre] > 0 && light.depth[centre] < heavy.depth[centre] + 1e-9, 'deeper pond with more rain');
  assert.ok(heavy.summary.pondKm2 > 0);
});

// a valley draining east: channel along row 10, floodplain rising 0.2 m a row
function valley() {
  const W = 60, H = 21, dem = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) dem[y * W + x] = 2 + 0.01 * (W - x) + Math.abs(y - 10) * 0.2;
  return { W, H, cell: 10, dem };
}

test('a levee keeps a flood out until it is overtopped, and lets it in when it fails', () => {
  const g = valley(), W = g.W;
  const levee = (extra) => Object.assign({ cells: F.lineCells([[0, 13], [59, 13]], W, g.H), height: null }, extra);
  const run = (grid, level) => {
    const a = F.analyse(grid, { streamAreaKm2: 0.001 });
    // gauge near the outlet; upstream of it the river is level with it
    const gauge = 10 * W + 55;
    const mask = new Uint8Array(grid.W * grid.H);
    F.lineCells([[0, 13], [59, 13]], grid.W, grid.H).forEach((c) => { mask[c] = 1; });
    return F.inundate(a, { gauge, gaugeLevel: valley().dem[gauge] + level, bayLevel: 0, upstreamGradient: 0, levee: mask });
  };
  const behind = 15 * W + 30;
  assert.equal(run(g, 1.5).wet[behind], 1, 'floods without a levee');
  const high = F.burnDefences(g, { levees: [levee({ height: 3 })] });
  assert.equal(run(high, 1.5).wet[behind], 0, 'a 3 m levee keeps it dry');
  const failed = F.burnDefences(g, { levees: [levee({ height: 3, failed: true })] });
  assert.equal(run(failed, 1.5).wet[behind], 1, 'floods again when the levee fails');
  const breached = F.burnDefences(g, { levees: [levee({ height: 3, breaches: [13 * W + 30] })] });
  assert.equal(run(breached, 1.5).wet[behind], 1, 'floods through a breach');
  const low = F.burnDefences(g, { levees: [levee({ height: 0.3 })] });
  assert.equal(run(low, 1.5).wet[behind], 1, 'a low levee is overtopped');
  assert.equal(g.dem[13 * W + 30], valley().dem[13 * W + 30], 'the original terrain is untouched');
});

test('a closed flood gate stops the river level passing up the channel', () => {
  const g = valley(), W = g.W;
  const a = F.analyse(g, { streamAreaKm2: 0.001 });
  const gauge = 10 * W + 20, up = 10 * W + 5, gateCell = 10 * W + 10;
  const s = { gauge, gaugeLevel: g.dem[gauge] + 1, bayLevel: 0, upstreamGradient: 0 };
  const open = F.streamSurface(a, s);
  const shut = F.streamSurface(a, Object.assign({}, s, { gates: [gateCell] }));
  assert.ok(open.wse[up] > g.dem[up] + 0.5, 'without a gate the level carries upstream');
  assert.ok(Math.abs(shut.wse[up] - g.dem[up]) < 1e-6, 'behind a closed gate the channel stays at its bed');
});
