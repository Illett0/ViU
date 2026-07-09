// Separate Leaflet map instance for the "経路マップ" (route map) view: draws
// timelinePath segments as polylines, colored by the transport mode borrowed
// from the nearest activity in time (see worker/parseWorker.js).

// Design: 電車・地下鉄・路面電車 share one color family (red), バス・タクシー
// share another (blue) — both deliberate per-family groupings. Every other
// mode gets its own distinct color rather than being folded into one of
// those two families (in particular 車/IN_PASSENGER_VEHICLE used to share the
// bus/taxi blue, which made it impossible to tell a car trip from a bus trip
// on the map — it now gets its own purple).
const MODE_COLORS = {
  WALKING: '#4caf50', // green
  RUNNING: '#2e7d32', // dark green — same "on foot" hue as walking, but distinguishable
  CYCLING: '#8bc34a', // light green
  IN_PASSENGER_VEHICLE: '#9467bd', // purple — car, kept separate from bus/taxi
  IN_TAXI: '#2f6fbf', // blue family (darker shade) — grouped with bus
  IN_BUS: '#4da3ff', // blue family — grouped with taxi
  IN_TRAIN: '#e05263', // red family
  IN_SUBWAY: '#c62839', // red family (darker shade)
  IN_TRAM: '#ff8a80', // red family (lighter shade)
  FLYING: '#5c6bc0', // indigo
  IN_FERRY: '#26a69a', // teal
  IN_GONDOLA_LIFT: '#d4a017', // amber — ropeway/cable car, distinct from car
};
const DEFAULT_MODE_COLOR = '#8a8f9c'; // gray, catch-all "other" (UNKNOWN etc.)

function colorForMode(mode) {
  return MODE_COLORS[mode] || DEFAULT_MODE_COLOR;
}

export function initRouteMap(containerEl) {
  const map = L.map(containerEl, {
    center: [36.5, 138],
    zoom: 5,
    minZoom: 4,
    worldCopyJump: false,
    // Canvas rendering handles the several-thousand polylines a busy year can
    // produce far more smoothly than Leaflet's default SVG renderer, which
    // matters now that mode-accurate rendering can split one raw path
    // segment into several polylines (see MAX_SEGMENTS_TO_RENDER below).
    preferCanvas: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);

  return map;
}

// Guard against handing Leaflet a pathological number of polylines at once.
// This used to be 4000 with index-based sampleEvenly() dropping whatever
// didn't fit — since pathSegments are in chronological order, that dropped
// entire trips at random and was itself a source of visible "途切れ" (route
// breaks) once a filtered year's segment count crept past the cap (worse
// now that mode-accurate rendering can split one raw segment into several —
// see worker/parseWorker.js). With the canvas renderer (see initRouteMap)
// several thousand polylines render smoothly, so the cap is raised well
// past any realistic single-year count and sampleEvenly is kept only as a
// last-resort safety net, not a normal code path.
const MAX_SEGMENTS_TO_RENDER = 20000;

function sampleEvenly(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

// Returns the number of segments actually drawn (after any sampling), or 0.
export function renderRoute(map, layerRef, pathSegments) {
  if (layerRef.layer) {
    map.removeLayer(layerRef.layer);
    layerRef.layer = null;
  }

  const segments = sampleEvenly(pathSegments, MAX_SEGMENTS_TO_RENDER);
  const group = L.layerGroup();

  for (const seg of segments) {
    if (!seg.points || seg.points.length < 2) continue;
    // `inferred` segments are a straight line synthesized between an
    // activity's start/end coordinates because no detailed GPS trace exists
    // for that trip — drawn dashed and slightly more transparent so they
    // read as "approximate" rather than a real recorded path.
    const style = seg.inferred
      ? { color: colorForMode(seg.mode), weight: 3, opacity: 0.55, dashArray: '6 6' }
      : { color: colorForMode(seg.mode), weight: 3, opacity: 0.75 };
    L.polyline(seg.points, style).addTo(group);
  }

  group.addTo(map);
  layerRef.layer = group;

  const allPoints = segments.flatMap((s) => s.points || []);
  if (allPoints.length > 0) {
    map.fitBounds(L.latLngBounds(allPoints), { padding: [20, 20] });
  }

  return segments.length;
}

export function clearRoute(map, layerRef) {
  if (layerRef.layer) {
    map.removeLayer(layerRef.layer);
    layerRef.layer = null;
  }
}

export { colorForMode, MODE_COLORS };
