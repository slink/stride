/* test_net_cache.js — assertion tests for the Overpass/Nominatim response
 * cache, its slim encoding, and the fetch cooldown.
 * Run: `node test_net_cache.js`.
 */
'use strict';
const assert = require('node:assert/strict');
const C = require('../coverage_core.js');
const NC = require('../net_cache.js');

/* Mirrors the worker's graph builder (worker.js uses importScripts), so the
 * round-trip test can compare slim-encoded data through the real consumer. */
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

function graphShape(G) {
  let edges = 0, total = 0;
  for (const [n, es] of G.adj) for (const e of es) if (n < e.to) { edges++; total += e.len; }
  return { nodes: G.adj.size, edges, total };
}

/* A grid with 7-decimal coordinates and non-contiguous node ids, so the test
 * exercises delta-coding of both ids and coords. */
function gridOverpass(rows, cols) {
  const elements = []; const idg = {}; let nid = 1000000000;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    nid += 37 + r * 11 + c;             // sparse, ascending ids
    idg[r + ',' + c] = nid;
    elements.push({
      type: 'node', id: nid,
      lat: +(40.7012345 + r * 0.0031117).toFixed(7),
      lon: +(-74.0198765 + c * 0.0042213).toFixed(7),
      tags: { note: 'dropped by the slim encoding' },
    });
  }
  let wid = 5000;
  for (let r = 0; r < rows; r++) {
    elements.push({ type: 'way', id: wid++, tags: { highway: 'residential' },
      nodes: Array.from({ length: cols }, (_, c) => idg[r + ',' + c]) });
  }
  for (let c = 0; c < cols; c++) {
    elements.push({ type: 'way', id: wid++, tags: { highway: 'residential' },
      nodes: Array.from({ length: rows }, (_, r) => idg[r + ',' + c]) });
  }
  return { elements };
}

/* localStorage-alike with a hard character budget, so eviction is testable. */
function fakeStore(budgetChars = Infinity) {
  const m = new Map();
  const used = () => { let n = 0; for (const [k, v] of m) n += k.length + v.length; return n; };
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    removeItem: k => { m.delete(k); },
    setItem(k, v) {
      const after = used() - (m.has(k) ? k.length + m.get(k).length : 0) + k.length + v.length;
      if (after > budgetChars) {
        const e = new Error('exceeded the quota'); e.name = 'QuotaExceededError'; throw e;
      }
      m.set(k, v);
    },
    _keys: () => [...m.keys()],
    _used: used,
  };
}

const AREA = { lat: 40.7290123, lon: -73.9905456, radiusM: 1931, net: 'walk' };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---- slim encoding ---- */

test('slim -> expand round-trips to an identical graph', () => {
  const data = gridOverpass(4, 5);
  const before = graphShape(graphFromOverpass(data));
  const after = graphShape(graphFromOverpass(NC.expandSlim(NC.slimOverpass(data))));
  assert.equal(after.nodes, before.nodes, 'node count preserved');
  assert.equal(after.edges, before.edges, 'edge count preserved');
  assert.ok(Math.abs(after.total - before.total) < 1e-6,
    `total length preserved (${before.total} vs ${after.total})`);
});

test('slim -> expand preserves 7-decimal coordinates', () => {
  const data = gridOverpass(3, 3);
  const orig = new Map(data.elements.filter(e => e.type === 'node').map(e => [e.id, e]));
  const back = NC.expandSlim(NC.slimOverpass(data)).elements.filter(e => e.type === 'node');
  assert.equal(back.length, orig.size, 'every node survives');
  for (const n of back) {
    const o = orig.get(n.id);
    assert.ok(o, `node ${n.id} kept its id`);
    assert.ok(Math.abs(n.lat - o.lat) < 1e-9, `lat preserved for ${n.id}`);
    assert.ok(Math.abs(n.lon - o.lon) < 1e-9, `lon preserved for ${n.id}`);
  }
});

test('slim encoding drops tags (they are not read by the graph builder)', () => {
  const s = NC.slimOverpass(gridOverpass(2, 2));
  assert.ok(!JSON.stringify(s).includes('dropped by the slim encoding'),
    'node tags are not carried into the cache payload');
  assert.ok(!JSON.stringify(s).includes('residential'),
    'way tags are not carried into the cache payload');
});

test('slim encoding is substantially smaller than the raw response', () => {
  const data = gridOverpass(12, 12);
  const raw = JSON.stringify(data).length;
  const slim = JSON.stringify(NC.slimOverpass(data)).length;
  assert.ok(slim < raw / 2, `slim (${slim}) is less than half of raw (${raw})`);
});

test('ways referencing absent nodes survive the round-trip harmlessly', () => {
  const data = { elements: [
    { type: 'node', id: 1, lat: 40.70, lon: -74.02 },
    { type: 'node', id: 2, lat: 40.71, lon: -74.02 },
    { type: 'way', id: 100, nodes: [1, 2, 999] },
  ] };
  const G = graphFromOverpass(NC.expandSlim(NC.slimOverpass(data)));
  assert.equal(graphShape(G).edges, 1, 'the dangling 2-999 edge is dropped, no crash');
});

/* ---- keys ---- */

test('overpassKey is deterministic and tolerant of sub-11m jitter', () => {
  const a = NC.overpassKey(AREA);
  const b = NC.overpassKey({ ...AREA });
  assert.equal(a, b, 'same inputs -> same key');
  // 4dp rounding: a change in the 6th decimal must not split the entry
  assert.equal(NC.overpassKey({ ...AREA, lat: AREA.lat + 0.000004 }), a,
    'sub-11m jitter reuses the cached area');
});

test('overpassKey separates network, radius, and real position changes', () => {
  const base = NC.overpassKey(AREA);
  assert.notEqual(NC.overpassKey({ ...AREA, net: 'bike' }), base, 'network filter is part of the key');
  assert.notEqual(NC.overpassKey({ ...AREA, radiusM: 2000 }), base, 'radius is part of the key');
  assert.notEqual(NC.overpassKey({ ...AREA, lat: AREA.lat + 0.01 }), base, 'position is part of the key');
});

test('geocodeKey normalizes case and surrounding whitespace', () => {
  assert.equal(NC.geocodeKey('  Cooper Square, Manhattan '), NC.geocodeKey('cooper square, manhattan'),
    'the same address typed differently is one cache entry');
  assert.notEqual(NC.geocodeKey('Cooper Square'), NC.geocodeKey('Union Square'),
    'different addresses stay separate');
});

/* ---- cache behaviour ---- */

test('a miss returns null; a stored area round-trips back as Overpass JSON', () => {
  const cache = NC.makeCache(fakeStore());
  assert.equal(cache.getOverpass(AREA), null, 'cold cache misses');
  const data = gridOverpass(3, 4);
  assert.equal(cache.putOverpass(AREA, data), true, 'store succeeds');
  const hit = cache.getOverpass(AREA);
  assert.ok(hit && hit.elements, 'hit is shaped like an Overpass response');
  assert.equal(graphShape(graphFromOverpass(hit)).edges,
    graphShape(graphFromOverpass(data)).edges, 'the cached area rebuilds the same graph');
});

test('entries expire after the TTL and are removed on read', () => {
  const store = fakeStore();
  let now = 1000;
  const cache = NC.makeCache(store, { now: () => now, ttlMs: 500 });
  cache.putOverpass(AREA, gridOverpass(2, 2));
  now = 1400;
  assert.ok(cache.getOverpass(AREA), 'still fresh inside the TTL');
  now = 1600;
  assert.equal(cache.getOverpass(AREA), null, 'expired past the TTL');
  const before = store._used();
  cache.getOverpass(AREA);
  assert.ok(store._used() <= before, 'the expired blob is not left behind');
});

test('an oversize area is skipped, not stored', () => {
  const store = fakeStore();
  const cache = NC.makeCache(store, { maxEntryChars: 200 });
  assert.equal(cache.putOverpass(AREA, gridOverpass(8, 8)), false, 'oversize put is refused');
  assert.equal(cache.getOverpass(AREA), null, 'nothing was written');
});

test('quota pressure evicts the least-recently-used area, keeping the newest', () => {
  const A = AREA;
  const B = { ...AREA, lat: 41.10 };
  const D = { ...AREA, lat: 42.20 };
  const payload = gridOverpass(4, 4);
  // Calibrate against a real stored entry rather than guessing a byte budget:
  // wide enough for two areas, too tight for three.
  const probe = fakeStore();
  NC.makeCache(probe).putOverpass(A, payload);
  const store = fakeStore(Math.floor(probe._used() * 2.4));
  const cache = NC.makeCache(store);

  assert.equal(cache.putOverpass(A, payload), true, 'A stored');
  assert.equal(cache.putOverpass(B, payload), true, 'B stored');
  cache.getOverpass(A);                       // touch A so B is now the LRU
  assert.equal(cache.putOverpass(D, payload), true, 'D stored after evicting to fit');

  assert.ok(cache.getOverpass(D), 'the newest area survives');
  assert.ok(cache.getOverpass(A), 'the recently-touched area survives');
  assert.equal(cache.getOverpass(B), null, 'the least-recently-used area was evicted');
});

test('hasOverpass answers without promoting the entry (a peek is not a use)', () => {
  const A = AREA;
  const B = { ...AREA, lat: 41.10 };
  const D = { ...AREA, lat: 42.20 };
  const payload = gridOverpass(4, 4);
  const probe = fakeStore();
  NC.makeCache(probe).putOverpass(A, payload);
  const store = fakeStore(Math.floor(probe._used() * 2.4));
  const cache = NC.makeCache(store);

  cache.putOverpass(A, payload);
  cache.putOverpass(B, payload);
  assert.equal(cache.hasOverpass(A), true, 'peek sees the cached area');
  assert.equal(cache.hasOverpass(D), false, 'peek misses an unknown area');
  // A is still the least-recently-used, so it is the one evicted — unlike the
  // getOverpass case above, where reading A rescued it.
  cache.putOverpass(D, payload);
  assert.equal(cache.hasOverpass(A), false, 'peeking did not rescue A from eviction');
  assert.equal(cache.hasOverpass(B), true, 'B survived because the peek did not promote A');
});

test('hasOverpass respects the TTL', () => {
  let now = 1000;
  const cache = NC.makeCache(fakeStore(), { now: () => now, ttlMs: 500 });
  cache.putOverpass(AREA, gridOverpass(2, 2));
  assert.equal(cache.hasOverpass(AREA), true, 'fresh entry is visible');
  now = 1600;
  assert.equal(cache.hasOverpass(AREA), false, 'expired entry reads as absent');
});

test('a put that cannot fit at all fails cleanly and leaves the cache usable', () => {
  const store = fakeStore(400);
  const cache = NC.makeCache(store);
  assert.equal(cache.putOverpass(AREA, gridOverpass(6, 6)), false, 'put reports failure');
  assert.equal(cache.getOverpass(AREA), null, 'no partial entry is readable');
  assert.equal(cache.putGeocode('cooper square', [40.7290123, -73.9905456]), true,
    'the cache still works afterwards');
});

test('geocode results round-trip and are cached per normalized query', () => {
  const cache = NC.makeCache(fakeStore());
  assert.equal(cache.getGeocode('Cooper Square'), null, 'cold miss');
  cache.putGeocode('Cooper Square', [40.7290123, -73.9905456]);
  const hit = cache.getGeocode('  cooper square  ');
  assert.ok(hit, 'normalized variant hits');
  assert.ok(Math.abs(hit[0] - 40.7290123) < 1e-9 && Math.abs(hit[1] - -73.9905456) < 1e-9,
    'coordinates survive exactly');
});

test('peekGeocode returns the coordinates without writing to storage', () => {
  const store = fakeStore();
  const cache = NC.makeCache(store);
  cache.putGeocode('Cooper Square', [40.7290123, -73.9905456]);
  const before = store._used();
  const hit = cache.peekGeocode('  cooper square ');
  assert.ok(hit && Math.abs(hit[0] - 40.7290123) < 1e-9, 'peek returns the coordinates');
  assert.equal(store._used(), before, 'a peek writes nothing (safe to call on every UI tick)');
  assert.equal(cache.peekGeocode('nowhere at all'), null, 'unknown address peeks as null');
});

test('corrupt stored JSON is treated as a miss, not a crash', () => {
  const store = fakeStore();
  const cache = NC.makeCache(store);
  cache.putOverpass(AREA, gridOverpass(2, 2));
  for (const k of store._keys()) if (k.includes('op')) store.setItem(k, '{not json');
  assert.equal(cache.getOverpass(AREA), null, 'unparseable entry reads as a miss');
});

test('the last-fetch stamp persists across cache instances (survives a reload)', () => {
  const store = fakeStore();
  assert.equal(NC.makeCache(store).getLastFetchAt(), null, 'nothing recorded yet');
  NC.makeCache(store).noteFetch(1729000000000);
  // a fresh cache over the same storage is what a page reload looks like
  assert.equal(NC.makeCache(store).getLastFetchAt(), 1729000000000,
    'a reload cannot reset the cooldown');
});

test('the last-fetch stamp is not evicted by quota pressure', () => {
  const payload = gridOverpass(4, 4);
  const probe = fakeStore();
  NC.makeCache(probe).putOverpass(AREA, payload);
  const store = fakeStore(Math.floor(probe._used() * 2.4));
  const cache = NC.makeCache(store);
  cache.noteFetch(1729000000000);
  cache.putOverpass(AREA, payload);
  cache.putOverpass({ ...AREA, lat: 41.1 }, payload);
  cache.putOverpass({ ...AREA, lat: 42.2 }, payload);   // forces eviction
  assert.equal(cache.getLastFetchAt(), 1729000000000, 'the cooldown stamp outlives evicted areas');
});

/* ---- cooldown ---- */

test('cooldown is zero before any fetch and counts down after one', () => {
  assert.equal(NC.cooldownRemaining(5000, null, 60000), 0, 'cold start is not throttled');
  assert.equal(NC.cooldownRemaining(1000, 1000, 60000), 60000, 'full window right after a fetch');
  assert.equal(NC.cooldownRemaining(31000, 1000, 60000), 30000, 'half elapsed');
  assert.equal(NC.cooldownRemaining(61000, 1000, 60000), 0, 'expired exactly at the window');
  assert.equal(NC.cooldownRemaining(99000, 1000, 60000), 0, 'never negative');
});

let pass = 0, fail = 0;
for (const t of tests) {
  try { t.fn(); console.log(`  ok   ${t.name}`); pass++; }
  catch (e) { console.log(`  FAIL ${t.name}\n         ${e.message}`); fail++; }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
