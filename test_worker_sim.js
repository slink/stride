/* test_worker_sim.js — end-to-end: drive worker.js's onmessage with an
 * Overpass payload and assert what it postMessages back. Run from this dir:
 * `node test_worker_sim.js`.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./coverage_core.js');
const MI = 1609.344;

// Load worker.js in a sandbox that captures postMessage and stubs importScripts.
const msgs = [];
const sandbox = { CoverageCore: C, postMessage: m => msgs.push(m), onmessage: null };
const workerPath = path.join(__dirname, 'worker.js');
const code = fs.readFileSync(workerPath, 'utf8').replace("importScripts('./coverage_core.js');", '');
new Function('self', 'importScripts', code)(sandbox, () => {});

// Build a 14x10 grid as Overpass ways (nodes shared between crossing ways).
const elements = []; const idg = {}; let nid = 1;
const rows = 14, cols = 10;
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  idg[r + ',' + c] = nid; elements.push({ type: 'node', id: nid, lat: 40.720 + r * 0.0026, lon: -73.995 + c * 0.0042 }); nid++;
}
let wid = 900000;
for (let r = 0; r < rows; r++) elements.push({ type: 'way', id: wid++, nodes: Array.from({ length: cols }, (_, c) => idg[r + ',' + c]) });
for (let c = 0; c < cols; c++) elements.push({ type: 'way', id: wid++, nodes: Array.from({ length: rows }, (_, r) => idg[r + ',' + c]) });

sandbox.onmessage({ data: { overpass: { elements }, maxMeters: 5 * MI, startLat: 40.720, startLon: -73.995, cluster: true } });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('worker emits building -> solving -> done phases in order', () => {
  const phases = msgs.filter(m => m.phase).map(m => m.phase);
  assert.deepEqual(phases, ['building', 'solving', 'done']);
});

test('worker reports no error', () => {
  assert.equal(msgs.some(m => m.error), false, msgs.find(m => m.error)?.error);
});

test('every run is within the cap', () => {
  const done = msgs.find(m => m.phase === 'done');
  assert.equal(done.result.runs.every(r => r.length_mi <= 5.001), true);
});

test('first run starts near the requested start corner', () => {
  const c0 = msgs.find(m => m.phase === 'done').result.runs[0].coords[0];
  assert.equal(Math.abs(c0[0] - 40.720) < 0.001 && Math.abs(c0[1] + 73.995) < 0.001, true, `started at [${c0}]`);
});

test('coverage is complete: every grid edge appears in the plan', () => {
  const done = msgs.find(m => m.phase === 'done');
  const planE = new Set();
  for (const run of done.result.runs) for (let i = 0; i + 1 < run.coords.length; i++) {
    const a = run.coords[i].join(','), b = run.coords[i + 1].join(',');
    planE.add(a < b ? a + '|' + b : b + '|' + a);
  }
  const expected = rows * (cols - 1) + cols * (rows - 1);
  assert.equal(planE.size >= expected, true, `expected ${expected} edges, plan has ${planE.size}`);
});

test('worker reports an error for an empty area', () => {
  const empty = [];
  const s2 = { CoverageCore: C, postMessage: m => empty.push(m), onmessage: null };
  new Function('self', 'importScripts', code)(s2, () => {});
  s2.onmessage({ data: { overpass: { elements: [] }, maxMeters: 5 * MI, cluster: true } });
  assert.equal(empty.some(m => m.error), true, 'empty payload should yield an error message');
});

test('worker fetches elevations (when enabled) and reports climb', async () => {
  const out = [];
  const s = { CoverageCore: C, postMessage: m => out.push(m), onmessage: null };
  new Function('self', 'importScripts', code)(s, () => {});
  // stub Open-Elevation: elevation rises with latitude, so there is real gain
  global.fetch = async (url, opts) => {
    const { locations } = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ results: locations.map(l => ({ elevation: Math.round((l.latitude - 40.72) * 100000) })) }) };
  };
  try {
    await s.onmessage({ data: { overpass: { elements }, maxMeters: 5 * MI, startLat: 40.720, startLon: -73.995, cluster: false, elevation: true } });
  } finally { delete global.fetch; }
  const done = out.find(m => m.phase === 'done');
  assert.equal(out.some(m => m.phase === 'elevation'), true, 'emits an elevation phase');
  assert.equal(typeof done.result.stats.total_gain_m, 'number', 'total climb is computed');
  assert.equal(done.result.stats.total_gain_m > 0, true, 'varied terrain yields positive gain');
});

test('worker continues (elevation null) when the elevation fetch fails', async () => {
  const out = [];
  const s = { CoverageCore: C, postMessage: m => out.push(m), onmessage: null };
  new Function('self', 'importScripts', code)(s, () => {});
  global.fetch = async () => ({ ok: false, status: 503 });
  try {
    await s.onmessage({ data: { overpass: { elements }, maxMeters: 5 * MI, cluster: false, elevation: true } });
  } finally { delete global.fetch; }
  const done = out.find(m => m.phase === 'done');
  assert.equal(out.some(m => m.phase === 'elevation_failed'), true, 'signals the failure');
  assert.equal(done && !out.some(m => m.error), true, 'still produces a plan');
  assert.equal(done.result.stats.total_gain_m, null, 'no elevation -> null, not a wrong number');
});

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok   ${t.name}`); pass++; }
    catch (e) { console.log(`  FAIL ${t.name}\n         ${e.message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
