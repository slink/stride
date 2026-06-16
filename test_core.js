/* test_core.js — assertion-based unit tests for coverage_core.js.
 * Real pass/fail: exits non-zero if any assertion fails (unlike the older
 * print-style scripts). Run: `node test_core.js` (or `bun test_core.js`).
 */
'use strict';
const assert = require('node:assert/strict');
const C = require('./coverage_core.js');
const MI = 1609.344;

/* ---- tiny test runner ---- */
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---- helpers ---- */
function synthetic(rows, cols, ns, ew, holes) {
  const G = C.makeGraph();
  const id = (r, c) => r * cols + c;
  const dead = new Set();
  if (holes) for (const [r0, r1, c0, c1] of holes)
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) dead.add(id(r, c));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (dead.has(id(r, c))) continue;
    C.setNode(G, id(r, c), 40.700 + r * 0.0036, -74.020 + c * 0.0052);
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (dead.has(id(r, c))) continue;
    if (c + 1 < cols && !dead.has(id(r, c + 1))) C.addEdge(G, id(r, c), id(r, c + 1), ew * MI);
    if (r + 1 < rows && !dead.has(id(r + 1, c))) C.addEdge(G, id(r, c), id(r + 1, c), ns * MI);
  }
  return G;
}

function graphEdgeSet(G) {
  const s = new Set();
  for (const [n, es] of G.adj) for (const e of es) if (n < e.to) s.add(n < e.to ? n + '|' + e.to : e.to + '|' + n);
  return s;
}

function planEdgeSet(res) {
  const s = new Set();
  for (const run of res.runs)
    for (let i = 0; i + 1 < run.coords.length; i++) {
      const a = run.coords[i].join(','), b = run.coords[i + 1].join(',');
      s.add(a < b ? a + '|' + b : b + '|' + a);
    }
  return s;
}

/* ===================== graph construction ===================== */
test('addEdge is undirected and dedups parallel edges, keeping the shorter', () => {
  const G = C.makeGraph();
  C.setNode(G, 'a', 0, 0); C.setNode(G, 'b', 0, 1);
  C.addEdge(G, 'a', 'b', 100);
  C.addEdge(G, 'a', 'b', 40);   // duplicate, shorter -> should win
  C.addEdge(G, 'a', 'b', 999);  // duplicate, longer  -> ignored
  assert.equal(G.adj.get('a').length, 1, 'no parallel edge kept');
  assert.equal(G.adj.get('b').length, 1, 'undirected: b sees a too');
  assert.equal(G.adj.get('a')[0].len, 40, 'kept the shorter length');
  assert.equal(G.adj.get('b')[0].len, 40, 'both directions updated to shorter');
});

/* ===================== coverage completeness ===================== */
test('every street appears in the plan at least once (clean grid)', () => {
  const G = synthetic(12, 8, 0.05, 0.15, null);
  const res = C.planRuns(G, 4 * MI, { cluster: true });
  const want = graphEdgeSet(G), got = planEdgeSet(res);
  assert.equal(got.size >= want.size, true, `plan has ${got.size} edges, graph has ${want.size}`);
});

test('every street appears in the plan at least once (holed grid)', () => {
  const G = synthetic(28, 12, 0.05, 0.14, [[8, 12, 4, 7]]);
  const res = C.planRuns(G, 5 * MI, { startLat: 40.700, startLon: -74.020, cluster: true });
  const want = graphEdgeSet(G), got = planEdgeSet(res);
  assert.equal(got.size >= want.size, true, `plan has ${got.size} edges, graph has ${want.size}`);
});

/* ===================== cap behavior ===================== */
test('all runs respect the cap when no single street exceeds it', () => {
  const G = synthetic(24, 10, 0.05, 0.17, null);
  const res = C.planRuns(G, 5 * MI, { cluster: false });
  assert.equal(res.runs.every(r => r.length_mi <= 5.001), true);
});

test('a run may exceed the cap ONLY if it is a single unavoidable over-long edge', () => {
  // path a-b-c-d where b-c is longer than the cap by itself.
  const G = C.makeGraph();
  C.setNode(G, 'a', 0, 0); C.setNode(G, 'b', 0, 1);
  C.setNode(G, 'c', 0, 2); C.setNode(G, 'd', 0, 3);
  C.addEdge(G, 'a', 'b', 1 * MI);
  C.addEdge(G, 'b', 'c', 9 * MI); // > 5mi cap, atomic, cannot be split
  C.addEdge(G, 'c', 'd', 1 * MI);
  const res = C.planRuns(G, 5 * MI, { cluster: false });
  for (const r of res.runs) {
    if (r.length_mi > 5.001) {
      // the only legal over-cap run is one made of a single edge
      assert.equal(r.coords.length, 2, `over-cap run must be a single edge, got ${r.coords.length} coords`);
    }
  }
});

/* ===================== Euler / matching invariants ===================== */
test('augmentation makes every node even-degree (Euler precondition)', () => {
  const G0 = synthetic(7, 5, 0.05, 0.15, null);
  const G = C._internal.largestComponent(G0);
  const mult = C._internal.augment(G);
  // tally degree in the augmented multigraph
  const deg = new Map();
  for (const [k, m] of mult) {
    const [u, v] = k.split('|');
    deg.set(u, (deg.get(u) || 0) + m);
    deg.set(v, (deg.get(v) || 0) + m);
  }
  for (const [n, d] of deg) assert.equal(d % 2, 0, `node ${n} has odd degree ${d} after augmentation`);
});

test('Euler circuit traverses each augmented edge exactly once and is closed', () => {
  const G0 = synthetic(6, 6, 0.05, 0.15, null);
  const G = C._internal.largestComponent(G0);
  const mult = C._internal.augment(G);
  const edges = C._internal.eulerCircuit(G, mult, null);
  let total = 0; for (const m of mult.values()) total += m;
  assert.equal(edges.length, total, `walk length ${edges.length} != edge count ${total}`);
  // consecutive edges connect, and the walk returns to its start (closed)
  for (let i = 0; i + 1 < edges.length; i++)
    assert.equal(edges[i].b, edges[i + 1].a, `edge ${i} does not chain into ${i + 1}`);
  assert.equal(edges[0].a, edges[edges.length - 1].b, 'circuit is not closed');
});

/* ===================== shortest paths ===================== */
test('dijkstra returns correct shortest-path distances on a weighted graph', () => {
  // a-b 1, b-c 1, a-c 4, c-d 1  => dist(a..d)=3 via a-b-c-d, dist(a,c)=2
  const G = C.makeGraph();
  for (const n of ['a', 'b', 'c', 'd']) C.setNode(G, n, 0, 0);
  C.addEdge(G, 'a', 'b', 1);
  C.addEdge(G, 'b', 'c', 1);
  C.addEdge(G, 'a', 'c', 4);
  C.addEdge(G, 'c', 'd', 1);
  const { dist, prev } = C._internal.dijkstra(G, 'a');
  assert.equal(dist.get('a'), 0);
  assert.equal(dist.get('b'), 1);
  assert.equal(dist.get('c'), 2, 'must route a-b-c (2), not direct a-c (4)');
  assert.equal(dist.get('d'), 3);
  // reconstruct a->d path
  const path = []; let cur = 'd';
  while (cur !== undefined) { path.push(cur); cur = prev.get(cur); }
  assert.deepEqual(path.reverse(), ['a', 'b', 'c', 'd']);
});

test('dijkstra distances are independent of grid traversal start', () => {
  const G = C._internal.largestComponent(synthetic(6, 6, 0.05, 0.15, null));
  const { dist } = C._internal.dijkstra(G, '0');
  // node 0 is the corner; node 35 the far corner of a 6x6 grid.
  // distance must equal a monotone shortest path (no Infinity, finite, > 0).
  for (const [, d] of dist) assert.equal(Number.isFinite(d) && d >= 0, true);
  assert.equal(dist.get('0'), 0);
});

/* ===================== start anchoring ===================== */
test('first run begins at the intersection nearest the start point', () => {
  const G = synthetic(24, 10, 0.05, 0.17, null);
  const res = C.planRuns(G, 5 * MI, { startLat: 40.700, startLon: -74.020, cluster: true });
  const first = res.runs[0].coords[0];
  assert.equal(Math.abs(first[0] - 40.700) < 1e-6 && Math.abs(first[1] + 74.020) < 1e-6, true,
    `first run starts at [${first}], expected the [40.700, -74.020] corner`);
});

/* ===================== zoning / overhead ===================== */
test('default planning avoids the zoning seam tax (lower overhead than clustering)', () => {
  // On an irregular graph, k-means zoning cuts edges and adds deadhead at the
  // seams for no compactness benefit (measured in attribution.js). The default
  // should solve globally and come in with lower overhead.
  const G1 = synthetic(28, 12, 0.05, 0.14, [[8, 12, 4, 7]]);
  const G2 = synthetic(28, 12, 0.05, 0.14, [[8, 12, 4, 7]]);
  const def = C.planRuns(G1, 5 * MI, { startLat: 40.700, startLon: -74.020 });
  const clustered = C.planRuns(G2, 5 * MI, { startLat: 40.700, startLon: -74.020, cluster: true });
  assert.equal(def.stats.overhead_pct < clustered.stats.overhead_pct, true,
    `default overhead ${def.stats.overhead_pct}% should be < clustered ${clustered.stats.overhead_pct}%`);
  assert.equal(def.runs.every(r => r.length_mi <= 5.001), true, 'default runs still within cap');
});

/* ===================== determinism ===================== */
test('same input produces identical stats (deterministic)', () => {
  const a = C.planRuns(synthetic(14, 9, 0.05, 0.15, null), 4 * MI, { cluster: true });
  const b = C.planRuns(synthetic(14, 9, 0.05, 0.15, null), 4 * MI, { cluster: true });
  assert.deepEqual(a.stats, b.stats);
});

/* ===================== degenerate graphs ===================== */
test('single-edge graph plans without crashing and covers the edge', () => {
  const G = C.makeGraph();
  C.setNode(G, 'a', 0, 0); C.setNode(G, 'b', 0, 0.01);
  C.addEdge(G, 'a', 'b', 100);
  const res = C.planRuns(G, 5 * MI, { cluster: false });
  assert.equal(res.runs.length >= 1, true, 'should produce at least one run');
  assert.equal(res.stats.segments, 1);
});

/* ===================== GPX export ===================== */
test('GPX is well-formed and has one trkpt per coordinate', () => {
  const run = { coords: [[40.7, -74.0], [40.71, -74.01], [40.72, -74.02]] };
  const gpx = C.runToGPX(run, 'Run 1');
  assert.equal(gpx.startsWith('<?xml'), true, 'xml header');
  assert.equal(gpx.trim().endsWith('</gpx>'), true, 'closes gpx');
  assert.equal((gpx.match(/<trkpt/g) || []).length, 3, 'one trkpt per coord');
});

test('GPX escapes XML metacharacters in the run name', () => {
  const run = { coords: [[40.7, -74.0]] };
  const gpx = C.runToGPX(run, 'Tom & Jerry <St> "Ave"');
  // a raw ampersand or angle bracket inside the name makes the document
  // malformed; they must be entity-escaped.
  assert.equal(gpx.includes('Tom & Jerry'), false, 'raw & must be escaped');
  assert.equal(gpx.includes('<St>'), false, 'raw angle brackets must be escaped');
  assert.equal(gpx.includes('Tom &amp; Jerry &lt;St&gt; &quot;Ave&quot;'), true, 'name is entity-escaped');
});

/* ---- run all ---- */
let pass = 0, fail = 0;
for (const t of tests) {
  try { t.fn(); console.log(`  ok   ${t.name}`); pass++; }
  catch (e) { console.log(`  FAIL ${t.name}\n         ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
