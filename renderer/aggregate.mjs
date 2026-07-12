// Pure data-aggregation helpers. No DOM access here so this stays testable
// with plain Node and reusable between the map view and the stats view.

const PRIVACY_RADIUS_METERS = 1000;
const TOKAIDO_53_KM = 490;
const MAX_DWELL_MS = 24 * 60 * 60 * 1000;
const MAX_ESTIMATION_GAP_MS = 2 * 60 * 60 * 1000; // 2h — see estimatePhotoLocations

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isNearAny(lat, lng, centers, radiusMeters) {
  if (lat == null || lng == null) return false;
  for (const c of centers) {
    if (distanceMeters(lat, lng, c.lat, c.lng) <= radiusMeters) return true;
  }
  return false;
}

// Filters the full normalized dataset down to what privacy mode allows.
// When privacyOn is false, returns the arrays unchanged (by reference).
// Other fields (pathSegments, clusters, municipalities, ...) always pass
// through unchanged via the spread — privacy for those is enforced at the
// display layer (route view disabled outright, cluster pins rounded, etc.).
function applyPrivacy(data, privacyOn) {
  if (!privacyOn) return data;

  const centers = (data.frequentPlaces || []).filter(
    (p) => p.label === 'HOME' || p.label === 'WORK'
  );
  if (centers.length === 0) return data;

  const visits = data.visits.filter((v) => !isNearAny(v.lat, v.lng, centers, PRIVACY_RADIUS_METERS));
  const activities = data.activities.filter(
    (a) =>
      !isNearAny(a.startLat, a.startLng, centers, PRIVACY_RADIUS_METERS) &&
      !isNearAny(a.endLat, a.endLng, centers, PRIVACY_RADIUS_METERS)
  );
  const pathPoints = data.pathPoints.filter((p) => !isNearAny(p[0], p[1], centers, PRIVACY_RADIUS_METERS));

  return { ...data, visits, activities, pathPoints };
}

function isInAnyZone(lat, lng, zones) {
  if (!zones || zones.length === 0 || lat == null || lng == null) return false;
  for (const z of zones) {
    if (distanceMeters(lat, lng, z.lat, z.lng) <= z.radiusMeters) return true;
  }
  return false;
}

// Splits a route segment's point list at zone boundaries, dropping the
// portion of the line inside any zone rather than the whole segment — a
// polyline that dives straight into a zone and stops is itself a giveaway,
// so we trim to the boundary instead of just omitting in-zone segments.
function trimSegmentByZones(seg, zones) {
  if (!zones || zones.length === 0) return [seg];
  const runs = [];
  let current = [];
  for (const pt of seg.points) {
    if (isInAnyZone(pt[0], pt[1], zones)) {
      if (current.length >= 2) runs.push(current);
      current = [];
    } else {
      current.push(pt);
    }
  }
  if (current.length >= 2) runs.push(current);
  return runs.map((points) => ({ ...seg, points }));
}

// User-defined "pretend this never happened" zones (e.g. home). Unlike
// applyPrivacy, this is NOT gated by the privacy toggle — it always applies —
// but it deliberately only touches display surfaces (ranking, pins, visit
// lists, route lines). Prefecture/municipality "visited" status and the
// distance/mode/monthly stats keep counting excluded visits, per spec,
// so the aggregate numbers don't develop unexplained gaps.
function applyExclusionZones(data, zones) {
  if (!zones || zones.length === 0) return { ...data, excludedVisitCount: 0 };
  const before = data.visits.length;
  const visits = data.visits.filter((v) => !isInAnyZone(v.lat, v.lng, zones));
  const pathSegments = (data.pathSegments || []).flatMap((seg) => trimSegmentByZones(seg, zones));
  return { ...data, visits, pathSegments, excludedVisitCount: before - visits.length };
}

function matchesPeriod(year, month, filter) {
  if (!filter) return true;
  if (filter.year != null && year !== filter.year) return false;
  if (filter.month != null && month !== filter.month) return false;
  return true;
}

function filterByPeriod(data, filter) {
  if (!filter || (filter.year == null && filter.month == null)) return data;
  const visits = data.visits.filter((v) => matchesPeriod(v.year, v.month, filter));
  const activities = data.activities.filter((a) => matchesPeriod(a.year, a.month, filter));
  const pathPoints = data.pathPoints.filter((p) => matchesPeriod(p[4], p[5], filter));
  const pathSegments = (data.pathSegments || []).filter((s) => matchesPeriod(s.year, s.month, filter));
  return { ...data, visits, activities, pathPoints, pathSegments };
}

function isUpToPeriod(year, month, target) {
  if (year == null || month == null) return false;
  if (year < target.year) return true;
  if (year > target.year) return false;
  return month <= target.month;
}

// "Cumulative up to and including this year-month" — used by the timelapse
// playback so the map paints progressively instead of a prefecture lighting
// up in one month and going dark again the next (which plain filterByPeriod's
// exact-match semantics would produce).
function filterUpToPeriod(data, target) {
  if (!target || target.year == null || target.month == null) return data;
  const visits = data.visits.filter((v) => isUpToPeriod(v.year, v.month, target));
  const activities = data.activities.filter((a) => isUpToPeriod(a.year, a.month, target));
  const pathPoints = data.pathPoints.filter((p) => isUpToPeriod(p[4], p[5], target));
  const pathSegments = (data.pathSegments || []).filter((s) => isUpToPeriod(s.year, s.month, target));
  return { ...data, visits, activities, pathPoints, pathSegments };
}

// Returns Map<prefCode, {code, name, stayCount, placeCount, firstEpoch, lastEpoch}>
// stayCount = total visit events (how many times you were ever there — a
// daily commute inflates this a lot). placeCount = number of *distinct*
// clusters/滞在地点 visited (see lib/cluster.js) — how many different spots
// you've actually been to, regardless of how often. The conquest-map heatmap
// and prefecture/municipality rankings are placeCount-based (per spec: a
// prefecture with 20 different places visited once each should outrank one
// where you only ever went to the same station 200 times); stayCount is kept
// alongside as a separate, still-useful stat, and the individual place-level
// ranking within a prefecture (computeClusterRanking) intentionally stays
// stayCount-based — that's "how often did I go to *this specific* spot".
function computePrefectureAggregates(data, prefectureList) {
  const byCode = new Map();
  for (const p of prefectureList) {
    byCode.set(p.code, { code: p.code, name: p.name, stayCount: 0, placeCount: 0, firstEpoch: null, lastEpoch: null });
  }

  const touch = (code, epoch) => {
    if (!code) return;
    const entry = byCode.get(code);
    if (!entry) return;
    if (epoch != null) {
      if (entry.firstEpoch == null || epoch < entry.firstEpoch) entry.firstEpoch = epoch;
      if (entry.lastEpoch == null || epoch > entry.lastEpoch) entry.lastEpoch = epoch;
    }
  };

  const clustersSeen = new Map(); // prefCode -> Set<clusterId>
  for (const v of data.visits) {
    if (!v.prefCode) continue;
    const entry = byCode.get(v.prefCode);
    if (entry) entry.stayCount += 1;
    touch(v.prefCode, v.startEpoch);
    if (v.clusterId != null) {
      let set = clustersSeen.get(v.prefCode);
      if (!set) {
        set = new Set();
        clustersSeen.set(v.prefCode, set);
      }
      set.add(v.clusterId);
    }
  }
  for (const p of data.pathPoints) {
    touch(p[3], p[2]);
  }
  for (const [prefCode, set] of clustersSeen) {
    const entry = byCode.get(prefCode);
    if (entry) entry.placeCount = set.size;
  }

  return byCode;
}

// Returns Map<muniCode, {code, name, prefCode, stayCount, placeCount, firstEpoch, lastEpoch}>.
// Unlike prefectures, municipality "visited" status is based on visits only —
// timelinePath points were never resolved to a municipality (see parseWorker).
// See computePrefectureAggregates above for what stayCount vs. placeCount mean.
function computeMunicipalityAggregates(data, municipalityList) {
  const byCode = new Map();
  for (const m of municipalityList) {
    byCode.set(m.code, { code: m.code, name: m.name, prefCode: m.prefCode, stayCount: 0, placeCount: 0, firstEpoch: null, lastEpoch: null });
  }
  const clustersSeen = new Map(); // muniCode -> Set<clusterId>
  for (const v of data.visits) {
    if (!v.muniCode) continue;
    const entry = byCode.get(v.muniCode);
    if (!entry) continue;
    entry.stayCount += 1;
    if (v.startEpoch != null) {
      if (entry.firstEpoch == null || v.startEpoch < entry.firstEpoch) entry.firstEpoch = v.startEpoch;
      if (entry.lastEpoch == null || v.startEpoch > entry.lastEpoch) entry.lastEpoch = v.startEpoch;
    }
    if (v.clusterId != null) {
      let set = clustersSeen.get(v.muniCode);
      if (!set) {
        set = new Set();
        clustersSeen.set(v.muniCode, set);
      }
      set.add(v.clusterId);
    }
  }
  for (const [muniCode, set] of clustersSeen) {
    const entry = byCode.get(muniCode);
    if (entry) entry.placeCount = set.size;
  }
  return byCode;
}

function visitedCodes(aggregates) {
  const codes = new Set();
  for (const entry of aggregates.values()) {
    if (entry.stayCount > 0 || entry.firstEpoch != null) codes.add(entry.code);
  }
  return codes;
}

// Per-prefecture municipality "conquest rate": how many of its municipalities
// have at least one visit, out of how many it has in total.
function computeConquestRates(muniAggregates, municipalityList, prefectureList) {
  const totalByPref = new Map();
  for (const m of municipalityList) {
    totalByPref.set(m.prefCode, (totalByPref.get(m.prefCode) || 0) + 1);
  }
  const visitedByPref = new Map();
  for (const entry of muniAggregates.values()) {
    if (entry.stayCount > 0) visitedByPref.set(entry.prefCode, (visitedByPref.get(entry.prefCode) || 0) + 1);
  }
  return prefectureList
    .map((p) => {
      const total = totalByPref.get(p.code) || 0;
      const visited = visitedByPref.get(p.code) || 0;
      return { code: p.code, name: p.name, visited, total, rate: total > 0 ? visited / total : 0 };
    })
    .sort((a, b) => b.rate - a.rate);
}

// Map<muniCode, {code, name, prefCode, centroid}>, for name/centroid lookups.
function buildMunicipalityIndex(municipalityList) {
  return new Map((municipalityList || []).map((m) => [m.code, m]));
}

function municipalityName(municipalityByCode, code) {
  if (!code) return '不明';
  const m = municipalityByCode && municipalityByCode.get(code);
  return m ? m.name : '不明';
}

// Shared by the prefecture-detail ranking rows and the map pin tooltips, so
// both surfaces read the on-demand Nominatim label the same way regardless
// of where it's rendered:
//   - not yet fetched / in flight -> "<muni>（取得中…）"
//   - fetched with a usable label -> "<detail>（<muni>）"
//   - fetched but nothing suitable found -> "<muni>" (unchanged fallback)
// `cacheEntry` is whatever the caller's label cache holds for this cluster:
// null/undefined (not requested yet), { status: 'pending' }, or
// { status: 'done'|'error', label: string|null }.
function formatPlaceLabel(muniName, cacheEntry) {
  if (!cacheEntry || cacheEntry.status === 'pending') return `${muniName}（取得中…）`;
  if (cacheEntry.status === 'done' && cacheEntry.label) return `${cacheEntry.label}（${muniName}）`;
  return muniName;
}

// Visit duration, capped at 24h — multi-day or clearly-broken export
// durations shouldn't blow out a dwell-time total.
function dwellMs(visit) {
  if (visit.startEpoch == null || visit.endEpoch == null || visit.endEpoch < visit.startEpoch) return 0;
  return Math.min(visit.endEpoch - visit.startEpoch, MAX_DWELL_MS);
}

// How many visits got capped, for the stats-view footnote.
function computeDwellCapNote(data) {
  let capped = 0;
  for (const v of data.visits) {
    if (v.startEpoch != null && v.endEpoch != null && v.endEpoch - v.startEpoch > MAX_DWELL_MS) capped += 1;
  }
  return { cappedCount: capped, totalVisits: data.visits.length };
}

// Groups visits by clusterId (near-duplicate GPS fixes for "the same place"
// merged at parse/recluster time — see lib/cluster.js). Under privacy mode,
// rows are further rolled up by municipality so the ranking never exposes
// more granular location detail than "which city/ward", per spec.
// sortBy: 'count' (default) or 'dwellMs'.
// The best single coordinate to represent a cluster for reverse-geocoding:
// the placeLocation of whichever placeId recurs most often within it (GPS
// jitter across visits to "the same place" is usually smaller within one
// placeId than across the whole cluster), falling back to the most frequent
// exact (lat,lng) pair when no visit in the cluster has a placeId at all.
function computeModalVisitLocation(visits) {
  if (!visits || visits.length === 0) return null;

  const byPlaceId = new Map();
  for (const v of visits) {
    if (!v.placeId) continue;
    if (!byPlaceId.has(v.placeId)) byPlaceId.set(v.placeId, []);
    byPlaceId.get(v.placeId).push(v);
  }
  if (byPlaceId.size > 0) {
    let bestGroup = null;
    for (const group of byPlaceId.values()) {
      if (!bestGroup || group.length > bestGroup.length) bestGroup = group;
    }
    return { lat: bestGroup[0].lat, lng: bestGroup[0].lng, placeId: bestGroup[0].placeId };
  }

  const byCoord = new Map();
  for (const v of visits) {
    const key = v.lat + ',' + v.lng;
    let entry = byCoord.get(key);
    if (!entry) {
      entry = { count: 0, lat: v.lat, lng: v.lng };
      byCoord.set(key, entry);
    }
    entry.count += 1;
  }
  let best = null;
  for (const entry of byCoord.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  return { lat: best.lat, lng: best.lng, placeId: null };
}

function computeClusterRanking(data, { privacy, municipalityByCode, limit, sortBy = 'count' } = {}) {
  const byCluster = new Map();
  for (const v of data.visits) {
    if (v.clusterId == null) continue;
    let entry = byCluster.get(v.clusterId);
    if (!entry) {
      entry = { clusterId: v.clusterId, count: 0, dwellMs: 0, lat: v.lat, lng: v.lng, muniCode: v.muniCode, firstEpoch: null, lastEpoch: null };
      byCluster.set(v.clusterId, entry);
    }
    entry.count += 1;
    entry.dwellMs += dwellMs(v);
    if (entry.firstEpoch == null || v.startEpoch < entry.firstEpoch) entry.firstEpoch = v.startEpoch;
    if (entry.lastEpoch == null || v.startEpoch > entry.lastEpoch) entry.lastEpoch = v.startEpoch;
  }

  let rows = [...byCluster.values()];

  if (privacy) {
    const byMuni = new Map();
    for (const r of rows) {
      const key = r.muniCode || 'unknown';
      const muni = municipalityByCode && municipalityByCode.get(r.muniCode);
      let m = byMuni.get(key);
      if (!m) {
        const centroid = muni ? muni.centroid : { lat: r.lat, lng: r.lng };
        m = { muniCode: r.muniCode, muniName: municipalityName(municipalityByCode, r.muniCode), count: 0, dwellMs: 0, lat: centroid.lat, lng: centroid.lng, firstEpoch: null, lastEpoch: null };
        byMuni.set(key, m);
      }
      m.count += r.count;
      m.dwellMs += r.dwellMs;
      if (m.firstEpoch == null || r.firstEpoch < m.firstEpoch) m.firstEpoch = r.firstEpoch;
      if (m.lastEpoch == null || r.lastEpoch > m.lastEpoch) m.lastEpoch = r.lastEpoch;
    }
    rows = [...byMuni.values()];
  } else {
    rows = rows.map((r) => ({ ...r, muniName: municipalityName(municipalityByCode, r.muniCode) }));
  }

  rows.forEach((r) => {
    r.avgDwellMs = r.count > 0 ? r.dwellMs / r.count : 0;
  });

  rows.sort((a, b) => (sortBy === 'dwellMs' ? b.dwellMs - a.dwellMs : b.count - a.count));
  return typeof limit === 'number' ? rows.slice(0, limit) : rows;
}

function computeStats(data) {
  let totalDistance = 0;
  const byMode = new Map();
  const monthly = new Map(); // key ('YYYY-MM') -> { key, total, byMode: Map }

  for (const a of data.activities) {
    totalDistance += a.distanceMeters;

    const mode = byMode.get(a.mode) || { mode: a.mode, distance: 0, count: 0, durationMs: 0 };
    mode.distance += a.distanceMeters;
    mode.count += 1;
    if (a.startEpoch != null && a.endEpoch != null && a.endEpoch >= a.startEpoch) {
      mode.durationMs += a.endEpoch - a.startEpoch;
    }
    byMode.set(a.mode, mode);

    if (a.year != null && a.month != null) {
      const key = a.year + '-' + String(a.month).padStart(2, '0');
      let entry = monthly.get(key);
      if (!entry) {
        entry = { key, total: 0, byMode: new Map() };
        monthly.set(key, entry);
      }
      entry.total += a.distanceMeters;
      entry.byMode.set(a.mode, (entry.byMode.get(a.mode) || 0) + a.distanceMeters);
    }
  }

  const byModeArr = [...byMode.values()]
    .map((m) => ({
      ...m,
      avgSpeedKmh: m.durationMs > 0 ? m.distance / 1000 / (m.durationMs / 3600000) : null,
    }))
    .sort((a, b) => b.distance - a.distance);

  const monthlyArr = [...monthly.values()]
    .map((m) => ({ key: m.key, total: m.total, byMode: Object.fromEntries(m.byMode) }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  return { totalDistance, byMode: byModeArr, monthly: monthlyArr };
}

// How many "Tokaido 53 stations" (~490km, Edo-era Tokyo-Kyoto route) worth of
// walking the user has racked up. A fun, human-scale comparison for the stats view.
function computeWalkingComparisonRatio(stats) {
  const walking = stats.byMode.find((m) => m.mode === 'WALKING');
  if (!walking) return 0;
  return walking.distance / 1000 / TOKAIDO_53_KM;
}

function computeLongestTrips(data, municipalityByCode, limit = 10) {
  return [...data.activities]
    .sort((a, b) => b.distanceMeters - a.distanceMeters)
    .slice(0, limit)
    .map((a) => ({
      distanceMeters: a.distanceMeters,
      mode: a.mode,
      dateStr: a.dateStr,
      startEpoch: a.startEpoch,
      startMuniName: municipalityName(municipalityByCode, a.startMuniCode),
      endMuniName: municipalityName(municipalityByCode, a.endMuniCode),
    }));
}

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// Average daily total distance, grouped by weekday (calendar days with zero
// activity don't count toward the average for that weekday).
function computeDayOfWeekStats(data) {
  const dailyTotals = new Map(); // dateStr -> { distance, dow }
  for (const a of data.activities) {
    if (!a.dateStr) continue;
    let entry = dailyTotals.get(a.dateStr);
    if (!entry) {
      entry = { distance: 0, dow: a.dow };
      dailyTotals.set(a.dateStr, entry);
    }
    entry.distance += a.distanceMeters;
  }

  const sums = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));
  for (const { distance, dow } of dailyTotals.values()) {
    if (dow == null) continue;
    sums[dow].total += distance;
    sums[dow].days += 1;
  }

  return sums.map((s, i) => ({ dow: i, label: DOW_LABELS[i], avgDistance: s.days > 0 ? s.total / s.days : 0 }));
}

function computeHourlyHistogram(data) {
  const counts = new Array(24).fill(0);
  for (const a of data.activities) {
    if (a.hour != null) counts[a.hour] += 1;
  }
  return counts.map((count, hour) => ({ hour, count }));
}

function computeTopDays(data, limit = 5) {
  const byDate = new Map();
  for (const a of data.activities) {
    if (!a.dateStr) continue;
    byDate.set(a.dateStr, (byDate.get(a.dateStr) || 0) + a.distanceMeters);
  }
  return [...byDate.entries()]
    .map(([dateStr, distance]) => ({ dateStr, distance }))
    .sort((a, b) => b.distance - a.distance)
    .slice(0, limit);
}

// Prefectures whose earliest-ever evidence (across the full, period-unfiltered
// but privacy-filtered dataset) falls within `year`.
function computeNewlyVisitedInYear(fullAggregates, year) {
  const result = [];
  for (const entry of fullAggregates.values()) {
    if (entry.firstEpoch == null) continue;
    const firstYear = new Date(entry.firstEpoch).getUTCFullYear();
    if (firstYear === year) result.push(entry);
  }
  return result.sort((a, b) => a.firstEpoch - b.firstEpoch);
}

// Chronology ("年表"): first-visit events for every prefecture (always) and,
// optionally, every municipality — sorted earliest-first. Each prefecture
// event carries the municipality of its earliest VISIT (if any) purely as an
// illustrative parenthetical ("初訪問（高山市）"); it may not be the exact
// municipality of that prefecture's firstEpoch if that came from a
// timelinePath point instead of a visit.
function computeChronology(data, prefAggregates, muniAggregates, municipalityByCode, { includeMunicipalities = false } = {}) {
  const earliestVisitMuniByPref = new Map();
  for (const v of data.visits) {
    if (!v.prefCode) continue;
    const existing = earliestVisitMuniByPref.get(v.prefCode);
    if (!existing || v.startEpoch < existing.epoch) {
      earliestVisitMuniByPref.set(v.prefCode, { epoch: v.startEpoch, muniCode: v.muniCode });
    }
  }

  const events = [];
  for (const entry of prefAggregates.values()) {
    if (entry.firstEpoch == null) continue;
    const muniHint = earliestVisitMuniByPref.get(entry.code);
    events.push({
      type: 'prefecture',
      code: entry.code,
      name: entry.name,
      epoch: entry.firstEpoch,
      muniHintName: muniHint ? municipalityName(municipalityByCode, muniHint.muniCode) : null,
    });
  }
  if (includeMunicipalities) {
    for (const entry of muniAggregates.values()) {
      if (entry.firstEpoch == null) continue;
      events.push({ type: 'municipality', code: entry.code, name: entry.name, prefCode: entry.prefCode, epoch: entry.firstEpoch, muniHintName: null });
    }
  }

  return events.sort((a, b) => a.epoch - b.epoch);
}

// Binary-search `sortedVisits` (ascending by startEpoch, endEpoch required)
// for one whose [startEpoch, endEpoch] contains `epoch` — i.e. the person was
// stationary at that visit's location at that exact moment. Mirrors
// worker/parseWorker.js's findContainingActivity, applied to visits instead.
function findContainingVisit(sortedVisits, epoch) {
  if (sortedVisits.length === 0 || epoch == null) return null;
  let lo = 0;
  let hi = sortedVisits.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sortedVisits[mid].startEpoch <= epoch) lo = mid;
    else hi = mid - 1;
  }
  const v = sortedVisits[lo];
  return v && v.startEpoch <= epoch && v.endEpoch >= epoch ? v : null;
}

// Binary-search `sortedSamples` (ascending by epoch) for whichever sample is
// closest in time to `epoch`, checking both neighbors around the insertion
// point (the nearer one isn't necessarily the last one <= epoch).
function findNearestSample(sortedSamples, epoch) {
  if (sortedSamples.length === 0 || epoch == null) return null;
  let lo = 0;
  let hi = sortedSamples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedSamples[mid].epoch < epoch) lo = mid + 1;
    else hi = mid;
  }
  let best = sortedSamples[lo];
  let bestGap = Math.abs(best.epoch - epoch);
  if (lo > 0) {
    const prevGap = Math.abs(sortedSamples[lo - 1].epoch - epoch);
    if (prevGap < bestGap) {
      best = sortedSamples[lo - 1];
      bestGap = prevGap;
    }
  }
  return { lat: best.lat, lng: best.lng, gapMs: bestGap };
}

// Stage 3: for photos with no Exif/Takeout GPS, estimate a location by
// cross-referencing the photo's taken-at timestamp against the timeline's
// own movement record. Two tiers, strongest signal first:
//   1. The photo was taken during a `visit` (stationary at one place for a
//      known [startEpoch, endEpoch] span) — use that visit's coordinates
//      exactly, no time gap.
//   2. Otherwise, fall back to the nearest timestamped location sample
//      (timelinePath points, plus activity start/end points for the gaps
//      timelinePath doesn't cover) within `maxGapMs` of the photo. Beyond
//      that gap the estimate would be guessing, so the photo is left
//      without a location, same as before this feature existed.
// Estimated photos are tagged `source: 'estimated'` (vs. 'exif'/'takeout')
// and carry `estimationGapMs` so the UI can show how rough the guess is —
// they must stay visually distinguishable from real GPS data, never silently
// presented as fact.
function estimatePhotoLocations(data, photos, { maxGapMs = MAX_ESTIMATION_GAP_MS } = {}) {
  if (!data || !photos.some((p) => !p.hasLocation)) return photos;

  const sortedVisits = data.visits
    .filter((v) => v.startEpoch != null && v.endEpoch != null)
    .sort((a, b) => a.startEpoch - b.startEpoch);

  const samples = [];
  for (const p of data.pathPoints) {
    if (p[2] != null) samples.push({ epoch: p[2], lat: p[0], lng: p[1] });
  }
  for (const a of data.activities) {
    if (a.startEpoch != null && a.startLat != null) samples.push({ epoch: a.startEpoch, lat: a.startLat, lng: a.startLng });
    if (a.endEpoch != null && a.endLat != null) samples.push({ epoch: a.endEpoch, lat: a.endLat, lng: a.endLng });
  }
  for (const v of sortedVisits) {
    samples.push({ epoch: v.startEpoch, lat: v.lat, lng: v.lng });
  }
  samples.sort((a, b) => a.epoch - b.epoch);

  return photos.map((photo) => {
    if (photo.hasLocation || photo.takenAtMs == null) return photo;

    const visit = findContainingVisit(sortedVisits, photo.takenAtMs);
    if (visit) {
      return { ...photo, lat: visit.lat, lng: visit.lng, hasLocation: true, source: 'estimated', estimationGapMs: 0 };
    }

    const nearest = findNearestSample(samples, photo.takenAtMs);
    if (nearest && nearest.gapMs <= maxGapMs) {
      return { ...photo, lat: nearest.lat, lng: nearest.lng, hasLocation: true, source: 'estimated', estimationGapMs: nearest.gapMs };
    }

    return photo;
  });
}

export {
  PRIVACY_RADIUS_METERS,
  TOKAIDO_53_KM,
  MAX_DWELL_MS,
  MAX_ESTIMATION_GAP_MS,
  estimatePhotoLocations,
  distanceMeters,
  applyPrivacy,
  isInAnyZone,
  applyExclusionZones,
  filterByPeriod,
  filterUpToPeriod,
  computePrefectureAggregates,
  computeMunicipalityAggregates,
  computeConquestRates,
  visitedCodes,
  buildMunicipalityIndex,
  computeModalVisitLocation,
  municipalityName,
  formatPlaceLabel,
  dwellMs,
  computeDwellCapNote,
  computeClusterRanking,
  computeStats,
  computeWalkingComparisonRatio,
  computeLongestTrips,
  computeDayOfWeekStats,
  computeHourlyHistogram,
  computeTopDays,
  computeNewlyVisitedInYear,
  computeChronology,
};
