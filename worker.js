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

self.onmessage = (e) => {
  const { overpass, maxMeters, startLat, startLon, cluster } = e.data;
  try {
    self.postMessage({ phase: 'building' });
    const G = graphFromOverpass(overpass);
    if (G.adj.size === 0) { self.postMessage({ error: 'No streets found in that area. Try a larger radius.' }); return; }
    self.postMessage({ phase: 'solving' });
    const result = C.planRuns(G, maxMeters, { startLat, startLon, cluster });
    self.postMessage({ phase: 'done', result });
  } catch (err) {
    self.postMessage({ error: String(err && err.message || err) });
  }
};
