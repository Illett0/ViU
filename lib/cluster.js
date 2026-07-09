'use strict';

// Greedy distance-based clustering of visit points (DBSCAN-with-minPts=1 style):
// two visits are connected if they are within `thresholdMeters` of each other,
// or share the same placeId regardless of distance. Connected components become
// clusters; the cluster's representative point is the centroid of its members.

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class UnionFind {
  constructor(n) {
    this.parent = new Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(i) {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

// points: array of { lat, lng, placeId }
// onProgress(current, total): optional callback for coarse progress reporting
// Returns { assignment: Int32Array-like (clusterId per input index), clusters: [{ id, lat, lng, count, memberIndices }] }
function clusterPoints(points, thresholdMeters, onProgress) {
  const n = points.length;
  const uf = new UnionFind(n);

  // Same placeId -> always same cluster, regardless of distance.
  const byPlaceId = new Map();
  for (let i = 0; i < n; i++) {
    const pid = points[i].placeId;
    if (!pid) continue;
    if (byPlaceId.has(pid)) uf.union(byPlaceId.get(pid), i);
    else byPlaceId.set(pid, i);
  }

  // Degree-margin quick reject: at these latitudes, 1 degree of longitude is
  // always >= ~0.6 degrees of latitude in meters, so a plain degree-delta
  // bounding check (cheap) before the real haversine call is a safe prefilter.
  const thresholdDeg = thresholdMeters / 111000 + 0.001;

  const progressEvery = Math.max(1, Math.floor(n / 50));
  for (let i = 0; i < n; i++) {
    const a = points[i];
    for (let j = i + 1; j < n; j++) {
      const b = points[j];
      if (Math.abs(a.lat - b.lat) > thresholdDeg || Math.abs(a.lng - b.lng) > thresholdDeg) continue;
      if (uf.find(i) === uf.find(j)) continue;
      if (haversineMeters(a.lat, a.lng, b.lat, b.lng) <= thresholdMeters) uf.union(i, j);
    }
    if (onProgress && (i % progressEvery === 0 || i === n - 1)) onProgress(i + 1, n);
  }

  const groups = new Map(); // root -> memberIndices[]
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const assignment = new Array(n);
  const clusters = [];
  let clusterId = 0;
  for (const memberIndices of groups.values()) {
    let sumLat = 0;
    let sumLng = 0;
    for (const idx of memberIndices) {
      sumLat += points[idx].lat;
      sumLng += points[idx].lng;
      assignment[idx] = clusterId;
    }
    clusters.push({
      id: clusterId,
      lat: sumLat / memberIndices.length,
      lng: sumLng / memberIndices.length,
      count: memberIndices.length,
      memberIndices,
    });
    clusterId += 1;
  }

  return { assignment, clusters };
}

module.exports = { clusterPoints, haversineMeters };
