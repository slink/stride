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

/* ---- Chinese Postman augmentation with GREEDY odd-node matching ---- *
 * Optimal would be Blossom min-weight matching (see README). Greedy nearest
 * costs a few % extra overhead but needs no matching library client-side. */
function augment(G) {
  // multigraph as edge-multiplicity map keyed "min-max"
  const mult = new Map();
  const key = (a, b) => a < b ? a + '|' + b : b + '|' + a;
  for (const [n, es] of G.adj) for (const e of es) if (n < e.to) mult.set(key(n, e.to), 1);

  const odd = [...G.adj.keys()].filter(n => degree(G, n) % 2 === 1);
  // greedy: repeatedly take an odd node, Dijkstra, match to nearest unmatched odd node
  const unmatched = new Set(odd);
  while (unmatched.size > 1) {
    const u = unmatched.values().next().value;
    unmatched.delete(u);
    // u is already removed from `unmatched`, so it cannot match itself
    const { best, prev } = dijkstraNearest(G, u, unmatched);
    if (best === null) { break; }
    unmatched.delete(best);
    const path = pathBetween(prev, u, best);
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
  const { startLat, startLon, cluster = false } = opts;
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
      const mult = augment(comp);
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

const API = { makeGraph, setNode, addEdge, planRuns, runToGPX, haversine, nearestNode };
// internals exposed for unit tests (not part of the public surface)
API._internal = {
  largestComponent, allComponents, dijkstra, augment, eulerCircuit,
  clusterNodes, splitRuns, degree, nearestNode, xmlEscape, contractDeg2, dijkstraNearest,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof self !== 'undefined') self.CoverageCore = API;
