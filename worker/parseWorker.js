'use strict';

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { findPrefecture, getPrefectureList } = require('../lib/prefectures');
const { findMunicipality, getMunicipalityList } = require('../lib/municipalities');
const { clusterPoints } = require('../lib/cluster');
const { parseLatLng } = require('../lib/coords');
const geoCache = require('../lib/geoCache');

// Bump whenever the shape of cached data (below) changes, so stale caches
// from an older version of this file are ignored instead of misread.
const SCHEMA_VERSION = 2;
const DEFAULT_CLUSTER_THRESHOLD = 50;

function report(phase, current, total) {
  parentPort.postMessage({ type: 'progress', phase, current, total });
}

// Converts an epoch (ms) + a UTC offset into a JST-independent "local
// calendar" year/month/date/hour/weekday, so filtering and the
// behavior-pattern stats don't depend on the host machine's timezone.
function localPartsFromEpoch(epoch, offsetMinutes) {
  if (epoch == null || Number.isNaN(epoch)) return null;
  const offset = typeof offsetMinutes === 'number' ? offsetMinutes : 540;
  const shifted = new Date(epoch + offset * 60000);
  return {
    epoch,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    dateStr: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    dow: shifted.getUTCDay(),
  };
}

function localParts(isoString, offsetMinutes) {
  return localPartsFromEpoch(Date.parse(isoString), offsetMinutes);
}

// The source export uses several vehicle/activity type enum values whose
// Google-side naming doesn't map 1:1 to what we want to show (see
// renderer/statsView.mjs MODE_LABELS and renderer/routeView.mjs MODE_COLORS
// for the human-facing side of this). Only real synonyms get canonicalized
// here — IN_TAXI and IN_GONDOLA_LIFT are kept as their own distinct types
// since they get their own label/color, not folded into IN_PASSENGER_VEHICLE.
function canonicalizeMode(mode) {
  if (mode === 'UNKNOWN_ACTIVITY_TYPE') return 'UNKNOWN';
  return mode;
}

// Binary search for the activity whose startEpoch is closest to targetEpoch.
// `activities` must be sorted ascending by startEpoch. Used as a fallback for
// path points that don't fall inside any activity's own time range (e.g.
// while genuinely stationary, or in a data gap between segments).
function findNearestActivity(activities, targetEpoch) {
  if (activities.length === 0 || targetEpoch == null) return null;
  let lo = 0;
  let hi = activities.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (activities[mid].startEpoch < targetEpoch) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [activities[lo]];
  if (lo > 0) candidates.push(activities[lo - 1]);
  candidates.sort((a, b) => Math.abs(a.startEpoch - targetEpoch) - Math.abs(b.startEpoch - targetEpoch));
  return candidates[0];
}

// Binary search for the activity whose [startEpoch, endEpoch] range actually
// contains targetEpoch. `activities` must be sorted ascending by startEpoch
// and (per the source format) shouldn't overlap. This is preferred over
// findNearestActivity wherever possible: a single timelinePath "segment" as
// exported by Google is a coarse, fixed-width time bucket (commonly ~2h) that
// can span several real trips/activities, so matching by raw closeness in
// time to the segment's own declared start can pick the wrong activity for
// points well inside the segment. Containment by the point's own timestamp
// is far more reliable.
function findContainingActivity(activities, targetEpoch) {
  if (activities.length === 0 || targetEpoch == null) return null;
  let lo = 0;
  let hi = activities.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (activities[mid].startEpoch <= targetEpoch) lo = mid;
    else hi = mid - 1;
  }
  const a = activities[lo];
  if (a && a.startEpoch <= targetEpoch && (a.endEpoch == null || targetEpoch <= a.endEpoch)) return a;
  return null;
}

function run() {
  const { filePath, userDataPath } = workerData;

  report('reading', 0, 1);
  const raw = fs.readFileSync(filePath, 'utf-8');

  report('parsing', 0, 1);
  const data = JSON.parse(raw);
  const segments = Array.isArray(data.semanticSegments) ? data.semanticSegments : [];
  const userLocationProfile = data.userLocationProfile || {};
  // rawSignals is intentionally dropped here and never touched again (memory: source file is 50MB+).

  const total = segments.length;
  const visits = [];
  const activities = [];
  const pathPoints = [];
  const pathSegments = [];

  const progressEvery = Math.max(1, Math.floor(total / 200));

  for (let i = 0; i < total; i++) {
    const seg = segments[i];

    if (seg.visit) {
      const top = seg.visit.topCandidate || {};
      const coords = parseLatLng(top.placeLocation && top.placeLocation.latLng);
      if (coords) {
        const parts = localParts(seg.startTime, seg.startTimeTimezoneUtcOffsetMinutes);
        const pref = findPrefecture(coords.lat, coords.lng);
        visits.push({
          placeId: top.placeId || null,
          semanticType: top.semanticType || null,
          probability: typeof seg.visit.probability === 'number' ? seg.visit.probability : null,
          lat: coords.lat,
          lng: coords.lng,
          prefCode: pref ? pref.code : 0,
          muniCode: null, // filled in below, after the main loop
          clusterId: null, // filled in below, after the main loop
          startEpoch: parts ? parts.epoch : null,
          endEpoch: Date.parse(seg.endTime) || null,
          year: parts ? parts.year : null,
          month: parts ? parts.month : null,
          dateStr: parts ? parts.dateStr : null,
        });
      }
    } else if (seg.activity) {
      const act = seg.activity;
      const startCoords = parseLatLng(act.start && act.start.latLng);
      const endCoords = parseLatLng(act.end && act.end.latLng);
      const parts = localParts(seg.startTime, seg.startTimeTimezoneUtcOffsetMinutes);
      const startPref = startCoords ? findPrefecture(startCoords.lat, startCoords.lng) : null;
      const endPref = endCoords ? findPrefecture(endCoords.lat, endCoords.lng) : null;
      const endEpoch = Date.parse(seg.endTime);
      activities.push({
        mode: canonicalizeMode((act.topCandidate && act.topCandidate.type) || 'UNKNOWN'),
        distanceMeters: typeof act.distanceMeters === 'number' ? act.distanceMeters : 0,
        startEpoch: parts ? parts.epoch : null,
        endEpoch: Number.isNaN(endEpoch) ? null : endEpoch,
        year: parts ? parts.year : null,
        month: parts ? parts.month : null,
        dateStr: parts ? parts.dateStr : null,
        hour: parts ? parts.hour : null,
        dow: parts ? parts.dow : null,
        startLat: startCoords ? startCoords.lat : null,
        startLng: startCoords ? startCoords.lng : null,
        endLat: endCoords ? endCoords.lat : null,
        endLng: endCoords ? endCoords.lng : null,
        startPrefCode: startPref ? startPref.code : 0,
        endPrefCode: endPref ? endPref.code : 0,
        startMuniCode: null, // filled in below
        endMuniCode: null,
      });
    } else if (seg.timelinePath) {
      const segParts = localParts(seg.startTime, seg.startTimeTimezoneUtcOffsetMinutes);
      const points = [];
      for (const p of seg.timelinePath) {
        const coords = parseLatLng(p.point);
        if (!coords) continue;
        const epoch = Date.parse(p.time);
        const parts = localParts(p.time, seg.startTimeTimezoneUtcOffsetMinutes);
        const pref = findPrefecture(coords.lat, coords.lng);
        // Compact tuple form: [lat, lng, epoch, prefCode, year, month]
        pathPoints.push([
          coords.lat,
          coords.lng,
          Number.isNaN(epoch) ? null : epoch,
          pref ? pref.code : 0,
          parts ? parts.year : null,
          parts ? parts.month : null,
        ]);
        // Keep the per-point epoch (and the segment's own tz offset, needed to
        // re-derive local year/month per run below) — [lat, lng, epoch].
        points.push([coords.lat, coords.lng, Number.isNaN(epoch) ? null : epoch]);
      }
      if (points.length > 0) {
        pathSegments.push({
          tzOffsetMinutes: seg.startTimeTimezoneUtcOffsetMinutes,
          points, // mode-split into the final per-run segments below
        });
      }
    }
    // timelineMemory segments are ignored per spec.

    if (i % progressEvery === 0 || i === total - 1) {
      report('normalizing', i + 1, total);
    }
  }

  // ---- Municipality lookup + default clustering, disk-cached per source file ----

  const fingerprint = geoCache.computeFingerprint(filePath);
  const cached = geoCache.readCache(userDataPath, fingerprint);
  const cacheValid =
    cached &&
    cached.schemaVersion === SCHEMA_VERSION &&
    cached.visitCount === visits.length &&
    cached.activityCount === activities.length;

  let visitMuniCodes;
  let activityMuniCodes; // [{start, end}, ...]

  if (cacheValid && cached.visitMuniCodes && cached.activityMuniCodes) {
    visitMuniCodes = cached.visitMuniCodes;
    activityMuniCodes = cached.activityMuniCodes;
    report('municipality', visits.length + activities.length * 2, visits.length + activities.length * 2);
  } else {
    visitMuniCodes = [];
    activityMuniCodes = [];
    const totalLookups = visits.length + activities.length * 2;
    let done = 0;
    const lookupEvery = Math.max(1, Math.floor(totalLookups / 100));

    for (const v of visits) {
      const m = findMunicipality(v.lat, v.lng);
      visitMuniCodes.push(m ? m.code : null);
      done += 1;
      if (done % lookupEvery === 0) report('municipality', done, totalLookups);
    }
    for (const a of activities) {
      const ms = a.startLat != null ? findMunicipality(a.startLat, a.startLng) : null;
      const me = a.endLat != null ? findMunicipality(a.endLat, a.endLng) : null;
      activityMuniCodes.push({ start: ms ? ms.code : null, end: me ? me.code : null });
      done += 2;
      if (done % lookupEvery === 0) report('municipality', done, totalLookups);
    }
    report('municipality', totalLookups, totalLookups);
  }

  visits.forEach((v, i) => {
    v.muniCode = visitMuniCodes[i] || null;
  });
  activities.forEach((a, i) => {
    a.startMuniCode = activityMuniCodes[i] ? activityMuniCodes[i].start : null;
    a.endMuniCode = activityMuniCodes[i] ? activityMuniCodes[i].end : null;
  });

  let clusterResult;
  const cachedClusters = cacheValid && cached.clustersByThreshold ? cached.clustersByThreshold[String(DEFAULT_CLUSTER_THRESHOLD)] : null;
  if (cachedClusters) {
    clusterResult = cachedClusters;
    report('clustering', 1, 1);
  } else {
    const points = visits.map((v) => ({ lat: v.lat, lng: v.lng, placeId: v.placeId }));
    const { assignment, clusters } = clusterPoints(points, DEFAULT_CLUSTER_THRESHOLD, (cur, tot) => report('clustering', cur, tot));
    clusterResult = { assignment, clusters: clusters.map((c) => ({ id: c.id, lat: c.lat, lng: c.lng, count: c.count })) };
  }

  visits.forEach((v, i) => {
    v.clusterId = clusterResult.assignment[i];
  });

  // Persist/refresh the cache (always rewrite so activityMuniCodes/visitCount
  // stay in sync even if only the cluster threshold was previously cached).
  const clustersByThreshold = (cacheValid && cached.clustersByThreshold) || {};
  clustersByThreshold[String(DEFAULT_CLUSTER_THRESHOLD)] = clusterResult;
  geoCache.writeCache(userDataPath, fingerprint, {
    schemaVersion: SCHEMA_VERSION,
    visitCount: visits.length,
    activityCount: activities.length,
    visitMuniCodes,
    activityMuniCodes,
    clustersByThreshold,
  });

  // ---- Assign a transport mode to each route-map path point, then group
  // consecutive same-mode points into draw-ready segments. ----
  //
  // activities and timelinePath segments are siblings in the source export,
  // not a single combined record, so the mode has to be borrowed from the
  // activities list. A raw timelinePath "segment" is a coarse, fixed-width
  // time bucket (commonly ~2h) that can contain several real trips — e.g. a
  // short walk to the station followed by a train ride — so matching mode
  // once per whole segment (against whichever activity's declared start time
  // happens to be closest) previously painted the entire bucket with a single
  // wrong mode. Matching per point, preferring the activity whose own
  // [startEpoch, endEpoch] actually contains that point's timestamp, fixes
  // that; findNearestActivity is kept only as a fallback for points that
  // don't fall inside any activity's time range at all.
  const activitiesSorted = [...activities].sort((a, b) => (a.startEpoch || 0) - (b.startEpoch || 0));
  const coveredActivities = new Set();
  const finalPathSegments = [];

  function pushRun(mode, runPoints, tzOffsetMinutes) {
    if (!runPoints || runPoints.length < 2) return;
    const startEpoch = runPoints[0][2];
    const endEpoch = runPoints[runPoints.length - 1][2];
    const startParts = localPartsFromEpoch(startEpoch, tzOffsetMinutes);
    finalPathSegments.push({
      startEpoch,
      endEpoch,
      year: startParts ? startParts.year : null,
      month: startParts ? startParts.month : null,
      dateStr: startParts ? startParts.dateStr : null,
      mode,
      inferred: false,
      points: runPoints.map((p) => [p[0], p[1]]),
    });
  }

  // A raw timelinePath "segment" is itself just an arbitrary ~2h time bucket
  // Google happens to chunk the export into — it has no real-world meaning
  // (a single train ride or highway drive commonly spans two buckets). The
  // loop below used to reset the run at every bucket boundary regardless of
  // whether the trip actually continued, which chopped an otherwise-genuine
  // continuous GPS trace into two separate polylines with a visible gap
  // between them purely because of where Google happened to split the
  // export — confirmed empirically (see harness investigation) against a
  // real ~51MB export: of ~6,600 segment-boundary transitions, 52 showed a
  // >1.5km jump in <=10min with identical transport mode on both sides and a
  // travel speed consistent with that mode continuing uninterrupted (e.g.
  // 9.4km in 7min on a train) — i.e. an artificial break, not a real one.
  // Flattening all raw buckets into one continuous point stream (they're
  // already chronological, same as the source export) and only starting a
  // new run on an actual mode change OR a large time gap (still catches
  // genuine data gaps / day boundaries) fixes this.
  const MAX_RUN_GAP_MS = 20 * 60 * 1000; // 20min — comfortably above the observed 2-8min false breaks, well below genuine gaps (which run hours)
  let runMode = null;
  let runPoints = [];
  let runTzOffset = null;
  let lastEpoch = null;
  for (const seg of pathSegments) {
    for (const p of seg.points) {
      const epoch = p[2];
      const containing = findContainingActivity(activitiesSorted, epoch);
      let mode;
      if (containing) {
        mode = containing.mode;
        coveredActivities.add(containing);
      } else {
        const nearest = findNearestActivity(activitiesSorted, epoch);
        mode = nearest ? nearest.mode : 'UNKNOWN';
      }

      const gapFromLast = lastEpoch != null && epoch != null ? epoch - lastEpoch : 0;
      const shouldBreak = runMode !== null && (mode !== runMode || gapFromLast > MAX_RUN_GAP_MS);

      if (runMode === null) {
        runMode = mode;
        runTzOffset = seg.tzOffsetMinutes;
        runPoints.push(p);
      } else if (!shouldBreak) {
        runPoints.push(p);
      } else {
        // Mode changed (or too much time passed to still call this one
        // continuous run): include this point as the shared boundary vertex
        // of both the outgoing and incoming run, so same-mode transitions
        // still connect with no visual gap. A genuine large time gap still
        // ends the run without stitching anything across it.
        runPoints.push(p);
        pushRun(runMode, runPoints, runTzOffset);
        runMode = mode;
        runTzOffset = seg.tzOffsetMinutes;
        runPoints = [p];
      }
      if (epoch != null) lastEpoch = epoch;
    }
  }
  pushRun(runMode, runPoints, runTzOffset);

  // Some activities (trips) have no timelinePath coverage at all in the
  // source export — Google sometimes records only the coarse start/end of a
  // trip without a detailed GPS trace for it — which previously meant that
  // trip was simply invisible on the route map (a visible "break" in the
  // route with no indication anything happened there). For any such
  // uncovered activity that does have start/end coordinates, synthesize a
  // straight two-point line between them, flagged `inferred: true` so the
  // renderer can draw it distinctly (e.g. dashed) from real GPS traces.
  for (const a of activities) {
    if (coveredActivities.has(a)) continue;
    if (a.startLat == null || a.startLng == null || a.endLat == null || a.endLng == null) continue;
    finalPathSegments.push({
      startEpoch: a.startEpoch,
      endEpoch: a.endEpoch,
      year: a.year,
      month: a.month,
      dateStr: a.dateStr,
      mode: a.mode,
      inferred: true,
      points: [
        [a.startLat, a.startLng],
        [a.endLat, a.endLng],
      ],
    });
  }

  finalPathSegments.sort((a, b) => (a.startEpoch || 0) - (b.startEpoch || 0));

  const frequentPlaces = (userLocationProfile.frequentPlaces || [])
    .filter((p) => p.label)
    .map((p) => {
      const coords = parseLatLng(p.placeLocation);
      return {
        placeId: p.placeId || null,
        label: p.label,
        lat: coords ? coords.lat : null,
        lng: coords ? coords.lng : null,
      };
    })
    .filter((p) => p.lat != null);

  report('finalizing', 1, 1);

  parentPort.postMessage({
    type: 'done',
    result: {
      fingerprint,
      prefectures: getPrefectureList(),
      municipalities: getMunicipalityList(),
      visits,
      activities,
      pathPoints,
      pathSegments: finalPathSegments,
      clusters: clusterResult.clusters,
      frequentPlaces,
    },
  });
}

try {
  run();
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
}
