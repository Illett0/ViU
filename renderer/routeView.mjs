// Separate Leaflet map instance for the "経路マップ" (route map) view: draws
// timelinePath segments as polylines, colored by the transport mode borrowed
// from the nearest activity in time (see worker/parseWorker.js).

import { addZoomControl } from './mapView.mjs';

// Design: 電車・地下鉄・路面電車 share one color family (red), バス・タクシー
// share another (blue) — both deliberate per-family groupings (shades within
// a family are told apart by label/tooltip, not by color). Every other
// family gets its own hue.
//
// Family hues were validated with the dataviz palette validator (OKLab ΔE,
// protan/deutan/tritan simulation, WCAG contrast) rather than eyeballed:
// walk-green / rail-red / bus-blue / car-amber / plane-violet clear the
// normal-vision floor (ΔE >= 15) and >= 3:1 contrast against the white line
// casing used by the day view. The previous palette failed both — 車 purple
// vs タクシー blue were ΔE 1.5 apart for protanopes, and 徒歩/バス were
// ~2.3:1 against the map tiles. The remaining color-blind-weak pairs
// (rail-red vs walk-green / car-amber, ΔE 6-7) are backed by a second,
// non-color encoding: on-foot modes draw dotted and rail draws with a
// railway-style center stripe (see LINE_PATTERN / renderDayRoute).
const MODE_COLORS = {
  WALKING: '#008300', // green
  RUNNING: '#006400', // dark green — same "on foot" family as walking
  CYCLING: '#4d8a00', // yellow-green
  IN_PASSENGER_VEHICLE: '#c98500', // amber — car, kept separate from bus/taxi
  IN_TAXI: '#1f5aa8', // blue family (darker shade) — grouped with bus
  IN_BUS: '#2a78d6', // blue family
  IN_TRAIN: '#e34948', // red family
  IN_SUBWAY: '#b62e2d', // red family (darker shade)
  IN_TRAM: '#d9534f', // red family
  FLYING: '#4a3aa7', // violet
  IN_FERRY: '#0e8a74', // teal
  IN_GONDOLA_LIFT: '#d55181', // magenta — ropeway/cable car (rare)
};
const DEFAULT_MODE_COLOR = '#75736e'; // gray, catch-all "other" (UNKNOWN etc.)

// Non-color line encoding per mode family, so identity never rests on hue
// alone (see the palette note above).
const ON_FOOT_MODES = new Set(['WALKING', 'RUNNING']);
const RAIL_MODES = new Set(['IN_TRAIN', 'IN_SUBWAY', 'IN_TRAM']);
function linePattern(mode) {
  if (ON_FOOT_MODES.has(mode)) return 'dotted';
  if (RAIL_MODES.has(mode)) return 'rail';
  return 'solid';
}

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
    zoomControl: false,
  });
  addZoomControl(map);

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

// ---- Day view (one day's route, see routeTab.mjs openDayView) ----
// Few enough segments that each can afford a white casing underneath (keeps
// every hue >= 3:1 against busy map tiles), a mode-specific pattern, and a
// hover tooltip. Returns, per input segment index, the layers drawn for it so
// the caller can highlight a segment from the timeline list.
const DAY_WEIGHT = 5;
const DAY_CASING_WEIGHT = 9;

function formatClock(epoch) {
  if (epoch == null) return '';
  const d = new Date(epoch);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function renderDayRoute(map, layerRef, segments, { labelFor }) {
  clearRoute(map, layerRef);
  const group = L.layerGroup();
  const layersBySegment = [];

  segments.forEach((seg) => {
    const layers = [];
    layersBySegment.push(layers);
    if (!seg.points || seg.points.length < 2) return;
    const color = colorForMode(seg.mode);
    const pattern = linePattern(seg.mode);
    const tip = `${labelFor(seg.mode)}${seg.inferred ? '（推定区間）' : ''}${seg.trimmed ? '（除外ゾーン外の部分）' : ''} ${formatClock(seg.startEpoch)}–${formatClock(seg.endEpoch)}`;

    const casing = L.polyline(seg.points, {
      color: '#ffffff',
      weight: DAY_CASING_WEIGHT,
      opacity: seg.inferred ? 0.6 : 0.95,
      lineCap: 'round',
      lineJoin: 'round',
    });
    const baseWeight = pattern === 'dotted' ? DAY_WEIGHT + 1 : DAY_WEIGHT;
    const main = L.polyline(seg.points, {
      color,
      weight: baseWeight,
      baseWeight, // read back by routeTab.mjs's highlightItem
      opacity: seg.inferred ? 0.75 : 1,
      lineCap: 'round',
      lineJoin: 'round',
      // Dotted (on foot) vs dashed (estimated) stay distinguishable: round
      // dots vs long dashes.
      dashArray: seg.inferred ? '12 9' : pattern === 'dotted' ? '0.1 10' : null,
      interactive: false,
    });
    layers.push(casing, main);
    if (pattern === 'rail' && !seg.inferred) {
      layers.push(L.polyline(seg.points, { color: '#ffffff', weight: 1.5, opacity: 0.9, dashArray: '6 6', interactive: false }));
    }
    // The casing is the (wider) hit target for the whole segment.
    casing.bindTooltip(tip, { sticky: true });
    layers.forEach((l) => l.addTo(group));
  });

  group.addTo(map);
  layerRef.layer = group;
  return layersBySegment;
}

// Small inline SVG sample of a mode's line (color + pattern), for legends and
// the timeline list — mirrors renderDayRoute's styling.
export function lineSampleSvg(mode, { inferred = false } = {}) {
  const color = colorForMode(mode);
  const pattern = linePattern(mode);
  const dash = inferred ? 'stroke-dasharray="6 4"' : pattern === 'dotted' ? 'stroke-dasharray="0.1 6"' : '';
  const stripe = pattern === 'rail' && !inferred ? '<line x1="4" y1="7" x2="30" y2="7" stroke="#fff" stroke-width="1.2" stroke-dasharray="3 3"/>' : '';
  return (
    `<svg class="line-sample" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true" focusable="false">` +
    `<line x1="4" y1="7" x2="30" y2="7" stroke="#fff" stroke-width="8" stroke-linecap="round"/>` +
    `<line x1="4" y1="7" x2="30" y2="7" stroke="${color}" stroke-width="${pattern === 'dotted' ? 5 : 4}" stroke-linecap="round" ${dash}/>` +
    stripe +
    `</svg>`
  );
}

export { colorForMode, MODE_COLORS, formatClock };
