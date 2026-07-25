/* net_cache.js — courtesy layer for the public OSM services.
 *
 * Overpass and Nominatim are volunteer-run. This module keeps STR1DE a
 * well-behaved client of both:
 *   - caches Overpass areas and geocode hits so a repeat plan costs no request
 *   - encodes cached areas small enough to actually fit in localStorage
 *   - provides the arithmetic for the post-fetch cooldown
 *
 * Why the slim encoding: a query at the app's default settings (1.2 mi, walk)
 * returns ~7 MB of JSON, and localStorage is ~5 MB per origin storing UTF-16 —
 * caching the raw response fails on the first write. The graph builder
 * (worker.js) reads only type/id/lat/lon/nodes, and highway filtering already
 * happened server-side, so tags can be dropped. Delta-coding sorted ids and
 * 1e7 integer coords takes that same area to ~0.94 MB, losslessly.
 *
 * Pure JS, no dependencies. Runs in the browser and in Node (for tests);
 * storage is injected so tests can supply a fake.
 */
'use strict';
(function () {

var SCHEMA = 1;
var NS = 'stride:v' + SCHEMA + ':';
var IDX_KEY = NS + 'idx';
var OP_PREFIX = NS + 'op:';
var GC_PREFIX = NS + 'gc:';
var LAST_FETCH_KEY = NS + 'lastfetch';   // deliberately outside the LRU index, so it is never evicted

var DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // OSM street geometry moves slowly
var DEFAULT_MAX_ENTRY_CHARS = 1500000;          // ~3 MB of UTF-16 quota
var DEFAULT_COOLDOWN_MS = 60000;
var COORD = 1e7;                                // OSM's native coordinate precision

/* ---- slim encoding ---- */

/* Overpass JSON -> {v, i, a, o, w}: delta-coded node ids, delta-coded integer
 * lat/lon, and ways as plain node-id arrays. Tags are discarded. */
function slimOverpass(data) {
  var nodes = new Map(), ways = [];
  var els = (data && data.elements) || [];
  for (var k = 0; k < els.length; k++) {
    var el = els[k];
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way' && el.nodes) ways.push(el.nodes);
  }
  var ids = Array.from(nodes.keys()).sort(function (x, y) { return x - y; });
  var i = [], a = [], o = [];
  var pi = 0, pa = 0, po = 0;
  for (var j = 0; j < ids.length; j++) {
    var n = nodes.get(ids[j]);
    var la = Math.round(n.lat * COORD), lo = Math.round(n.lon * COORD);
    i.push(ids[j] - pi); pi = ids[j];
    a.push(la - pa); pa = la;
    o.push(lo - po); po = lo;
  }
  return { v: SCHEMA, i: i, a: a, o: o, w: ways };
}

/* The inverse: rebuilds Overpass-shaped JSON, so graphFromOverpass and the
 * worker's message contract need no knowledge of this encoding. */
function expandSlim(slim) {
  var elements = [];
  var pi = 0, pa = 0, po = 0;
  for (var k = 0; k < slim.i.length; k++) {
    pi += slim.i[k]; pa += slim.a[k]; po += slim.o[k];
    elements.push({ type: 'node', id: pi, lat: pa / COORD, lon: po / COORD });
  }
  for (var j = 0; j < slim.w.length; j++) {
    elements.push({ type: 'way', nodes: slim.w[j] });
  }
  return { elements: elements };
}

/* ---- keys ---- */

/* Rounded to 4dp (~11 m) so retyping the same address reuses the entry. Not a
 * bbox: the query is `around:` a point, and snapping to a grid would change
 * what gets fetched rather than just how it is indexed. */
function overpassKey(area) {
  return [area.net, Math.round(area.radiusM), area.lat.toFixed(4), area.lon.toFixed(4)].join('|');
}

function geocodeKey(q) {
  return String(q).trim().toLowerCase().replace(/\s+/g, ' ');
}

/* ---- cooldown ---- */

function cooldownRemaining(now, lastAt, windowMs) {
  if (lastAt == null) return 0;
  var w = windowMs == null ? DEFAULT_COOLDOWN_MS : windowMs;
  return Math.max(0, w - (now - lastAt));
}

/* ---- cache ---- */

function makeCache(store, opts) {
  opts = opts || {};
  var now = opts.now || function () { return Date.now(); };
  var ttlMs = opts.ttlMs == null ? DEFAULT_TTL_MS : opts.ttlMs;
  var maxEntryChars = opts.maxEntryChars == null ? DEFAULT_MAX_ENTRY_CHARS : opts.maxEntryChars;

  function readIdx() {
    try {
      var raw = store.getItem(IDX_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function tryWrite(key, value) {
    try { store.setItem(key, value); return true; } catch (e) { return false; }
  }
  function tryRemove(key) {
    try { store.removeItem(key); } catch (e) { /* nothing sane to do */ }
  }

  /* Writes the entry, evicting least-recently-used areas until it fits. The
   * index write can hit the quota too, so it evicts on the same loop. Returns
   * false rather than throwing when the entry cannot fit at all — a plan
   * should still complete when the cache is full. */
  function put(key, payload) {
    var blob = JSON.stringify({ t: now(), d: payload });
    if (blob.length > maxEntryChars) return false;

    var idx = readIdx().filter(function (k) { return k !== key; });
    tryRemove(key);                                  // reclaim any stale copy

    while (!tryWrite(key, blob)) {
      if (!idx.length) { tryRemove(key); tryWrite(IDX_KEY, JSON.stringify(idx)); return false; }
      tryRemove(idx.pop());
    }
    idx.unshift(key);
    while (!tryWrite(IDX_KEY, JSON.stringify(idx))) {
      if (idx.length <= 1) { tryRemove(key); tryWrite(IDX_KEY, '[]'); return false; }
      tryRemove(idx.pop());
    }
    return true;
  }

  function drop(key) {
    tryRemove(key);
    tryWrite(IDX_KEY, JSON.stringify(readIdx().filter(function (k) { return k !== key; })));
  }

  function touch(key) {
    var idx = readIdx().filter(function (k) { return k !== key; });
    idx.unshift(key);
    tryWrite(IDX_KEY, JSON.stringify(idx));          // ordering is best-effort
  }

  /* Reads without recording a use, so the UI can ask "is this area cached?"
   * on every cooldown tick without reordering the LRU or writing to storage. */
  function peek(key) {
    var raw;
    try { raw = store.getItem(key); } catch (e) { return null; }
    if (!raw) return null;
    var rec;
    try { rec = JSON.parse(raw); } catch (e) { return null; }
    if (!rec || typeof rec.t !== 'number') return null;
    if (now() - rec.t > ttlMs) return null;
    return rec;
  }

  function get(key) {
    var rec = peek(key);
    if (!rec) {
      // distinguish "absent" from "present but stale/corrupt", which we evict
      var raw = null;
      try { raw = store.getItem(key); } catch (e) { /* treated as absent */ }
      if (raw) drop(key);
      return null;
    }
    touch(key);
    return rec.d;
  }

  return {
    getOverpass: function (area) {
      var d = get(OP_PREFIX + overpassKey(area));
      return d ? expandSlim(d) : null;
    },
    putOverpass: function (area, data) {
      return put(OP_PREFIX + overpassKey(area), slimOverpass(data));
    },
    hasOverpass: function (area) {
      return peek(OP_PREFIX + overpassKey(area)) !== null;
    },
    /* Persisted so the cooldown survives a reload — otherwise refreshing the
     * page would reset it and the debounce would not be a limit at all. */
    getLastFetchAt: function () {
      var raw;
      try { raw = store.getItem(LAST_FETCH_KEY); } catch (e) { return null; }
      if (raw == null) return null;
      var n = Number(raw);
      return isFinite(n) ? n : null;
    },
    noteFetch: function (t) {
      tryWrite(LAST_FETCH_KEY, String(t));
    },
    getGeocode: function (q) {
      var d = get(GC_PREFIX + geocodeKey(q));
      return (Array.isArray(d) && d.length === 2) ? d : null;
    },
    peekGeocode: function (q) {
      var rec = peek(GC_PREFIX + geocodeKey(q));
      var d = rec && rec.d;
      return (Array.isArray(d) && d.length === 2) ? d : null;
    },
    putGeocode: function (q, latlon) {
      return put(GC_PREFIX + geocodeKey(q), [latlon[0], latlon[1]]);
    },
  };
}

var API = {
  slimOverpass: slimOverpass,
  expandSlim: expandSlim,
  overpassKey: overpassKey,
  geocodeKey: geocodeKey,
  cooldownRemaining: cooldownRemaining,
  makeCache: makeCache,
  DEFAULT_COOLDOWN_MS: DEFAULT_COOLDOWN_MS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof self !== 'undefined') self.NetCache = API;

})();
