# STR1DE — client-side street coverage planner

Generates running routes that cover every street in an area, each under a
chosen length, minimizing repeats — **entirely in the browser**. No backend.

Solves a length-limited Chinese Postman / Capacitated Arc Routing problem
with start-point anchoring. By default it solves one global circuit and splits
it into runs; optional geographic clustering groups runs into colored zones.

## Run it

It's static files. Serve the folder (a server is needed because the app uses
a Web Worker and fetch):

```bash
cd stride
python3 -m http.server 8000
# open http://localhost:8000
```

Type an address, pick max run length + radius, hit **Plan my runs**.
Each run gets a **GPX** download (or "Download all GPX") for your watch.
**Demo mode** runs a precomputed sample with no network needed.
Tick **Include elevation** to fetch per-node elevation (Open-Elevation) and
report total climb per run and overall; GPX then carries `<ele>` per point.

## How it works (all client-side)

1. **Geocode** address → lat/lon via Nominatim.
2. **Fetch streets** within radius via the Overpass API (raw OSM ways/nodes).
3. **Build graph** + **solve** inside a **Web Worker** (`worker.js`) so the UI never freezes.
   Before solving, mid-block **degree-2 shape points are contracted** into
   super-edges (typically ~10x fewer nodes on real OSM data), so the per-odd-node
   Dijkstras in matching run on intersections only; GPX still traces full geometry.
4. **Render** runs on Leaflet; **export** GPX per run.

## Files

- `coverage_core.js` — the solver (graph, degree-2 contraction, augmentation, Euler circuit, clustering, GPX). Runs in browser + Node.
- `worker.js` — Web Worker: Overpass JSON → graph → plan.
- `index.html` — UI.
- `demo.json` — offline sample.
- `test_core.js`, `test_overpass.js`, `test_worker_sim.js` — assertion-based
  Node tests (exit non-zero on failure). Run all: `node test_all.js`.
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

## Honest limits

- **Heuristic, not optimal.** Odd-node matching is **greedy nearest**, not
  optimal Blossom. Greedy is ~10–13% longer *as a matching*, but the matching
  is a small slice of total distance, so optimal Blossom would recover only
  ~1% of route length (measured in `attribution.js`). Not worth the complexity
  here — the dominant overhead was zoning, not matching.
- **Real-city overhead is ~15% on irregular areas** (vs ~5% on clean grids):
  covering every street honestly requires some deadhead between odd junctions.
  "Miles run" will exceed "street miles" by this much — expected, not a bug.
  (Optional `cluster:true` zoning adds ~5–7% on top for grouped runs; it was
  the default until measurement showed it costs overhead for no compactness
  gain — see `attribution.js`.)
- **Big radii = big Overpass payloads** and slower solves. Keep radius modest
  in dense cities; the worker keeps the UI responsive but solving still takes time.
- **Public Overpass/Nominatim have usage limits.** For a real launch, use your
  own Overpass instance and a paid geocoder, and cache results.
- **Elevation is off by default and best-effort.** It POSTs every node to the
  public Open-Elevation API in batches — slow on big areas, and the public
  instance is rate-limited and sometimes down. On any failure the plan still
  completes with climb shown as "–" (null, never a fabricated 0). The worker
  accepts an `elevationUrl` override for a self-hosted endpoint.
