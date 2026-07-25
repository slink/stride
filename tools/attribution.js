/* attribution.js — measure WHERE the route overhead comes from, so we optimize
 * the dominant source instead of guessing. Not a test; a diagnostic.
 *
 * Two sources of overhead (covered_mi - bare_mi):
 *   1. matching   — greedy odd-node matching vs optimal (what Blossom fixes)
 *   2. seams      — zoning/partitioning fragments the graph, creating extra
 *                   odd nodes at zone boundaries (what Blossom does NOT fix)
 *
 * Matching upside is bounded below by a 2-opt local search on the greedy
 * matching: any improvement 2-opt finds, optimal (Blossom) finds at least as
 * much. If 2-opt barely helps, Blossom won't either.
 */
'use strict';
const C = require('../coverage_core.js');
const MI = 1609.344;
const { dijkstra, largestComponent } = C._internal;

/* irregular graph: grid + holes + a few diagonals -> non-trivial odd set */
function city(rows, cols, holes, diagEvery) {
  const G = C.makeGraph();
  const id = (r, c) => r * cols + c;
  const dead = new Set();
  for (const [r0, r1, c0, c1] of holes || [])
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) dead.add(id(r, c));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++)
    if (!dead.has(id(r, c))) C.setNode(G, id(r, c), 40.70 + r * 0.0036, -74.02 + c * 0.0052);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (dead.has(id(r, c))) continue;
    if (c + 1 < cols && !dead.has(id(r, c + 1))) C.addEdge(G, id(r, c), id(r, c + 1), 0.15 * MI);
    if (r + 1 < rows && !dead.has(id(r + 1, c))) C.addEdge(G, id(r, c), id(r + 1, c), 0.05 * MI);
    // sparse diagonals to break the perfectly-even grid parity
    if (diagEvery && (r + c) % diagEvery === 0 && r + 1 < rows && c + 1 < cols &&
        !dead.has(id(r + 1, c + 1)))
      C.addEdge(G, id(r, c), id(r + 1, c + 1), 0.158 * MI);
  }
  return G;
}

/* pairwise shortest-path distances among the odd nodes */
function oddDistances(G) {
  const odd = [...G.adj.keys()].filter(n => G.adj.get(n).length % 2 === 1);
  const D = new Map();
  for (const u of odd) {
    const { dist } = dijkstra(G, u);
    const row = new Map();
    for (const v of odd) if (v !== u) row.set(v, dist.get(v) ?? Infinity);
    D.set(u, row);
  }
  return { odd, D };
}

/* greedy matching exactly as augment() does it: first unmatched -> nearest */
function greedyMatch(odd, D) {
  const unmatched = new Set(odd), pairs = [];
  while (unmatched.size > 1) {
    const u = unmatched.values().next().value; unmatched.delete(u);
    let best = null, bd = Infinity;
    for (const v of unmatched) { const d = D.get(u).get(v); if (d < bd) { bd = d; best = v; } }
    if (best === null) break;
    unmatched.delete(best); pairs.push([u, best, bd]);
  }
  return pairs;
}

const cost = pairs => pairs.reduce((s, p) => s + p[2], 0);

/* 2-opt local search: swap two pairs if it lowers total weight. The result is
 * a lower bound on how much an optimal (Blossom) matching would save. */
function twoOpt(pairs, D) {
  pairs = pairs.map(p => p.slice());
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
      const [a, b] = pairs[i], [c, d] = pairs[j];
      const cur = D.get(a).get(b) + D.get(c).get(d);
      const swap1 = D.get(a).get(c) + D.get(b).get(d);
      const swap2 = D.get(a).get(d) + D.get(b).get(c);
      if (swap1 < cur - 1e-6 && swap1 <= swap2) { pairs[i] = [a, c, D.get(a).get(c)]; pairs[j] = [b, d, D.get(b).get(d)]; improved = true; }
      else if (swap2 < cur - 1e-6) { pairs[i] = [a, d, D.get(a).get(d)]; pairs[j] = [b, c, D.get(b).get(c)]; improved = true; }
    }
  }
  return pairs;
}

function bareLen(G) {
  let m = 0; for (const [n, es] of G.adj) for (const e of es) if (n < e.to) m += e.len; return m;
}

function analyze(name, G) {
  G = largestComponent(G);
  const bare = bareLen(G);
  const unclustered = C.planRuns(G, 5 * MI, { cluster: false });
  // rebuild (planRuns mutates via largestComponent internally but not G here)
  const clustered = C.planRuns(G, 5 * MI, { startLat: 40.70, startLon: -74.02, cluster: true });

  const { odd, D } = oddDistances(G);
  const greedy = greedyMatch(odd, D);
  const opt = twoOpt(greedy, D);
  const gGreedy = cost(greedy), gOpt = cost(opt);

  const ohUnclustered = 100 * (unclustered.stats.covered_mi - bare / MI) / (bare / MI);
  const seamCost = clustered.stats.overhead_pct - ohUnclustered; // pct of bare added by zoning
  const matchGapPct = 100 * (gGreedy - gOpt) / bare;             // pct of bare recoverable by better matching (lower bound)

  console.log(`\n== ${name} ==`);
  console.log(`  nodes=${G.nodes.size} odd=${odd.length} bare=${(bare/MI).toFixed(1)}mi`);
  console.log(`  overhead: unclustered=+${ohUnclustered.toFixed(1)}%  clustered=+${clustered.stats.overhead_pct}%`);
  console.log(`  SEAM cost (zoning adds)        : +${seamCost.toFixed(1)}% of bare`);
  console.log(`  MATCHING gap (Blossom ceiling) : +${matchGapPct.toFixed(1)}% of bare  (>= this is what optimal matching saves)`);
  console.log(`     greedy match=${(gGreedy/MI).toFixed(2)}mi  2-opt=${(gOpt/MI).toFixed(2)}mi  (${(100*(gGreedy-gOpt)/gGreedy).toFixed(1)}% shorter matching)`);
  return { seamCost, matchGapPct };
}

const scenarios = [
  ['clean grid 24x10',        city(24, 10, null, 0)],
  ['holed grid 28x12',        city(28, 12, [[8, 12, 4, 7]], 0)],
  ['irregular w/ diagonals',  city(30, 16, [[6, 10, 3, 6], [18, 24, 9, 13]], 5)],
  ['dense irregular',         city(40, 24, [[10, 16, 5, 9], [22, 30, 14, 19], [5, 8, 18, 22]], 4)],
];
const rs = scenarios.map(([n, g]) => analyze(n, g));
const avgSeam = rs.reduce((s, r) => s + r.seamCost, 0) / rs.length;
const avgGap = rs.reduce((s, r) => s + r.matchGapPct, 0) / rs.length;
console.log(`\n=== AVERAGE: seam=+${avgSeam.toFixed(1)}%  matching-gap(>=)=+${avgGap.toFixed(1)}% ===`);
console.log(avgSeam > 2 * avgGap ? '>> SEAMS dominate: fix splitRuns/zoning first.'
  : avgGap > 2 * avgSeam ? '>> MATCHING dominates: Blossom first.'
  : '>> comparable: pick by implementation cost.');
