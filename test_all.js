/* test_all.js — run every test suite, exit non-zero if any fails.
 * Run: `node test_all.js` (or `bun test_all.js`).
 */
'use strict';
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const suites = ['test_core.js', 'test_overpass.js', 'test_worker_sim.js', 'test_net_cache.js'];
let failed = 0;
for (const s of suites) {
  console.log(`\n### ${s}`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nall suites passed');
process.exit(failed ? 1 : 0);
