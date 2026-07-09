// Leaflet-based map rendering: national heatmap choropleth (prefecture or
// municipality granularity) + prefecture drill-down.

import { formatPlaceLabel } from './aggregate.mjs';

// Single-hue sequential blue for the choropleth (visit-count intensity), kept
// deliberately far in hue from the orange pins/markers below so pins never
// blend into the fill. Unvisited areas sit at low-saturation grey so they
// recede rather than compete with the data.
const UNVISITED_COLOR = '#e0e0e0';
const HEAT_LOW = [222, 235, 247]; // #deebf7
const HEAT_HIGH = [8, 81, 156]; // #08519c
const PATH_ONLY_COLOR = '#deebf7'; // lightest tier: "passed through, never stayed"

const DEFAULT_BORDER_COLOR = '#151820';
const SELECTED_BORDER_COLOR = '#ff7f0e';
const BASE_FILL_OPACITY = 0.7;
const DIMMED_FILL_OPACITY = 0.4; // used once pins/markers are on top, so they stay legible

const MARKER_FILL_COLOR = '#ff7f0e';
const MARKER_BORDER_COLOR = '#ffffff';

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function colorForIntensity(t) {
  const [r1, g1, b1] = HEAT_LOW;
  const [r2, g2, b2] = HEAT_HIGH;
  const r = Math.round(lerp(r1, r2, t));
  const g = Math.round(lerp(g1, g2, t));
  const b = Math.round(lerp(b1, b2, t));
  return `rgb(${r}, ${g}, ${b})`;
}

// Heatmap intensity is based on placeCount (distinct 滞在地点/clusters
// visited), not stayCount (total visit events) — a prefecture you've been to
// 20 different places in should read "more explored" than one where you've
// only ever visited the same station 200 times on a commute. See
// aggregate.mjs's computePrefectureAggregates/computeMunicipalityAggregates.
function maxPlaceCount(aggregates) {
  let max = 0;
  for (const entry of aggregates.values()) {
    if (entry.placeCount > max) max = entry.placeCount;
  }
  return max;
}

function fillColorFor(entry, max) {
  const visited = entry && (entry.stayCount > 0 || entry.firstEpoch != null);
  if (!visited) return UNVISITED_COLOR;
  if (entry.placeCount > 0 && max > 0) {
    const t = Math.log1p(entry.placeCount) / Math.log1p(max);
    return colorForIntensity(t);
  }
  return PATH_ONLY_COLOR;
}

export function initMap(containerEl) {
  const map = L.map(containerEl, {
    center: [36.5, 138],
    zoom: 5,
    minZoom: 4,
    worldCopyJump: false,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);

  // Prefecture/municipality choropleth polygons are torn down and rebuilt as
  // a brand-new L.geoJSON layer on nearly every render, which re-inserts
  // them at the end of the default overlayPane's DOM — i.e. visually and
  // interactively *above* anything already there, including the cluster
  // marker layerGroup (created once and reused). That silently stole clicks
  // meant for 訪問地点 pins (see renderClusterMarkers). A dedicated pane with
  // a higher z-index than the default overlayPane (400) guarantees markers
  // always hit-test above any polygon layer, regardless of which one was
  // most recently recreated — more robust than relying on bringToFront()
  // call ordering between renders.
  map.createPane('clusterMarkerPane');
  map.getPane('clusterMarkerPane').style.zIndex = 620;

  return map;
}

export function applyPrivacyZoomLimit(map, privacyOn) {
  // Privacy mode now allows zooming in to municipality level (city/ward
  // boundaries visible) but not street/building level.
  const cap = privacyOn ? 12 : 18;
  map.setMaxZoom(cap);
  if (map.getZoom() > cap) map.setZoom(cap);
}

// `selectedCode` (the prefecture currently drilled into, if any) is shown via
// a heavier orange border rather than a fill-color change, so the fill's
// meaning (visit-count intensity) stays consistent everywhere. `dimmed`
// lowers fill opacity while cluster pins are on top of it, so the pins read
// clearly instead of blending into the choropleth.
export function renderNational(map, geojsonLayerRef, geojson, aggregates, onClickPrefecture, { selectedCode = null, dimmed = false } = {}) {
  if (geojsonLayerRef.layer) {
    map.removeLayer(geojsonLayerRef.layer);
    geojsonLayerRef.layer = null;
  }

  const max = maxPlaceCount(aggregates);
  const fillOpacity = dimmed ? DIMMED_FILL_OPACITY : BASE_FILL_OPACITY;

  const layer = L.geoJSON(geojson, {
    style: (feature) => {
      const entry = aggregates.get(feature.properties.code);
      const isSelected = selectedCode != null && feature.properties.code === selectedCode;
      return {
        color: isSelected ? SELECTED_BORDER_COLOR : DEFAULT_BORDER_COLOR,
        weight: isSelected ? 3 : 1,
        fillColor: fillColorFor(entry, max),
        fillOpacity,
      };
    },
    onEachFeature: (feature, lyr) => {
      const entry = aggregates.get(feature.properties.code);
      const placeCount = entry ? entry.placeCount : 0;
      const isSelected = selectedCode != null && feature.properties.code === selectedCode;
      lyr.bindTooltip(`${feature.properties.name}（訪問地点 ${placeCount} 件）`, { className: 'pref-tooltip' });
      // Leaflet's SVG renderer paints features in the order they were added,
      // so a thick highlighted border can get partially painted-over by a
      // later-drawn neighbouring prefecture along their shared edge — the
      // "枠線が上下でおかしい" z-order bug. bringToFront() re-stacks this
      // feature above all its siblings so the border reads as one continuous
      // outline regardless of draw order.
      if (isSelected) lyr.bringToFront();
      lyr.on('click', () => onClickPrefecture(feature.properties.code));
      lyr.on('mouseover', () => {
        lyr.bringToFront();
        lyr.setStyle({ weight: isSelected ? 3 : 2, color: SELECTED_BORDER_COLOR });
      });
      lyr.on('mouseout', () => lyr.setStyle({ weight: isSelected ? 3 : 1, color: isSelected ? SELECTED_BORDER_COLOR : DEFAULT_BORDER_COLOR }));
    },
  }).addTo(map);

  geojsonLayerRef.layer = layer;
  // Fitting the viewport is app.mjs's call (it only re-fits on an actual
  // navigation change, not on every redraw) — see the `fit` gate in
  // renderMapTab. Doing it here unconditionally would re-snap to all of
  // Japan even while zoomed into a prefecture/cluster.
}

// ---- Municipality-granularity choropleth (national, viewport-culled; and
// single-prefecture, unculled since a prefecture has at most ~60 municipalities) ----

function ensureFeatureBounds(feature) {
  if (feature.__bounds) return feature.__bounds;
  const geom = feature.geometry;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  let bounds = null;
  for (const poly of polys) {
    for (const [lng, lat] of poly[0]) {
      if (!bounds) bounds = L.latLngBounds([lat, lng], [lat, lng]);
      else bounds.extend([lat, lng]);
    }
  }
  feature.__bounds = bounds;
  return bounds;
}

function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInFeature(lat, lng, feature) {
  const geom = feature.geometry;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  // Administrative-boundary polygons here have no interior holes, so only
  // the exterior ring needs checking.
  return polys.some((poly) => pointInRing(lat, lng, poly[0]));
}

// Exact (not nearest-centroid) municipality lookup for an arbitrary point,
// using the same GeoJSON already loaded for the granularity toggle. Used for
// user-placed exclusion zones / HOME-WORK suggestions, where an approximate
// answer could name the wrong ward near a boundary.
export function findMunicipalityCodeForPoint(muniGeoJSON, lat, lng) {
  for (const feature of muniGeoJSON.features) {
    if (!ensureFeatureBounds(feature).contains([lat, lng])) continue;
    if (pointInFeature(lat, lng, feature)) return feature.properties.code;
  }
  return null;
}

function buildMunicipalityLayer(features, aggregates, onClickMuni, { dimmed = false } = {}) {
  const max = maxPlaceCount(aggregates);
  const fillOpacity = dimmed ? DIMMED_FILL_OPACITY : BASE_FILL_OPACITY;
  return L.geoJSON(
    { type: 'FeatureCollection', features },
    {
      style: (feature) => {
        const entry = aggregates.get(feature.properties.code);
        return { color: DEFAULT_BORDER_COLOR, weight: 0.6, fillColor: fillColorFor(entry, max), fillOpacity };
      },
      onEachFeature: (feature, lyr) => {
        const entry = aggregates.get(feature.properties.code);
        const placeCount = entry ? entry.placeCount : 0;
        lyr.bindTooltip(`${feature.properties.name}（訪問地点 ${placeCount} 件）`, { className: 'pref-tooltip' });
        lyr.on('click', () => onClickMuni(feature.properties.code));
        // Same z-order fix as the prefecture layer (see renderNational) — a
        // hovered ward's thicker border would otherwise get partly hidden
        // under whichever neighbouring ward happens to be drawn later.
        lyr.on('mouseover', () => {
          lyr.bringToFront();
          lyr.setStyle({ weight: 1.5, color: SELECTED_BORDER_COLOR });
        });
        lyr.on('mouseout', () => lyr.setStyle({ weight: 0.6, color: DEFAULT_BORDER_COLOR }));
      },
    }
  );
}

// Renders only municipalities whose bbox intersects the current viewport —
// with ~1,894 features nationwide this keeps redraw cheap. Call again on the
// map's 'moveend'/'zoomend' events (wired by the caller) to keep it current.
// `full: true` (used during timelapse playback) bypasses the viewport culling
// entirely and draws every municipality nationwide — otherwise, whatever
// region happened to be in view (or off-frame) when playback started stays
// the only part of the country that visibly updates each tick, which reads
// as "the rest of Japan isn't playing back" even though the underlying
// cumulative aggregates are correct.
export function renderNationalMunicipality(map, layerRef, muniGeojson, aggregates, onClickMuni, { dimmed = false, full = false } = {}) {
  if (layerRef.layer) {
    map.removeLayer(layerRef.layer);
    layerRef.layer = null;
  }
  const visible = full ? muniGeojson.features : muniGeojson.features.filter((f) => map.getBounds().pad(0.25).intersects(ensureFeatureBounds(f)));
  const layer = buildMunicipalityLayer(visible, aggregates, onClickMuni, { dimmed }).addTo(map);
  layerRef.layer = layer;
}

// A single prefecture has few enough municipalities that no culling is needed.
export function renderPrefectureMunicipality(map, layerRef, muniGeojson, prefCode, aggregates, onClickMuni, { dimmed = false } = {}) {
  if (layerRef.layer) {
    map.removeLayer(layerRef.layer);
    layerRef.layer = null;
  }
  const features = muniGeojson.features.filter((f) => f.properties.prefCode === prefCode);
  const layer = buildMunicipalityLayer(features, aggregates, onClickMuni, { dimmed }).addTo(map);
  layerRef.layer = layer;
}

// ---- Mainland-bbox zoom (avoids zooming out to include distant islands) ----

function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function mainlandRing(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates[0];
  let best = null;
  let bestArea = -1;
  for (const poly of geometry.coordinates) {
    const area = ringArea(poly[0]);
    if (area > bestArea) {
      bestArea = area;
      best = poly[0];
    }
  }
  return best;
}

// Bounds of the prefecture's largest polygon only (its "mainland"), not the
// full multi-polygon bbox — otherwise fitting to it zooms out to include the
// Ogasawara Islands for Tokyo, and similarly for Kagoshima/Okinawa/Hokkaido.
// The caller fits the map to this and can also use it to detect out-of-frame
// (island) visits to offer a jump-to-island link.
export function mainlandBounds(feature) {
  const ring = mainlandRing(feature.geometry);
  return L.latLngBounds(ring.map(([lng, lat]) => [lat, lng]));
}

export function clearMarkers(markerLayerRef) {
  if (markerLayerRef.layer) {
    markerLayerRef.layer.clearLayers();
  }
}

// `rows` come from computeClusterRanking(): under privacy mode these are
// already rolled up to one row per municipality (positioned at the
// municipality's representative point), otherwise one row per visit cluster.
// `labelCache` (Map<clusterId, {status, label}>) is optional — passing it
// makes the tooltip read the same on-demand Nominatim label as the ranking
// list (via the shared formatPlaceLabel), instead of just the muni name.
// Returns Map<row-key, marker> so the caller can push a label update into an
// already-open tooltip later, once its fetch resolves.
export function renderClusterMarkers(map, markerLayerRef, rows, onClickRow, labelCache = null) {
  if (!markerLayerRef.layer) {
    markerLayerRef.layer = L.layerGroup().addTo(map);
  }
  markerLayerRef.layer.clearLayers();

  const markersByKey = new Map();

  for (const row of rows) {
    const marker = L.circleMarker([row.lat, row.lng], {
      radius: 6 + Math.min(10, Math.log1p(row.count) * 3),
      color: MARKER_BORDER_COLOR,
      weight: 2,
      fillColor: MARKER_FILL_COLOR,
      fillOpacity: 0.9,
      // Own pane (see initMap) with a higher z-index than the default
      // overlayPane polygons render into — guarantees this pin is always on
      // top and clickable, regardless of which polygon layer was most
      // recently torn down and rebuilt on top of it in DOM order.
      pane: 'clusterMarkerPane',
    });
    const key = row.clusterId ?? 'muni:' + row.muniCode;
    const labelEntry = labelCache && row.clusterId != null ? labelCache.get(row.clusterId) : null;
    const nameLabel = row.muniName ? formatPlaceLabel(row.muniName, labelEntry) : '';
    marker.bindTooltip(`${nameLabel ? nameLabel + ' — ' : ''}滞在 ${row.count} 回`);
    marker.on('click', () => onClickRow(row));
    marker.addTo(markerLayerRef.layer);
    markersByKey.set(key, marker);
  }

  // The municipality polygon overlay is torn down and rebuilt as a brand-new
  // L.geoJSON layer on every render (renderPrefectureMunicipality), which
  // re-appends it to the end of the overlay pane's DOM — i.e. visually and
  // interactively *above* whatever was already there. This marker layerGroup,
  // by contrast, is created once and reused (only its children are cleared),
  // so its DOM position never moves. Net effect: the very first time you
  // enter a prefecture, markers happen to be added after the polygons (so
  // clicks work), but every render after that (e.g. selecting a place) the
  // freshly-rebuilt polygon layer ends up on top, silently swallowing clicks
  // meant for the pins underneath — the "訪問地点選択中に他の地点がクリックできない"
  // bug. Explicitly re-stacking every marker above whatever polygons exist
  // *this render* fixes it regardless of creation order.
  markerLayerRef.layer.eachLayer((l) => l.bringToFront());

  return markersByKey;
}
