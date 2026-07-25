# STR1DE — client-side street coverage planner

Generates running routes that cover every street in an area, each under a
chosen length, minimizing repeats — **entirely in the browser**. No backend.

![STR1DE coverage plan for Cooper Square, Manhattan](screenshot.jpg)

*A real plan: Cooper Square, Manhattan — 1.2 mi radius, 5 mi max run. **106 runs,
523.3 miles run to cover 440.2 street miles** (+18.9% repeat overhead). Each
color is one run.*

## Export to your watch

Every run downloads as GPX, and "Download all GPX" grabs the set. This is
actual output from the plan above — run 1, 4.96 mi, 323 track points:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="STR1DE" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>STR1DE Run 1</name><trkseg>
      <trkpt lat="40.7279594" lon="-73.9913474"></trkpt>
      <trkpt lat="40.728498" lon="-73.991198"></trkpt>
      <trkpt lat="40.7286131" lon="-73.9912244"></trkpt>
      <!-- … 320 more … -->
  </trkseg></trk>
</gpx>
```

Tick **Include elevation** and each `<trkpt>` also carries `<ele>`. Drop the
file on a Garmin/Coros/Suunto watch, or import it into Strava.

## Run it

It's static files. Serve the folder (a server is needed because the app uses
a Web Worker and fetch):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000, type an address, pick max run length + radius,
and hit **Plan my runs**. **Demo mode** runs a precomputed sample with no
network at all.

## How it works (all client-side)

1. **Geocode** address → lat/lon via Nominatim (once, on submit).
2. **Fetch streets** within radius via the Overpass API (raw OSM ways/nodes).
3. **Build graph** + **solve** inside a **Web Worker** (`worker.js`) so the UI never freezes.
   Before solving, mid-block **degree-2 shape points are contracted** into
   super-edges (typically ~10x fewer nodes on real OSM data), so the per-odd-node
   Dijkstras in matching run on intersections only; GPX still traces full geometry.
4. **Render** runs on Leaflet; **export** GPX per run.

## Public OSM infrastructure

STR1DE runs on **volunteer-funded services** — Nominatim for geocoding,
Overpass for street data, CARTO for basemap tiles, Open-Elevation for climb.
Nobody is paid to serve your queries. The operators publish usage policies, and
this app is built to stay inside them:

| Their rule | What STR1DE does |
|---|---|
| Nominatim: *"an absolute maximum of 1 request per second"* | One geocode per explicit submit, then cached |
| Nominatim: *"Auto-complete search … you must not implement such a service on the client side"* | No keystroke handler on the address field — geocoding only fires on submit |
| Nominatim: *"Results must be cached on your side"* | Geocode results cached in `localStorage` |
| Nominatim / OSM: *"Clearly display attribution as suitable for your medium"* | Credit in the sidebar and on the map |
| Overpass: *"a maximum of about 10000 requests per day … below about 1 GB per day"* | Responses cached for 7 days; a 60 s cooldown between network fetches |

**Caching.** A query at the default settings (1.2 mi, walk) returns about
**7 MB** of JSON — roughly 42,000 elements. That does not fit in `localStorage`
(~5 MB per origin, stored as UTF-16), so responses are reduced to the fields the
graph builder actually reads (node coordinates and way node-refs — tags are
filtered server-side anyway) and delta-coded as integers at OSM's native 1e7
precision. That same area becomes **0.94 MB, a 7.5x reduction, losslessly**:
rebuilding the graph from cache yields an identical node count, edge count, and
total length. In practice about two dense-city areas fit at once (two cached
Manhattan areas measured 3.8 MB of quota), so entries are evicted
least-recently-used when the quota is hit, and an area too large to cache is
simply not cached rather than breaking the plan.

**Rate limiting.** After a network fetch, the plan button is disabled for 60 s
with a countdown. The timestamp lives in `localStorage`, so reloading the page
does not reset it. Replanning an area that is already cached is exempt — it
costs no request, so it stays instant.

**Identification.** A browser *cannot* set `User-Agent` — it is a forbidden
header name, and a custom header would trigger a CORS preflight, doubling the
request count. Nominatim's policy accepts the alternative: *"Provide a valid
HTTP Referer **or** User-Agent identifying the application."* The browser sends
`Referer` automatically, which is what identifies this app.

**If you fork this and expect real traffic, run your own Overpass instance and
use a paid geocoder.** The public endpoints are a courtesy, not a backend.

## Files

- `coverage_core.js` — the solver (graph, degree-2 contraction, augmentation, Euler circuit, clustering, GPX). Runs in browser + Node.
- `net_cache.js` — response cache, slim/delta encoding, and cooldown arithmetic.
- `worker.js` — Web Worker: Overpass JSON → graph → plan.
- `index.html` — UI.
- `demo.json` — offline sample.
- `test_core.js`, `test_overpass.js`, `test_worker_sim.js`, `test_net_cache.js` —
  assertion-based Node tests (exit non-zero on failure). Run all: `node test_all.js`.
- `attribution.js`, `measure_partition.js` — diagnostics behind the overhead
  and zoning decisions (not part of the app).

## Development

Tests run on `bun` (or `node`): `bun test_all.js`. A pre-commit hook lints
(whitespace + JS syntax) and runs the suite. Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

## Verified

- Coverage is **complete** — every street appears in the plan (tested; an
  early version dropped streets at zone boundaries — fixed by assigning every
  edge to exactly one zone and solving all components within it).
- Every run respects the max-length cap — with one unavoidable exception: a
  single street segment longer than the cap becomes its own (over-cap) run,
  since edges are atomic and can't be split mid-street. Pinned by a test.
- Start anchoring: the first run begins at the intersection nearest the address.
- Matches the Python reference on clean grids (11 runs / +5% identical).
- The cache round-trip is lossless on real OSM data — same nodes, same edges,
  same total length to the last digit.

## Honest limits

- **Heuristic, not optimal.** Odd-node matching is **greedy nearest**, not
  optimal Blossom. Greedy is ~10–13% longer *as a matching*, but the matching
  is a small slice of total distance, so optimal Blossom would recover only
  ~1% of route length (measured in `attribution.js`). Not worth the complexity
  here — the dominant overhead was zoning, not matching.
- **Real-city overhead is ~15–19% on irregular areas** (vs ~5% on clean grids):
  covering every street honestly requires some deadhead between odd junctions.
  "Miles run" will exceed "street miles" by this much — expected, not a bug.
  (Optional `cluster:true` zoning adds ~5–7% on top for grouped runs; it was
  the default until measurement showed it costs overhead for no compactness
  gain — see `attribution.js`.)
- **Big radii are slow.** The Manhattan plan above took minutes of solve time in
  the worker, not seconds — the payload is large and the matching is quadratic in
  odd nodes. The UI stays responsive, but keep the radius modest in dense cities.
- **Elevation is off by default and best-effort.** It POSTs every node to the
  public Open-Elevation API in batches — slow on big areas, and the public
  instance is rate-limited and sometimes down. On any failure the plan still
  completes with climb shown as "–" (null, never a fabricated 0). The worker
  accepts an `elevationUrl` override for a self-hosted endpoint.
- **The cooldown is per-browser, not global.** It stops one tab from hammering
  Overpass; it cannot stop a hundred forks from doing so.
