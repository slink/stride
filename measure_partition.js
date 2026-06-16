/* measure_partition.js — diagnostic: how much of the zoning "seam tax" is
 * recoverable by a connectivity-aware partition vs the current k-means?
 *
 * Measures, on the SAME graphs planRuns would zone (post-contraction), for the
 * same zone count k:
 *   - cut edges      : streets whose endpoints land in different zones (the
 *                      direct driver of boundary odd-nodes -> deadhead)
 *   - solved overhead: actually solve CPP per zone/component and total it
 * for three partitions: global (1 zone, the floor), k-means (current), and a
 * balanced multi-source BFS growth (connectivity-aware prototype).
 *
 * This is a throwaway prototype to decide whether to build the real thing.
 */
'use strict';
const C = require('./coverage_core.js');
const MI = 1609.344;
const { contractDeg2, clusterNodes, allComponents, augment, eulerCircuit } = C._internal;

function city(rows, cols, holes, diagEvery) {
  const G = C.makeGraph(); const id = (r, c) => r * cols + c; const dead = new Set();
  for (const [r0, r1, c0, c1] of holes || []) for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) dead.add(id(r, c));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (!dead.has(id(r, c))) C.setNode(G, id(r, c), 40.70 + r * 0.0036, -74.02 + c * 0.0052);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (dead.has(id(r, c))) continue;
    if (c + 1 < cols && !dead.has(id(r, c + 1))) C.addEdge(G, id(r, c), id(r, c + 1), 0.15 * MI);
    if (r + 1 < rows && !dead.has(id(r + 1, c))) C.addEdge(G, id(r, c), id(r + 1, c), 0.05 * MI);
    if (diagEvery && (r + c) % diagEvery === 0 && r + 1 < rows && c + 1 < cols && !dead.has(id(r + 1, c + 1))) C.addEdge(G, id(r, c), id(r + 1, c + 1), 0.158 * MI);
  }
  return G;
}

const bareLen = G => { let m = 0; for (const [n, es] of G.adj) for (const e of es) if (n < e.to) m += e.len; return m; };

/* same seeds k-means uses (lon-sorted, evenly spaced) so we isolate the
 * growth-vs-centroid effect, not the seeding. */
function seeds(G, k) {
  const ids = [...G.nodes.keys()].sort((a, b) => G.nodes.get(a).lon - G.nodes.get(b).lon);
  const s = []; for (let i = 0; i < k; i++) s.push(ids[Math.floor(i * (ids.length - 1) / (k - 1))]);
  return s;
}

/* graph-Voronoi: simultaneous multi-source BFS from spread seeds, first wave to
 * reach a node claims it. Compact regions, boundaries along equidistant seams. */
function bfsPartition(G, k) {
  if (k <= 1) { const a = new Map(); for (const n of G.nodes.keys()) a.set(n, 0); return a; }
  const sd = seeds(G, k);
  const assign = new Map(); let frontier = [];
  sd.forEach((s, i) => { if (!assign.has(s)) { assign.set(s, i); frontier.push(s); } });
  while (frontier.length) {
    const next = [];
    for (const n of frontier) { const z = assign.get(n);
      for (const e of G.adj.get(n)) if (!assign.has(e.to)) { assign.set(e.to, z); next.push(e.to); } }
    frontier = next;
  }
  for (const n of G.nodes.keys()) if (!assign.has(n)) {  // unreached (separate component)
    const p = G.nodes.get(n); let bi = 0, bd = Infinity;
    for (let i = 0; i < k; i++) { const sp = G.nodes.get(sd[i]); const d = (p.lat - sp.lat) ** 2 + (p.lon - sp.lon) ** 2; if (d < bd) { bd = d; bi = i; } }
    assign.set(n, bi);
  }
  return assign;
}

const cutEdges = (G, assign) => { let c = 0; for (const [n, es] of G.adj) for (const e of es) if (n < e.to && assign.get(n) !== assign.get(e.to)) c++; return c; };

/* greedy local min-cut refinement: move each node to the neighbor zone that
 * minimizes its cut contribution; iterate to a local optimum. Bounds how low
 * cut-edge count can go for THIS k -> how much any partitioner could recover. */
function refineMinCut(G, assign0) {
  const assign = new Map(assign0);
  let improved = true, guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (const n of G.nodes.keys()) {
      const cur = assign.get(n); const cnt = new Map();
      for (const e of G.adj.get(n)) cnt.set(assign.get(e.to), (cnt.get(assign.get(e.to)) || 0) + 1);
      let bestZ = cur, bestSame = cnt.get(cur) || 0;
      for (const [z, same] of cnt) if (same > bestSame) { bestSame = same; bestZ = z; }
      if (bestZ !== cur) { assign.set(n, bestZ); improved = true; }
    }
  }
  return assign;
}

/* replicate planRuns' per-zone, per-component CPP solve; return covered meters */
function solveCovered(G, assign) {
  const zoneEdges = new Map(), zoneNodeSet = new Map();
  for (const [n, es] of G.adj) for (const e of es) if (n < e.to) {
    const z = assign.get(n);
    if (!zoneEdges.has(z)) { zoneEdges.set(z, []); zoneNodeSet.set(z, new Set()); }
    zoneEdges.get(z).push([n, e.to, e.len]); zoneNodeSet.get(z).add(n); zoneNodeSet.get(z).add(e.to);
  }
  let covered = 0;
  for (const z of zoneEdges.keys()) {
    const sub = C.makeGraph();
    for (const n of zoneNodeSet.get(z)) sub.nodes.set(n, G.nodes.get(n));
    for (const [u, v, len] of zoneEdges.get(z)) C.addEdge(sub, u, v, len);
    for (const comp of allComponents(sub)) {
      if (comp.adj.size === 0) continue;
      const edges = eulerCircuit(comp, augment(comp), null);
      for (const e of edges) covered += e.len;
    }
  }
  return covered;
}

function row(label, cuts, covered, bare) {
  const oh = 100 * (covered - bare) / bare;
  console.log(`  ${label.padEnd(18)} cuts=${String(cuts).padStart(4)}   overhead=+${oh.toFixed(1)}%`);
  return oh;
}

const scenarios = [
  ['holed 28x12', city(28, 12, [[8, 12, 4, 7]], 0)],
  ['irregular 30x16', city(30, 16, [[6, 10, 3, 6], [18, 24, 9, 13]], 5)],
  ['dense 40x24', city(40, 24, [[10, 16, 5, 9], [22, 30, 14, 19], [5, 8, 18, 22]], 4)],
];
const maxMeters = 5 * MI;
let sumCeiling = 0, sumRecovered = 0;
for (const [name, G0] of scenarios) {
  const { graph: G } = contractDeg2(C._internal.largestComponent(G0), { maxMeters });
  const bare = bareLen(G);
  const k = Math.max(2, Math.round(bare / (maxMeters * 6)));
  console.log(`\n== ${name} ==  (k=${k} zones, ${G.nodes.size} junctions, bare=${(bare / MI).toFixed(1)}mi)`);
  const ohGlobal = row('global (1 zone)', 0, solveCovered(G, new Map([...G.nodes.keys()].map(n => [n, 0]))), bare);
  const km = clusterNodes(G, k).assign;
  const ohKM = row('k-means', cutEdges(G, km), solveCovered(G, km), bare);
  const bfs = bfsPartition(G, k);
  const ohBFS = row('bfs-grown', cutEdges(G, bfs), solveCovered(G, bfs), bare);
  const refined = refineMinCut(G, km);
  const ohRef = row('k-means+mincut', cutEdges(G, refined), solveCovered(G, refined), bare);
  const ceiling = ohKM - ohGlobal, recovered = ohKM - Math.min(ohBFS, ohRef);
  console.log(`  -> seam tax (k-means vs global) = +${ceiling.toFixed(1)}%;  bfs recovers ${recovered.toFixed(1)} of it (${(100 * recovered / ceiling).toFixed(0)}%)`);
  sumCeiling += ceiling; sumRecovered += recovered;
}
console.log(`\n=== AVERAGE: seam tax=+${(sumCeiling / scenarios.length).toFixed(1)}%, bfs recovers ${(sumRecovered / scenarios.length).toFixed(1)}% (${(100 * sumRecovered / sumCeiling).toFixed(0)}% of ceiling) ===`);
