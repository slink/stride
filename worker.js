/* worker.js — runs graph-build + solve off the main thread. */
importScripts('./coverage_core.js');
const C = self.CoverageCore;

/* Build a graph from raw Overpass JSON (elements: node + way). */
function graphFromOverpass(data) {
  const G = C.makeGraph();
  const nodeLL = new Map();
  for (const el of data.elements) if (el.type === 'node') nodeLL.set(el.id, [el.lat, el.lon]);
  // only keep nodes that are used by ways; set them as we encounter ways
  for (const el of data.elements) {
    if (el.type !== 'way' || !el.nodes) continue;
    for (let i = 0; i + 1 < el.nodes.length; i++) {
      const a = el.nodes[i], b = el.nodes[i + 1];
      const pa = nodeLL.get(a), pb = nodeLL.get(b);
      if (!pa || !pb) continue;
      C.setNode(G, a, pa[0], pa[1]);
      C.setNode(G, b, pb[0], pb[1]);
      const len = C.haversine(pa[0], pa[1], pb[0], pb[1]);
      if (len > 0) C.addEdge(G, a, b, len);
    }
  }
  return G;
}

/* Fetch elevations for every node from Open-Elevation and store them on the
 * node objects, so gain/loss is summed through mid-block shape points. Batched
 * to keep request bodies reasonable. Best-effort: the caller continues without
 * elevation if this throws. */
async function fetchElevations(G, endpoint) {
  const ids = [...G.nodes.keys()];
  const BATCH = 500;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const locations = chunk.map(id => { const p = G.nodes.get(id); return { latitude: p.lat, longitude: p.lon }; });
    const r = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations }),
    });
    if (!r.ok) throw new Error('elevation HTTP ' + r.status);
    const data = await r.json();
    (data.results || []).forEach((res, j) => { const n = G.nodes.get(chunk[j]); if (n && typeof res.elevation === 'number') n.ele = res.elevation; });
  }
}

self.onmessage = async (e) => {
  const { overpass, maxMeters, startLat, startLon, cluster, elevation,
          elevationUrl = 'https://api.open-elevation.com/api/v1/lookup' } = e.data;
  try {
    self.postMessage({ phase: 'building' });
    const G = graphFromOverpass(overpass);
    if (G.adj.size === 0) { self.postMessage({ error: 'No streets found in that area. Try a larger radius.' }); return; }
    if (elevation) {
      try { self.postMessage({ phase: 'elevation' }); await fetchElevations(G, elevationUrl); }
      catch (err) { self.postMessage({ phase: 'elevation_failed', detail: String(err && err.message || err) }); }
    }
    self.postMessage({ phase: 'solving' });
    const result = C.planRuns(G, maxMeters, { startLat, startLon, cluster });
    self.postMessage({ phase: 'done', result });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
