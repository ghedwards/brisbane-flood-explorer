const test = require('node:test');
const assert = require('node:assert/strict');
const {prepare, cell, expand} = require('../viewer/inertial-grid.js');
test('2D coarsening preserves walls and bounds, and reports the actual resolution', () => {
  const a={W:7,H:6,cell:10,dem:new Float32Array(42).fill(2),valid:new Uint8Array(42).fill(1)};
  a.valid[0]=0;
  const g=prepare(a,4);
  assert.equal(g.factor,2);assert.equal(g.cell,20);assert.equal(g.W,3);assert.equal(g.H,3);
  assert.equal(g.valid[0],0);assert.equal(g.valid[1],1);
  assert.equal(cell(g,a,6),-1);assert.equal(cell(g,a,-1),-1);
  const r=expand(a,g,{depth:new Float64Array(9).fill(0.2)});
  assert.equal(r.wet[0],0);assert.equal(r.wet[1],0);assert.equal(r.wet[6],0);
  assert.equal(r.wet[2],1);assert.ok(Math.abs(r.depth[2]-.2)<1e-7);
});
