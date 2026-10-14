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
