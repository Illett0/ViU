'use strict';

const { parentPort, workerData } = require('worker_threads');
const { clusterPoints } = require('../lib/cluster');
const geoCache = require('../lib/geoCache');

const SCHEMA_VERSION = 2;

function report(phase, current, total) {
  parentPort.postMessage({ type: 'progress', phase, current, total });
}

function run() {
  const { points, threshold, userDataPath, fingerprint } = workerData;

  const cached = geoCache.readCache(userDataPath, fingerprint);
  const cacheValid = cached && cached.schemaVersion === SCHEMA_VERSION && cached.visitCount === points.length;
  const cachedResult = cacheValid && cached.clustersByThreshold ? cached.clustersByThreshold[String(threshold)] : null;

  let clusterResult;
  if (cachedResult) {
    report('clustering', 1, 1);
    clusterResult = cachedResult;
  } else {
    const { assignment, clusters } = clusterPoints(points, threshold, (cur, tot) => report('clustering', cur, tot));
    clusterResult = { assignment, clusters: clusters.map((c) => ({ id: c.id, lat: c.lat, lng: c.lng, count: c.count })) };

    // Only merge into the cache if a valid full cache entry already exists —
    // writing a partial entry here (without visitMuniCodes etc.) would corrupt
    // the cache for the next full parse of this same file.
    if (cacheValid) {
      cached.clustersByThreshold[String(threshold)] = clusterResult;
      geoCache.writeCache(userDataPath, fingerprint, cached);
    }
  }

  parentPort.postMessage({ type: 'done', result: clusterResult });
}

try {
  run();
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
}
