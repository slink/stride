/* coverage_core.js — street-coverage solver (Capacitated Arc Routing heuristic).
 * Pure JS, no dependencies. Runs in a Web Worker and in Node (for tests).
 *
 * Graph format:
 *   nodes: Map<id, {lat, lon}>
 *   adj:   Map<id, Array<{to, len}>>   (undirected: both directions present)
 *
 * Pipeline: greedy odd-node matching (Chinese Postman augmentation) ->
 *           Hierholzer Euler circuit -> split into runs <= maxMeters,
 *           with optional k-means zone clustering and start anchoring.
 */
'use strict';

const R_EARTH = 6371000;
function haversine(aLat, aLon, bLat, bLon) {
  const p1 = aLat * Math.PI / 180, p2 = bLat * Math.PI / 180;
  const dp = (bLat - aLat) * Math.PI / 180, dl = (bLon - aLon) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

/* ---- graph helpers ---- */
function makeGraph() { return { nodes: new Map(), adj: new Map() }; }

function setNode(G, id, lat, lon, ele) { G.nodes.set(String(id), { lat, lon, ele }); }

function addEdge(G, u, v, len) {
  u = String(u); v = String(v);
  if (!G.adj.has(u)) G.adj.set(u, []);
  if (!G.adj.has(v)) G.adj.set(v, []);
  // skip duplicate parallel edges; keep shortest
  const eu = G.adj.get(u).find(e => e.to === v);
  if (eu) { if (len < eu.len) { eu.len = len; G.adj.get(v).find(e => e.to === u).len = len; } return; }
  G.adj.get(u).push({ to: v, len });
  G.adj.get(v).push({ to: u, len });
}

function degree(G, n) { return G.adj.get(n).length; }

function nearestNode(G, lat, lon) {
  let best = null, bd = Infinity;
  for (const [id, p] of G.nodes) {
    const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

/* largest connected component */
function largestComponent(G) {
  const seen = new Set(); let bestComp = [];
  for (const start of G.adj.keys()) {
    if (seen.has(start)) continue;
    const stack = [start], comp = [];
    seen.add(start);
    while (stack.length) {
      const n = stack.pop(); comp.push(n);
      for (const e of G.adj.get(n)) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    }
    if (comp.length > bestComp.length) bestComp = comp;
  }
  const H = makeGraph();
  const keep = new Set(bestComp);
  for (const n of bestComp) H.nodes.set(n, G.nodes.get(n));
  for (const n of bestComp)
    for (const e of G.adj.get(n))
      if (keep.has(e.to) && n < e.to) addEdge(H, n, e.to, e.len);
  return H;
}

/* every connected component as its own graph */
function allComponents(G) {
  const seen = new Set(); const out = [];
  for (const start of G.adj.keys()) {
    if (seen.has(start)) continue;
    const stack = [start], comp = []; seen.add(start);
    while (stack.length) {
      const n = stack.pop(); comp.push(n);
      for (const e of G.adj.get(n)) if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    }
    const H = makeGraph(); const keep = new Set(comp);
    for (const n of comp) H.nodes.set(n, G.nodes.get(n));
    for (const n of comp) for (const e of G.adj.get(n)) if (keep.has(e.to) && n < e.to) addEdge(H, n, e.to, e.len);
    out.push(H);
  }
  return out;
}

/* Binary min-heap over parallel key/value arrays.
 *
 * Deliberately allocation-free on the hot path: an earlier version stored
 * [priority, payload] tuples and swapped with array destructuring, which
 * allocates a temporary array per tuple AND per swap. At tens of millions of
 * heap operations per solve that dominated GC time in the browser. Here push
 * takes two scalars and pop leaves its result in .topKey/.topVal, so a full
 * Dijkstra allocates nothing beyond the backing arrays' growth. */
class MinHeap {
  constructor() { this.k = []; this.v = []; this.topKey = 0; this.topVal = null; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      const tk = k[p]; k[p] = k[i]; k[i] = tk;
      const tv = v[p]; v[p] = v[i]; v[i] = tv;
      i = p;
    }
  }
  /* Removes the minimum and leaves it in .topKey / .topVal. */
  pop() {
    const k = this.k, v = this.v;
    this.topKey = k[0]; this.topVal = v[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        const tk = k[m]; k[m] = k[i]; k[i] = tk;
        const tv = v[m]; v[m] = v[i]; v[i] = tv;
        i = m;
      }
    }
  }
}

/* Dijkstra from source, returns {dist, prev} over node ids.
 * Binary heap with lazy deletion: O((V+E) log V), vs the old O(V^2) linear
 * scan. This is the hot path — augment() runs one Dijkstra per odd node. */
function dijkstra(G, src) {
  const dist = new Map(), prev = new Map();
  dist.set(src, 0);
  const pq = new MinHeap();
  pq.push(0, src);
  const done = new Set();
  while (pq.size) {
    pq.pop();
    const d = pq.topKey, u = pq.topVal;
    if (done.has(u)) continue;   // stale entry (lazy deletion)
    done.add(u);
    for (const e of G.adj.get(u)) {
      const nd = d + e.len;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd); prev.set(e.to, u); pq.push(nd, e.to);
      }
    }
  }
  return { dist, prev };
}

/* Dijkstra that STOPS at the first target it settles.
 *
 * Dijkstra settles nodes in nondecreasing distance order, so the first settled
 * target is a nearest one — the same partner the old code found by running to
 * completion and then scanning every unmatched odd node's distance. Measured on
 * real OSM data, the nearest unmatched odd node is ~17 settled nodes away while
 * the graph has ~14k, so the full search was doing ~800x more work than needed.
 *
 * Exact distance ties may resolve to a different (equidistant) partner than the
 * old scan picked; the matching cost is unchanged, which is what the plan
 * depends on. */
function dijkstraNearest(G, src, targets) {
  const dist = new Map(), prev = new Map();
  dist.set(src, 0);
  const pq = new MinHeap();
  pq.push(0, src);
  const done = new Set();
  while (pq.size) {
    pq.pop();
    const d = pq.topKey, u = pq.topVal;
    if (done.has(u)) continue;
    done.add(u);
    if (targets.has(u)) return { best: u, prev };
    for (const e of G.adj.get(u)) {
      const nd = d + e.len;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd); prev.set(e.to, u); pq.push(nd, e.to);
      }
    }
  }
  return { best: null, prev };
}

function pathBetween(prev, src, dst) {
  const path = [dst]; let cur = dst;
  while (cur !== src) { cur = prev.get(cur); if (cur === undefined) return null; path.push(cur); }
  return path.reverse();
}

/* Dijkstra that stops as soon as it has SETTLED `k` nodes satisfying isTarget.
 * On real OSM street graphs 50-70% of contracted nodes are odd, so a node's k
 * nearest odd partners sit a few hops away: this settles a small ball instead
 * of the whole graph, and is far cheaper than the full Dijkstra the old greedy
 * ran per matched pair. Returns [[id, dist], ...] in increasing distance. */
function dijkstraNearestK(G, src, isTarget, k) {
  const dist = new Map([[src, 0]]);
  const pq = new MinHeap(); pq.push(0, src);
  const done = new Set(); const out = [];
  while (pq.size && out.length < k) {
    pq.pop();
    const d = pq.topKey, u = pq.topVal;
    if (done.has(u)) continue;
    done.add(u);
    if (u !== src && isTarget(u)) out.push([u, d]);
    for (const e of G.adj.get(u)) {
      const nd = d + e.len;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); pq.push(nd, e.to); }
    }
  }
  return out;
}

/* shortest path src->dst, early-exiting once dst is settled */
function dijkstraPath(G, src, dst) {
  if (src === dst) return [src];
  const dist = new Map([[src, 0]]), prev = new Map();
  const pq = new MinHeap(); pq.push(0, src);
  const done = new Set();
  while (pq.size) {
    pq.pop();
    const d = pq.topKey, u = pq.topVal;
    if (done.has(u)) continue;
    done.add(u);
    if (u === dst) break;
    for (const e of G.adj.get(u)) {
      const nd = d + e.len;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, u); pq.push(nd, e.to); }
    }
  }
  return pathBetween(prev, src, dst);
}

/* ---- flat CSR view, for the matching hot path ---- *
 * matchOdd() runs thousands of SMALL, early-terminating searches. Over the
 * Map/Array graph each one pays string hashing, Map allocation and object
 * churn; over a flat CSR it is pointer arithmetic on typed arrays.
 *
 * Node indices follow G.adj insertion order, so anything rebuilt from a CSR
 * keeps the original ordering and the plan is unchanged.
 *
 * Scratch state is reset by EPOCH STAMP rather than by clearing the buffers.
 * That is the whole trick: an O(nodes) fill per search would dwarf a search
 * that settles ~17 nodes out of 14k, which is exactly the regime here. */
function buildCSR(G) {
  const ids = [...G.adj.keys()];
  const n = ids.length;
  const index = new Map();
  for (let i = 0; i < n; i++) index.set(ids[i], i);
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + G.adj.get(ids[i]).length;
  const tgt = new Int32Array(off[n]), alen = new Float64Array(off[n]);
  for (let i = 0; i < n; i++) {
    const es = G.adj.get(ids[i]);
    let p = off[i];
    for (let j = 0; j < es.length; j++, p++) { tgt[p] = index.get(es[j].to); alen[p] = es[j].len; }
  }
  return { ids, index, n, off, tgt, alen };
}

/* Binary min-heap over (float key, int payload) in two flat typed arrays.
 * Sized to arcs+1, a hard bound on live entries, so push never grows. */
class NumHeap {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; this.topKey = 0; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  /* returns the payload; its key is left in .topKey */
  pop() {
    const k = this.k, v = this.v, rv = v[0], rk = k[0], n = --this.n;
    if (n > 0) {
      const lk = k[n], lv = v[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    this.topKey = rk; return rv;
  }
}

function csrWorkspace(csr) {
  return {
    dist: new Float64Array(csr.n),
    prevN: new Int32Array(csr.n),
    seen: new Int32Array(csr.n),    // epoch in which dist[i] was last written
    done: new Int32Array(csr.n),    // epoch in which i was settled
    flag: new Uint8Array(csr.n),
    heap: new NumHeap(csr.off[csr.n] + 1),
    epoch: 0,
  };
}

/* The k nearest flagged nodes from s, in increasing distance.
 * Writes indices into outIdx and distances into outDist; returns the count. */
function csrNearestK(csr, W, s, k, outIdx, outDist) {
  const off = csr.off, tgt = csr.tgt, alen = csr.alen;
  const dist = W.dist, seen = W.seen, done = W.done, flag = W.flag, heap = W.heap;
  const E = ++W.epoch;
  heap.n = 0;
  dist[s] = 0; seen[s] = E; heap.push(0, s);
  let found = 0;
  while (heap.n && found < k) {
    const u = heap.pop(), d = heap.topKey;
    if (done[u] === E) continue;
    done[u] = E;
    if (u !== s && flag[u]) { outIdx[found] = u; outDist[found] = d; found++; }
    for (let p = off[u], q = off[u + 1]; p < q; p++) {
      const w = tgt[p];
      if (done[w] === E) continue;
      const nd = d + alen[p];
      if (seen[w] !== E || nd < dist[w]) { dist[w] = nd; seen[w] = E; heap.push(nd, w); }
    }
  }
  return found;
}

/* Shortest path s->t as node INDICES, early-exiting once t is settled. */
function csrPath(csr, W, s, t) {
  if (s === t) return [s];
  const off = csr.off, tgt = csr.tgt, alen = csr.alen;
  const dist = W.dist, seen = W.seen, done = W.done, prevN = W.prevN, heap = W.heap;
  const E = ++W.epoch;
  heap.n = 0;
  dist[s] = 0; seen[s] = E; heap.push(0, s);
  let reached = false;
  while (heap.n) {
    const u = heap.pop(), d = heap.topKey;
    if (done[u] === E) continue;
    done[u] = E;
    if (u === t) { reached = true; break; }
    for (let p = off[u], q = off[u + 1]; p < q; p++) {
      const w = tgt[p];
      if (done[w] === E) continue;
      const nd = d + alen[p];
      if (seen[w] !== E || nd < dist[w]) { dist[w] = nd; seen[w] = E; prevN[w] = u; heap.push(nd, w); }
    }
  }
  if (!reached) return null;
  const path = [t]; let cur = t;
  while (cur !== s) { cur = prevN[cur]; path.push(cur); }
  return path.reverse();
}

/* ---- odd-node matching ---- *
 * The matching IS the overhead: covered = bare + (total matching weight), so
 * overhead_pct == 100 * matchWeight / bare. Cutting matching weight cuts route
 * length one-for-one.
 *
 * The old strategy was "take an ARBITRARY unmatched odd node, match it to its
 * nearest partner". Arbitrary order is what hurts: a node processed late has
 * only far-away partners left, so it eats a very long edge. Instead we take the
 * globally shortest available candidate edge first (classic sorted greedy), then
 * polish with 2-opt.
 *
 * Measured on 9 real Overpass extracts: matching weight -21..26% and total
 * route length -3.6..9.0% (median -4.5%).
 *
 * COST, stated against the right baseline. The old arbitrary-order greedy can
 * itself be made much faster without changing its output, by stopping its
 * Dijkstra at the first settled unmatched odd node instead of exploring the
 * whole graph. That optimization is quality-neutral, and against THAT baseline
 * this matcher is ~4-6x SLOWER, not faster. It is only "17x faster" versus
 * the naive full-Dijkstra-per-pair version, which is not the fair comparison.
 * So this is a real speed-for-quality trade: on the corpus it costs a median
 * ~+300ms (bun; ~4x that in V8) to buy 4.3-14.3 points of overhead.
 *
 * MATCH_K is the speed/quality dial. Measured on manhattan-r12 (bun, median of
 * 3), against the quality-neutral plain-greedy baseline at 96ms / 18.5%:
 *
 *     K=2   162ms  14.4%      K=8   279ms  14.2%      K=24  553ms  13.8%
 *     K=4   212ms  14.2%      K=12  341ms  14.1%
 *
 * Quality saturates almost immediately: K=2 already captures ~93% of the win at
 * 1.7x cost, while K=24 costs 5.8x for the last few tenths of a point.
 *
 * It is NOT monotone, despite looking that way on one map. More candidates can
 * steer the greedy into a worse local optimum: on phoenix K=8 gives 26.6% but
 * K=12 gives 27.0%, and on brattleboro K=2 (49.7%) beats K=4 (50.0%). Treat K
 * as a knob to measure per corpus, not a quality guarantee.
 *
 * A per-node nearest-neighbour lower bound puts optimal matching well below even
 * K=24, so Blossom still has real headroom left — this is not the ceiling. */
/* Named presets for the UI. "fast" is the default: it captures ~93% of the
 * quality win for ~1.7x the plain-greedy cost, where "best" pays ~3.6x for the
 * last few tenths of a point. */
const MATCH_PRESETS = { fast: 2, best: 12 };
const MATCH_K = MATCH_PRESETS.fast;   // default candidate partners per odd node
const MATCH_2OPT_SWEEPS = 12;  // 2-opt passes (converges in far fewer)

function matchOdd(G, odd, csr, W, k) {
  csr = csr || buildCSR(G);
  W = W || csrWorkspace(csr);
  const K = (typeof k === 'number' && k > 0) ? Math.floor(k) : MATCH_K;
  const outIdx = new Int32Array(K), outDist = new Float64Array(K);
  const pairs = [];
  const dmap = new Map();      // known odd-odd shortest distances, "min|max" -> d
  const dkey = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  // Canonical node order. Ties are everywhere on grid-like street graphs, so if
  // tie-breaking followed Map insertion order the matching would depend on how
  // the graph was BUILT, not what it is — two identical graphs discovered in a
  // different order would plan different routes. Sorting by id makes the result
  // a function of graph content only (pinned by the shape-point invariant test).
  const unmatched = new Set(odd.slice().sort());

  // --- sorted greedy over k-nearest candidate edges, re-seeded each round ---
  for (let round = 0; unmatched.size > 1 && round < 40; round++) {
    // mark the still-unmatched set once per round, for O(1) tests inside the search
    W.flag.fill(0);
    for (const n of unmatched) W.flag[csr.index.get(n)] = 1;
    const cand = [];
    for (const u of unmatched) {
      const cnt = csrNearestK(csr, W, csr.index.get(u), K, outIdx, outDist);
      for (let t = 0; t < cnt; t++) {
        const v = csr.ids[outIdx[t]], d = outDist[t];
        const a = u < v ? u : v, b = u < v ? v : u;   // normalize orientation
        cand.push([d, a, b]);
        const k = a + '|' + b; if (!dmap.has(k)) dmap.set(k, d);
      }
    }
    if (!cand.length) break;
    cand.sort((p, q) => p[0] - q[0] || (p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0)
      || (p[2] < q[2] ? -1 : p[2] > q[2] ? 1 : 0));
    let any = false;
    for (const [d, u, v] of cand) {
      if (!unmatched.has(u) || !unmatched.has(v)) continue;
      unmatched.delete(u); unmatched.delete(v);
      pairs.push([u, v, d]); any = true;
    }
    if (!any) break;
  }
  // --- stragglers: candidate-starved or unreachable. Full Dijkstra, as before.
  while (unmatched.size > 1) {
    const u = unmatched.values().next().value; unmatched.delete(u);
    const { dist } = dijkstra(G, u);
    let best = null, bd = Infinity;
    for (const v of unmatched) { const d = dist.get(v); if (d !== undefined && d < bd) { bd = d; best = v; } }
    if (best === null) break;
    unmatched.delete(best);
    pairs.push([u, best, bd]); dmap.set(dkey(u, best), bd);
  }

  // --- 2-opt: swap two pairs when it shortens their combined weight ---
  // Only swaps whose replacement distances are ALREADY known are considered, so
  // this stays exact (never guesses a distance) and costs no extra Dijkstras.
  const D = (a, b) => dmap.get(dkey(a, b));
  const nbr = new Map();
  const addN = (a, b) => { let l = nbr.get(a); if (!l) nbr.set(a, l = []); l.push(b); };
  for (const k of dmap.keys()) { const i = k.indexOf('|'); addN(k.slice(0, i), k.slice(i + 1)); addN(k.slice(i + 1), k.slice(0, i)); }
  const owner = new Map();
  pairs.forEach((p, i) => { owner.set(p[0], i); owner.set(p[1], i); });
  for (let sweep = 0; sweep < MATCH_2OPT_SWEEPS; sweep++) {
    let improved = false;
    for (let i = 0; i < pairs.length; i++) {
      const a = pairs[i][0], b = pairs[i][1], cur = pairs[i][2];
      const cands = (nbr.get(a) || []).concat(nbr.get(b) || []);
      for (const x of cands) {
        const j = owner.get(x);
        if (j === undefined || j === i) continue;
        const c = pairs[j][0], d = pairs[j][1];
        let bestSum = cur + pairs[j][2] - 1e-9, pick = null;
        const ac = D(a, c), bd2 = D(b, d), ad = D(a, d), bc = D(b, c);
        if (ac !== undefined && bd2 !== undefined && ac + bd2 < bestSum) { bestSum = ac + bd2; pick = [[a, c, ac], [b, d, bd2]]; }
        if (ad !== undefined && bc !== undefined && ad + bc < bestSum) { bestSum = ad + bc; pick = [[a, d, ad], [b, c, bc]]; }
        if (pick) {
          pairs[i] = pick[0]; pairs[j] = pick[1];
          owner.set(pick[0][0], i); owner.set(pick[0][1], i);
          owner.set(pick[1][0], j); owner.set(pick[1][1], j);
          improved = true; break;
        }
      }
    }
    if (!improved) break;
  }
  return pairs;
}

/* ---- Chinese Postman augmentation ---- */
function augment(G, matchK) {
  // multigraph as edge-multiplicity map keyed "min-max"
  const mult = new Map();
  const key = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  for (const [n, es] of G.adj) for (const e of es) if (n < e.to) mult.set(key(n, e.to), 1);

  const odd = [...G.adj.keys()].filter(n => degree(G, n) % 2 === 1);
  if (odd.length < 2) return mult;
  // one CSR + one scratch workspace for the whole component, reused by every
  // search below (thousands of them)
  const csr = buildCSR(G), W = csrWorkspace(csr);
  for (const [u, v] of matchOdd(G, odd, csr, W, matchK)) {
    const idxPath = csrPath(csr, W, csr.index.get(u), csr.index.get(v));
    if (!idxPath) continue;
    const path = idxPath.map(i => csr.ids[i]);
    for (let i = 0; i + 1 < path.length; i++) {
      const k = key(path[i], path[i + 1]);
      mult.set(k, (mult.get(k) || 0) + 1);
    }
  }
  return mult; // Map "a|b" -> multiplicity
}

/* ---- Hierholzer Euler circuit over the augmented multigraph ---- */
function eulerCircuit(G, mult, startNode) {
  // build mutable adjacency with multiplicities
  const adj = new Map();
  for (const [k, m] of mult) {
    const [a, b] = k.split('|');
    const len = G.adj.get(a).find(e => e.to === b).len;
    for (let i = 0; i < m; i++) {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      const eid = k + '#' + i;
      adj.get(a).push({ to: b, len, eid });
      adj.get(b).push({ to: a, len, eid });
    }
  }
  const used = new Set();
  const start = (startNode && adj.has(startNode)) ? startNode : adj.keys().next().value;
  const stack = [start], circuit = [];
  const ptr = new Map();
  while (stack.length) {
    const v = stack[stack.length - 1];
    const list = adj.get(v) || [];
    let i = ptr.get(v) || 0;
    while (i < list.length && used.has(list[i].eid)) i++;
    ptr.set(v, i);
    if (i === list.length) { circuit.push(stack.pop()); }
    else { const e = list[i]; used.add(e.eid); stack.push(e.to); }
  }
  circuit.reverse();
  // convert node sequence to edge list with lengths
  const edges = [];
  for (let i = 0; i + 1 < circuit.length; i++) {
    const a = circuit[i], b = circuit[i + 1];
    const len = G.adj.get(a).find(e => e.to === b).len;
    edges.push({ a, b, len });
  }
  return edges;
}

/* ---- k-means clustering on node coords ---- */
function clusterNodes(G, k) {
  const ids = [...G.nodes.keys()];
  if (k <= 1 || ids.length <= k) { const a = new Map(); ids.forEach(n => a.set(n, 0)); return { assign: a, k: 1 }; }
  const pts = id => G.nodes.get(id);
  const byLon = [...ids].sort((p, q) => pts(p).lon - pts(q).lon);
  let cent = [];
  for (let i = 0; i < k; i++) { const p = pts(byLon[Math.floor(i * (byLon.length - 1) / (k - 1))]); cent.push([p.lat, p.lon]); }
  const assign = new Map();
  for (let it = 0; it < 12; it++) {
    for (const n of ids) {
      const p = pts(n); let bc = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const d = (p.lat - cent[c][0]) ** 2 + (p.lon - cent[c][1]) ** 2; if (d < bd) { bd = d; bc = c; } }
      assign.set(n, bc);
    }
    const sum = Array.from({ length: k }, () => [0, 0, 0]);
    for (const n of ids) { const p = pts(n), c = assign.get(n); sum[c][0] += p.lat; sum[c][1] += p.lon; sum[c][2]++; }
    for (let c = 0; c < k; c++) if (sum[c][2]) cent[c] = [sum[c][0] / sum[c][2], sum[c][1] / sum[c][2]];
  }
  return { assign, k };
}

function subgraph(G, nodeSet) {
  const H = makeGraph();
  for (const n of nodeSet) H.nodes.set(n, G.nodes.get(n));
  for (const n of nodeSet)
    for (const e of G.adj.get(n))
      if (nodeSet.has(e.to) && n < e.to) addEdge(H, n, e.to, e.len);
  return H;
}

/* ---- split an Euler edge-walk into runs <= maxMeters ---- */
function splitRuns(edges, maxMeters) {
  const runs = []; let cur = [], clen = 0;
  for (const e of edges) {
    if (cur.length && clen + e.len > maxMeters) { runs.push({ edges: cur, len: clen }); cur = []; clen = 0; }
    cur.push(e); clen += e.len;
  }
  if (cur.length) runs.push({ edges: cur, len: clen });
  return runs;
}

/* ---- degree-2 chain contraction ---- *
 * Mid-block "shape points" (degree-2 nodes between two intersections) carry no
 * routing decision — a runner just passes through. Collapsing each maximal
 * degree-2 chain into one super-edge shrinks the graph the solver works on
 * (big win for augment(), which runs a Dijkstra per odd node), without changing
 * the odd-node set, the total street length, or which streets get covered.
 *
 * Returns { graph, via } where `graph` is the contracted graph (a subset of the
 * original node ids) and `via` maps "min|max" endpoint keys to the ordered list
 * of collapsed intermediate node ids (min->max), for coordinate reconstruction.
 *
 * A chain is kept EXPANDED (its nodes preserved) when collapsing it would create
 * a self-loop or a parallel edge — the simple-graph model dedups parallel edges,
 * which would silently drop a street. Keeping it expanded is always correct. */
function contractDeg2(G, opts = {}) {
  const { maxMeters = Infinity, keep = null } = opts;
  const deg = n => G.adj.get(n).length;
  // a node anchors chains if it's not degree-2, OR it's explicitly protected
  // (e.g. the start anchor — we must not collapse the run's start point).
  const isJ = n => deg(n) !== 2 || (keep != null && keep.has(n));
  const key = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  const H = makeGraph();
  const via = new Map();

  // walk a maximal degree-2 chain from junction j, stepping to `first` next.
  function walk(j, first) {
    let prev = j, cur = first;
    let len = G.adj.get(j).find(e => e.to === first).len;
    const mids = [];
    while (!isJ(cur)) {
      mids.push(cur);
      const es = G.adj.get(cur);
      const nxt = es[0].to === prev ? es[1] : es[0];
      len += nxt.len; prev = cur; cur = nxt.to;
    }
    return { end: cur, len, mids, lastBeforeEnd: mids.length ? mids[mids.length - 1] : j };
  }

  // collect each chain once (mark both directed first-steps)
  const seen = new Set();
  const chains = [];
  for (const j of G.adj.keys()) {
    if (!isJ(j)) continue;
    for (const e of G.adj.get(j)) {
      const dirKey = j + '>' + e.to;
      if (seen.has(dirKey)) continue;
      const w = walk(j, e.to);
      seen.add(dirKey);
      seen.add(w.end + '>' + w.lastBeforeEnd);
      chains.push({ a: j, b: w.end, len: w.len, mids: w.mids });
    }
  }
  // fully-degree-2 components (isolated loops) have no junction and are skipped
  // by the loop above; carry them over verbatim so their streets aren't lost.
  for (const [n, es] of G.adj) {
    if (isJ(n) || reachesJunction(G, n, isJ)) continue;
    H.nodes.set(n, G.nodes.get(n));
    for (const e of es) if (n < e.to) { H.nodes.set(e.to, G.nodes.get(e.to)); addEdge(H, n, e.to, e.len); }
  }

  // add direct (no-mid) edges first so parallel chains collide against them
  chains.sort((p, q) => p.mids.length - q.mids.length);
  const present = new Set();
  for (const { a, b, len, mids } of chains) {
    const k = key(a, b);
    // Keep a chain expanded when collapsing it would be wrong (self-loop /
    // parallel edge) OR when the chain is longer than the cap — then splitRuns
    // needs the interior nodes to break it into runs within the limit.
    if (a !== b && !present.has(k) && len <= maxMeters) {
      H.nodes.set(a, G.nodes.get(a)); H.nodes.set(b, G.nodes.get(b));
      addEdge(H, a, b, len);
      present.add(k);
      if (mids.length) via.set(k, a < b ? mids.slice() : mids.slice().reverse());
    } else {
      // collision / self-loop: keep the chain expanded (original nodes + edges)
      const full = [a, ...mids, b];
      for (let i = 0; i + 1 < full.length; i++) {
        const u = full[i], w = full[i + 1];
        H.nodes.set(u, G.nodes.get(u)); H.nodes.set(w, G.nodes.get(w));
        addEdge(H, u, w, G.adj.get(u).find(x => x.to === w).len);
      }
    }
  }
  return { graph: H, via };
}

/* does a degree-2 node eventually reach a junction? (false => isolated loop) */
function reachesJunction(G, start, isJ) {
  const seen = new Set([start]); const stack = [start];
  while (stack.length) {
    const n = stack.pop();
    for (const e of G.adj.get(n)) {
      if (isJ(e.to)) return true;
      if (!seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    }
  }
  return false;
}

/* ---- top-level planner ---- */
function planRuns(G, maxMeters, opts = {}) {
  // Default to a single global solve. k-means zoning was measured (see
  // attribution.js) to add ~5-7% seam-deadhead overhead for no compactness
  // gain — an Euler circuit is already locally connected, so splitting one
  // global circuit yields runs just as tight as zoned ones. Opt in with
  // cluster:true if you specifically want runs grouped into colored zones.
  const { startLat, startLon, cluster = false, matchK } = opts;
  G = largestComponent(G);
  const full = G;                              // full-resolution graph for coords/stats
  // anchor on the full graph, then protect that node so contraction keeps it.
  const startNode = (startLat != null) ? nearestNode(full, startLat, startLon) : null;
  const { graph: Gc, via } = contractDeg2(full, { maxMeters, keep: startNode ? new Set([startNode]) : null });
  G = Gc;                                       // solve on the contracted graph
  let bare = 0;
  for (const [n, es] of G.adj) for (const e of es) if (n < e.to) bare += e.len;

  const targetZone = maxMeters * 6;
  const k = cluster ? Math.max(1, Math.round(bare / targetZone)) : 1;
  const { assign, k: kk } = clusterNodes(G, k);

  // Assign every EDGE to exactly one zone (by its smaller endpoint's cluster),
  // then build each zone subgraph from its edges — this pulls in boundary
  // nodes too, so no street is ever dropped at a zone seam.
  const zoneEdges = new Map();   // zone -> Array<[u,v,len]>
  const zoneNodeSet = new Map(); // zone -> Set of node ids touched
  for (const [n, es] of G.adj) for (const e of es) {
    if (n < e.to) {
      const z = assign.get(n);
      if (!zoneEdges.has(z)) { zoneEdges.set(z, []); zoneNodeSet.set(z, new Set()); }
      zoneEdges.get(z).push([n, e.to, e.len]);
      zoneNodeSet.get(z).add(n); zoneNodeSet.get(z).add(e.to);
    }
  }
  const zoneCenter = c => {
    let la = 0, lo = 0, m = 0; for (const n of zoneNodeSet.get(c)) { const p = G.nodes.get(n); la += p.lat; lo += p.lon; m++; } return [la / m, lo / m];
  };
  let order = [...zoneEdges.keys()];
  if (startNode != null) {
    const s = G.nodes.get(startNode);
    order.sort((x, y) => { const [ax, ay] = zoneCenter(x), [bx, by] = zoneCenter(y);
      return haversine(s.lat, s.lon, ax, ay) - haversine(s.lat, s.lon, bx, by); });
  }

  const runs = []; let entry = startNode;
  for (const c of order) {
    // build subgraph from this zone's edges
    let sub = makeGraph();
    for (const n of zoneNodeSet.get(c)) sub.nodes.set(n, G.nodes.get(n));
    for (const [u, v, len] of zoneEdges.get(c)) addEdge(sub, u, v, len);
    // solve EVERY connected component in the zone (not just the largest),
    // so no street is dropped if k-means splits the zone into pieces.
    for (const comp of allComponents(sub)) {
      if (comp.adj.size === 0) continue;
      let zstart = null;
      if (entry != null) { const ep = G.nodes.get(entry); zstart = nearestNode(comp, ep.lat, ep.lon); }
      const mult = augment(comp, matchK);
      const edges = eulerCircuit(comp, mult, zstart);
      if (edges.length === 0) continue;
      for (const r of splitRuns(edges, maxMeters)) runs.push({ ...r, zone: c });
      entry = runs[runs.length - 1].edges.slice(-1)[0].b;
    }
  }

  // attach coordinate paths — expand contracted super-edges back through their
  // collapsed shape points so the GPX traces the real street geometry.
  const M_PER_MI = 1609.344;
  let covered = 0;
  const pushLL = (coords, id) => {
    const p = full.nodes.get(id), ll = typeof p.ele === 'number' ? [p.lat, p.lon, p.ele] : [p.lat, p.lon];
    if (!coords.length || coords[coords.length - 1][0] !== ll[0] || coords[coords.length - 1][1] !== ll[1]) coords.push(ll);
  };
  const out = runs.map((r, i) => {
    covered += r.len;
    const coords = [];
    for (const e of r.edges) {
      pushLL(coords, e.a);
      const mids = via.get(e.a < e.b ? e.a + '|' + e.b : e.b + '|' + e.a);
      if (mids) for (const m of (e.a < e.b ? mids : [...mids].reverse())) pushLL(coords, m);
      pushLL(coords, e.b);
    }
    // elevation gain/loss along the run (null when no data, so flat != unknown)
    let gain = 0, loss = 0, have = false;
    for (let j = 0; j + 1 < coords.length; j++) {
      const a = coords[j][2], b = coords[j + 1][2];
      if (typeof a === 'number' && typeof b === 'number') { have = true; const d = b - a; if (d > 0) gain += d; else loss -= d; }
    }
    return {
      id: i + 1, length_mi: +(r.len / M_PER_MI).toFixed(2), zone: r.zone, coords,
      elev_gain_m: have ? Math.round(gain) : null,
      elev_loss_m: have ? Math.round(loss) : null,
    };
  });

  const gains = out.map(r => r.elev_gain_m).filter(x => x != null);
  const losses = out.map(r => r.elev_loss_m).filter(x => x != null);
  return {
    runs: out,
    stats: {
      intersections: full.nodes.size,
      segments: [...full.adj].reduce((s, [n, es]) => s + es.filter(e => n < e.to).length, 0),
      bare_mi: +(bare / M_PER_MI).toFixed(1),
      covered_mi: +(covered / M_PER_MI).toFixed(1),
      overhead_pct: bare ? +(100 * (covered - bare) / bare).toFixed(1) : 0,
      n_runs: out.length,
      zones: kk,
      total_gain_m: gains.length ? gains.reduce((s, x) => s + x, 0) : null,
      total_loss_m: losses.length ? losses.reduce((s, x) => s + x, 0) : null,
    },
  };
}

/* ---- GPX export ---- */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function runToGPX(run, name) {
  const seg = run.coords.map(([lat, lon, ele]) =>
    `      <trkpt lat="${lat}" lon="${lon}">${typeof ele === 'number' ? `<ele>${ele}</ele>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="STR1DE" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${xmlEscape(name)}</name><trkseg>
${seg}
  </trkseg></trk>
</gpx>`;
}

const API = { makeGraph, setNode, addEdge, planRuns, runToGPX, haversine, nearestNode, MATCH_PRESETS };
// internals exposed for unit tests (not part of the public surface)
API._internal = {
  largestComponent, allComponents, dijkstra, augment, eulerCircuit,
  clusterNodes, splitRuns, degree, nearestNode, xmlEscape, contractDeg2,
  dijkstraNearest, dijkstraNearestK, dijkstraPath, matchOdd, buildCSR, csrWorkspace, csrNearestK, csrPath,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof self !== 'undefined') self.CoverageCore = API;
