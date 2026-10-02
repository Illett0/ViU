// 経路マップ tab and the per-day route modal (滞在日 -> その日の経路).

import { clearMarkers } from './mapView.mjs';
import { initRouteMap, renderRoute, clearRoute, colorForMode } from './routeView.mjs';
import { renderPhotoLayer, clearPhotoLayer } from './photoView.mjs';
import { modeLabel } from './statsView.mjs';
import { applyPrivacy, applyExclusionZones, municipalityName } from './aggregate.mjs';
import { dayViewLayerRef, dayViewMarkerLayerRef, el, routeLayerRef, routePhotoLayerRef, state, ui } from './context.mjs';
import { getVisiblePhotos, openPhotoLightbox, resolvePlaceName } from './photos.mjs';
import { getDerived } from './app.mjs';

// Which transport modes are currently toggled off in the route map legend —
// module-level (not part of `state`) since it's a pure display filter for
// this tab, not something that should reset navigation or be undo/redo-able.
// Not reset on file reload deliberately... actually it should be, since mode
// names are stable across imports; left as-is between renders within a
// session is fine.
export const routeHiddenModes = new Set();

export function renderRouteTab(derived) {
  if (!ui.routeMap) ui.routeMap = initRouteMap(el.routeMapDiv);
  ui.routeMap.invalidateSize();

  // Rendered unconditionally (before the "no route data" early-return below)
  // — photos for the current period can exist even when there's no route
  // data to draw (e.g. a period with photos but no GPS trace that day).
  if (state.photoLayerVisible) {
    renderPhotoLayer(ui.routeMap, routePhotoLayerRef, getVisiblePhotos(), { resolvePlaceName, onOpenLightbox: openPhotoLightbox });
  } else {
    clearPhotoLayer(ui.routeMap, routePhotoLayerRef);
  }

  // No longer requires a year filter — with mode-accurate rendering the
  // full-history segment count (~8-9k) comfortably fits under routeView's
  // render cap, so "all periods" is just another period to draw.
  const segments = derived.displayData.pathSegments || [];

  if (segments.length === 0) {
    el.routeMessage.hidden = false;
    el.routeMessage.textContent = 'この期間に表示できる経路データがありません。';
    clearRoute(ui.routeMap, routeLayerRef);
    el.routeLegend.innerHTML = '';
    return;
  }

  el.routeMessage.hidden = true;

  const visibleSegments = routeHiddenModes.size > 0 ? segments.filter((s) => !routeHiddenModes.has(s.mode)) : segments;
  renderRoute(ui.routeMap, routeLayerRef, visibleSegments);

  // Legend is built from *all* modes present in the period (not just visible
  // ones) so a hidden mode's toggle stays clickable to bring it back.
  const modesUsed = [...new Set(segments.map((s) => s.mode))];
  const legendItems = modesUsed.map((m) => {
    const hidden = routeHiddenModes.has(m);
    return `<span class="legend-item legend-item-mode${hidden ? ' mode-hidden' : ''}" data-mode="${m}"><span class="legend-swatch" style="background:${colorForMode(m)}"></span>${modeLabel(m)}</span>`;
  });
  // Segments synthesized from an activity's start/end coords (no detailed GPS
  // trace was available for that trip) are drawn dashed — call that out once
  // rather than per-color, since it's a line style, not a mode.
  if (segments.some((s) => s.inferred)) {
    legendItems.push('<span class="legend-item legend-item-inferred">┄ 推定区間（詳細な経路データなし）</span>');
  }
  if (state.filter.year == null) {
    legendItems.push('<span class="legend-item legend-item-hint">全期間を表示中（年で絞り込みできます）</span>');
  }
  if (visibleSegments.length === 0) {
    legendItems.push('<span class="legend-item legend-item-hint">すべての交通手段が非表示になっています</span>');
  }
  el.routeLegend.innerHTML = legendItems.join('');

  // Click a legend badge to toggle that mode's segments on/off — e.g. hide
  // 徒歩/走る to see only vehicle trips, or isolate a single commute mode.
  el.routeLegend.querySelectorAll('.legend-item-mode[data-mode]').forEach((elItem) => {
    elItem.addEventListener('click', () => {
      const mode = elItem.dataset.mode;
      if (routeHiddenModes.has(mode)) routeHiddenModes.delete(mode);
      else routeHiddenModes.add(mode);
      renderRouteTab(getDerived());
    });
  });
}

// ---------- Day view (滞在日 -> その日の経路マップ) ----------
// A lightweight modal, independent of the main map/route-tab state machine
// (so opening/closing it never disturbs the caller's navigation/history) —
// just a narrow-to-one-day rendering of the same pathSegments the route tab
// uses, via the same routeView.mjs helpers.

export function openDayView(dateStr) {
  if (!state.raw) return;
  el.dayViewOverlay.hidden = false;
  el.dayViewTitle.textContent = `${dateStr} の経路`;

  if (!ui.dayViewMap) {
    ui.dayViewMap = initRouteMap(el.dayViewMapDiv);
  }
  // The map container was `hidden` until the line above, so Leaflet hasn't
  // been able to measure it yet.
  requestAnimationFrame(() => ui.dayViewMap.invalidateSize());

  // Same privacy/exclusion-zone treatment as every other view. In practice
  // this is only ever reachable via the non-privacy branch of
  // renderPlaceDetail already, but applying both here too keeps this
  // function correct on its own rather than relying on that caller detail.
  const privacyData = applyPrivacy(state.raw, state.privacy);
  const displayData = applyExclusionZones(privacyData, state.zones);

  const segments = (displayData.pathSegments || []).filter((s) => s.dateStr === dateStr);
  const visits = state.privacy ? [] : (displayData.visits || []).filter((v) => v.dateStr === dateStr);

  if (segments.length === 0 && visits.length === 0) {
    el.dayViewMessage.hidden = false;
    el.dayViewMessage.textContent = 'この日の詳細な経路データはありません。';
    clearRoute(ui.dayViewMap, dayViewLayerRef);
    clearMarkers(dayViewMarkerLayerRef);
    el.dayViewLegend.innerHTML = '';
    return;
  }
  el.dayViewMessage.hidden = true;

  renderRoute(ui.dayViewMap, dayViewLayerRef, segments);

  // Visit markers for context (where the day's stays were), matching the
  // main map's orange stay-pin styling.
  if (!dayViewMarkerLayerRef.layer) dayViewMarkerLayerRef.layer = L.layerGroup().addTo(ui.dayViewMap);
  dayViewMarkerLayerRef.layer.clearLayers();
  for (const v of visits) {
    const marker = L.circleMarker([v.lat, v.lng], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#ff7f0e', fillOpacity: 0.9 });
    marker.bindTooltip(municipalityName(state.municipalityByCode, v.muniCode));
    marker.addTo(dayViewMarkerLayerRef.layer);
  }

  const modesUsed = [...new Set(segments.map((s) => s.mode))];
  const legendItems = modesUsed.map(
    (m) => `<span class="legend-item"><span class="legend-swatch" style="background:${colorForMode(m)}"></span>${modeLabel(m)}</span>`
  );
  if (segments.some((s) => s.inferred)) {
    legendItems.push('<span class="legend-item legend-item-inferred">┄ 推定区間（詳細な経路データなし）</span>');
  }
  el.dayViewLegend.innerHTML = legendItems.join('');

  const allPoints = [...segments.flatMap((s) => s.points || []), ...visits.map((v) => [v.lat, v.lng])];
  if (allPoints.length > 0) {
    ui.dayViewMap.fitBounds(L.latLngBounds(allPoints), { padding: [30, 30] });
  }
}

export function closeDayView() {
  el.dayViewOverlay.hidden = true;
}

export function wireRouteTab() {
  el.btnDayViewClose.addEventListener('click', closeDayView);
}
