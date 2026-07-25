/* test_overpass.js — assertion tests for Overpass-JSON -> graph parsing.
 * Mirrors the worker's graphFromOverpass (the worker uses importScripts, so
 * the parser is replicated here). Run: `node test_overpass.js`.
 */
'use strict';
const assert = require('node:assert/strict');
const C = require('../coverage_core.js');
const MI = 1609.344;

function graphFromOverpass(data) {
  const G = C.makeGraph();
  const nodeLL = new Map();
  for (const el of data.elements) if (el.type === 'node') nodeLL.set(el.id, [el.lat, el.lon]);
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.nodes) continue;
    for (let i = 0; i + 1 < el.nodes.length; i++) {
      const a = el.nodes[i], b = el.nodes[i + 1];
      const pa = nodeLL.get(a), pb = nodeLL.get(b);
      if (!pa || !pb) continue;
      C.setNode(G, a, pa[0], pa[1]); C.setNode(G, b, pb[0], pb[1]);
      const len = C.haversine(pa[0], pa[1], pb[0], pb[1]);
      if (len > 0) C.addEdge(G, a, b, len);
    }
  }
  return G;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('parses a 3x3 grid: shared nodes across ways -> 9 nodes, 12 edges', () => {
  const elements = []; let nid = 1; const idg = {};
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    idg[r + ',' + c] = nid;
    elements.push({ type: 'node', id: nid, lat: 40.70 + r * 0.003, lon: -74.02 + c * 0.004 });
    nid++;
  }
  let wid = 1000;
  for (let r = 0; r < 3; r++) elements.push({ type: 'way', id: wid++, nodes: [idg[r + ',0'], idg[r + ',1'], idg[r + ',2']] });
  for (let c = 0; c < 3; c++) elements.push({ type: 'way', id: wid++, nodes: [idg['0,' + c], idg['1,' + c], idg['2,' + c]] });

  const G = graphFromOverpass({ elements });
  let edges = 0; for (const [n, es] of G.adj) for (const e of es) if (n < e.to) edges++;
  assert.equal(G.nodes.size, 9, 'nodes');
  assert.equal(edges, 12, 'edges');

  const res = C.planRuns(G, 2 * MI, { startLat: 40.70, startLon: -74.02, cluster: true });
  assert.equal(res.runs.every(r => r.length_mi <= 2.001), true, 'all runs within cap');
  assert.equal(C.runToGPX(res.runs[0], 'R1').startsWith('<?xml'), true, 'gpx header');
});

test('ways referencing missing nodes are skipped, not crashed on', () => {
  const elements = [
    { type: 'node', id: 1, lat: 40.70, lon: -74.02 },
    { type: 'node', id: 2, lat: 40.71, lon: -74.02 },
    { type: 'way', id: 100, nodes: [1, 2, 999] }, // 999 has no node element
  ];
  const G = graphFromOverpass({ elements });
  let edges = 0; for (const [n, es] of G.adj) for (const e of es) if (n < e.to) edges++;
  assert.equal(edges, 1, 'only the 1-2 edge is built; the dangling 2-999 is dropped');
});

let pass = 0, fail = 0;
for (const t of tests) {
  try { t.fn(); console.log(`  ok   ${t.name}`); pass++; }
  catch (e) { console.log(`  FAIL ${t.name}\n         ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
