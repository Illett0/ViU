// 経路マップ tab and the per-day route modal (滞在日 -> その日の経路).

import { clearMarkers } from './mapView.mjs';
import { initRouteMap, renderRoute, clearRoute, colorForMode, renderDayRoute, lineSampleSvg, formatClock } from './routeView.mjs';
import { renderPhotoLayer, clearPhotoLayer, galleryHtml, loadGalleryThumbnails, MAX_GALLERY_PHOTOS } from './photoView.mjs';
import { modeLabel, formatDuration } from './statsView.mjs';
import { applyPrivacy, applyExclusionZones, municipalityName, computeModalVisitLocation, dwellMs, escapeHtml, visibleMovePortion } from './aggregate.mjs';
import { dayViewLayerRef, dayViewMarkerLayerRef, dayViewPhotoLayerRef, el, routeLayerRef, routePhotoLayerRef, state, ui } from './context.mjs';
import { getVisiblePhotos, openPhotoLightbox, resolvePlaceName, photosForDay } from './photos.mjs';
import { enqueueLabelFetch, onPlaceLabelUpdated } from './labels.mjs';
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
// A modal dialog, independent of the main map/route-tab state machine (so
// opening/closing it never disturbs the caller's navigation/history). Shows
// one day as both a map and an equivalent text timeline (stays and moves in
// order) — the timeline is the accessible "table view" of the map: every
// stay/move on the map is also listed there in text, and hovering/focusing a
// row highlights it on the map.

const STOP_FILL = '#ff7f0e'; // same orange as the main map's stay pins
const STOP_TEXT = '#1a1a1a'; // dark digits on orange: ~8:1 (white would be ~2.9:1)

let dayView = null; // { dateStr, dates, segments, segLayers, stopMarkers, items, moves, photos, opener }
let unsubscribeLabels = null;
let dayPhotosVisible = true; // remembered across days/openings within a session
let dayGalleryCancel = null; // cancels in-flight thumbnail fetches of the day's photo gallery
const DAY_STOP_PANE = 'dayStopPane'; // above the photo pane (640), so numbered stops stay on top

function formatKm(meters) {
  return (meters / 1000).toLocaleString('ja-JP', { maximumFractionDigits: 1 }) + ' km';
}

function formatDateTitle(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = '日月火水木金土'[d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${dow}）`;
}

function dayDisplayData() {
  // Same privacy/exclusion-zone treatment as every other view. In practice
  // this is only reachable via the non-privacy branch of renderPlaceDetail,
  // but applying both here keeps this module correct on its own.
  return applyExclusionZones(applyPrivacy(state.raw, state.privacy), state.zones);
}

// Every date that has something to show, for 前/次の記録日 navigation.
function datesWithData(displayData) {
  const dates = new Set();
  for (const s of displayData.pathSegments || []) if (s.dateStr) dates.add(s.dateStr);
  if (!state.privacy) {
    for (const v of displayData.visits || []) if (v.dateStr) dates.add(v.dateStr);
    for (const p of state.photos) {
      if (p.takenAtMs == null) continue;
      const d = new Date(p.takenAtMs);
      dates.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
  }
  return [...dates].sort();
}

function placeNameFor(visit) {
  const muni = municipalityName(state.municipalityByCode, visit.muniCode);
  const entry = visit.clusterId != null ? state.placeLabelCache.get(visit.clusterId) : null;
  return entry && entry.status === 'done' && entry.label ? `${entry.label}（${muni}）` : muni;
}

// Queue detail-name lookups (same queue/cache as the prefecture ranking) for
// this day's stays; rows update in place via onPlaceLabelUpdated.
function requestPlaceLabels(visits, displayData) {
  if (state.privacy) return;
  for (const v of visits) {
    if (v.clusterId == null || state.placeLabelCache.has(v.clusterId)) continue;
    const members = displayData.visits.filter((x) => x.clusterId === v.clusterId);
    const modal = computeModalVisitLocation(members);
    if (modal) enqueueLabelFetch(v.clusterId, modal, true);
  }
}

// Stays and moves merged into one chronological list. Moves come from
// `activities` (mode, distance, times — deliberately *no* start/end place
// names). Activities aren't exclusion-zone filtered themselves, so each move
// goes through visibleMovePortion: one touching a zone is reduced to its
// part outside the zone (or dropped if none of it is visible), so neither the
// list nor the summary reveals e.g. when someone left a zoned-out home. Each
// move is linked to the drawn route segments overlapping its shown span.
function buildTimeline(dateStr, displayData, segments) {
  const visits = state.privacy
    ? []
    : (displayData.visits || []).filter((v) => v.dateStr === dateStr).sort((a, b) => a.startEpoch - b.startEpoch);
  const moves = [];
  for (const a of displayData.activities || []) {
    if (a.dateStr !== dateStr || a.startEpoch == null) continue;
    const shown = visibleMovePortion(a, segments, state.zones);
    if (shown) moves.push({ ...a, ...shown });
  }
  const items = [];
  visits.forEach((v, i) => items.push({ kind: 'stay', epoch: v.startEpoch, visit: v, number: i + 1 }));
  for (const a of moves) {
    const segIdx = [];
    segments.forEach((s, i) => {
      if (s.startEpoch != null && s.endEpoch != null && a.endEpoch != null && s.startEpoch <= a.endEpoch && s.endEpoch >= a.startEpoch) segIdx.push(i);
    });
    items.push({ kind: 'move', epoch: a.startEpoch, activity: a, segIdx });
  }
  items.sort((x, y) => x.epoch - y.epoch);
  return { items, visits, moves };
}

function stopIcon(number, active = false) {
  return L.divIcon({
    className: 'day-stop-icon',
    html: `<span class="day-stop${active ? ' active' : ''}" style="background:${STOP_FILL};color:${STOP_TEXT}">${number}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function renderLegend(segments, moves) {
  const distanceByMode = new Map();
  for (const a of moves) distanceByMode.set(a.mode, (distanceByMode.get(a.mode) || 0) + (a.distanceMeters || 0));
  const modes = [...new Set([...segments.map((s) => s.mode), ...moves.map((a) => a.mode)])];
  const items = modes.map((m) => {
    const dist = distanceByMode.get(m);
    return `<li class="legend-item">${lineSampleSvg(m)}<span>${escapeHtml(modeLabel(m))}${dist ? ` <span class="legend-sub">${formatKm(dist)}</span>` : ''}</span></li>`;
  });
  if (segments.some((s) => s.inferred)) {
    items.push(`<li class="legend-item">${lineSampleSvg('UNKNOWN', { inferred: true })}<span>推定区間（詳細な経路データなし）</span></li>`);
  }
  if (dayPhotosVisible && dayView.photos.length > 0) {
    items.push(`<li class="legend-item"><span aria-hidden="true">&#128247;</span><span>写真（${dayView.photos.length}枚）</span></li>`);
  }
  if (dayView.stopMarkers.length > 0) {
    items.push(
      `<li class="legend-item"><span class="day-stop legend-stop" style="background:${STOP_FILL};color:${STOP_TEXT}" aria-hidden="true">1</span><span>滞在地点（数字は訪問順）</span></li>`
    );
  }
  el.dayViewLegend.innerHTML = items.join('');
}

function renderTimelineList() {
  const { items } = dayView;
  if (items.length === 0) {
    el.dayViewTimeline.innerHTML = '<li class="empty-note">この日の記録はありません。</li>';
    return;
  }
  el.dayViewTimeline.innerHTML = items
    .map((item, i) => {
      if (item.kind === 'stay') {
        const v = item.visit;
        return (
          `<li><button type="button" class="day-tl-item day-tl-stay" data-index="${i}">` +
          `<span class="day-stop" style="background:${STOP_FILL};color:${STOP_TEXT}" aria-hidden="true">${item.number}</span>` +
          `<span class="day-tl-body"><span class="day-tl-time">${formatClock(v.startEpoch)}–${formatClock(v.endEpoch)}</span>` +
          `<span class="day-tl-title" data-cluster-id="${v.clusterId ?? ''}">${escapeHtml(placeNameFor(v))}</span>` +
          `<span class="day-tl-sub">滞在 ${formatDuration(dwellMs(v))}</span>` +
          `<span class="visually-hidden">（地図上の${item.number}番の地点）</span></span>` +
          `</button></li>`
        );
      }
      const a = item.activity;
      const dur = a.endEpoch != null ? a.endEpoch - a.startEpoch : 0;
      // A cut side's time is where the visible part of the route begins/ends,
      // not when the move itself started/ended — marked 「頃」.
      const time = `${formatClock(a.startEpoch)}${a.startCut ? '頃' : ''}–${formatClock(a.endEpoch)}${a.endCut ? '頃' : ''}`;
      return (
        `<li><button type="button" class="day-tl-item day-tl-move" data-index="${i}">` +
        `<span class="day-tl-line">${lineSampleSvg(a.mode)}</span>` +
        `<span class="day-tl-body"><span class="day-tl-time">${time}</span>` +
        `<span class="day-tl-title">${escapeHtml(modeLabel(a.mode))}で移動</span>` +
        `<span class="day-tl-sub">${a.distanceMeters ? formatKm(a.distanceMeters) + '・' : ''}${formatDuration(dur)}</span>` +
        (a.partial ? '<span class="day-tl-note">除外ゾーン外の部分のみ</span>' : '') +
        `</span></button></li>`
      );
    })
    .join('');

  el.dayViewTimeline.querySelectorAll('.day-tl-item').forEach((btn) => {
    const item = items[Number(btn.dataset.index)];
    btn.addEventListener('mouseenter', () => highlightItem(item, true));
    btn.addEventListener('mouseleave', () => highlightItem(item, false));
    btn.addEventListener('focus', () => highlightItem(item, true));
    btn.addEventListener('blur', () => highlightItem(item, false));
    btn.addEventListener('click', () => focusItemOnMap(item));
  });
}

// Highlight = the stop's badge gets a dark ring / the move's casing turns
// dark and its line thickens, so it stands out by shape and contrast, not by
// a new color.
function highlightItem(item, on) {
  if (!dayView) return;
  if (item.kind === 'stay') {
    const marker = dayView.stopMarkers[item.number - 1];
    if (!marker) return;
    marker.setIcon(stopIcon(item.number, on));
    marker.setZIndexOffset(on ? 1000 : 0);
    return;
  }
  for (const idx of item.segIdx) {
    const layers = dayView.segLayers[idx] || [];
    const [casing, main] = layers;
    if (casing) casing.setStyle({ color: on ? '#101216' : '#ffffff' });
    if (main) main.setStyle({ weight: main.options.baseWeight + (on ? 3 : 0) });
    if (on) layers.forEach((l) => l.bringToFront());
  }
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function focusItemOnMap(item) {
  const animate = !prefersReducedMotion();
  if (item.kind === 'stay') {
    const v = item.visit;
    ui.dayViewMap.setView([v.lat, v.lng], Math.max(ui.dayViewMap.getZoom(), 15), { animate });
    const marker = dayView.stopMarkers[item.number - 1];
    if (marker) marker.openTooltip();
    return;
  }
  const pts = item.segIdx.flatMap((i) => dayView.segments[i].points || []);
  const a = item.activity;
  if (pts.length === 0 && a.startLat != null && a.endLat != null) pts.push([a.startLat, a.startLng], [a.endLat, a.endLng]);
  if (pts.length > 0) ui.dayViewMap.fitBounds(L.latLngBounds(pts), { padding: [40, 40], animate });
}

// The day's photos: pins on the map (same clustered photo layer as the main
// maps) plus a thumbnail gallery under the timeline; both open the shared
// lightbox. Toggled by the header's camera button.
function renderDayPhotos() {
  if (dayGalleryCancel) {
    dayGalleryCancel();
    dayGalleryCancel = null;
  }
  const photos = dayView.photos;
  el.btnDayViewPhotos.hidden = photos.length === 0;
  el.dayViewPhotoCount.textContent = photos.length ? String(photos.length) : '';
  el.btnDayViewPhotos.setAttribute('aria-pressed', String(dayPhotosVisible));
  el.btnDayViewPhotos.setAttribute('aria-label', `この日の写真（${photos.length}枚）を${dayPhotosVisible ? '非表示にする' : '表示する'}`);
  el.btnDayViewPhotos.classList.toggle('active', dayPhotosVisible);

  const show = dayPhotosVisible && photos.length > 0;
  el.dayViewPhotos.hidden = !show;
  if (!show) {
    clearPhotoLayer(ui.dayViewMap, dayViewPhotoLayerRef);
    el.dayViewPhotoGallery.innerHTML = '';
    return;
  }
  renderPhotoLayer(ui.dayViewMap, dayViewPhotoLayerRef, photos, { resolvePlaceName, onOpenLightbox: openPhotoLightbox });
  const shown = photos.slice(0, MAX_GALLERY_PHOTOS);
  el.dayViewPhotoGallery.innerHTML =
    galleryHtml(shown, shown.length) +
    (photos.length > shown.length ? `<p class="empty-note">ほか${photos.length - shown.length}枚は地図上の写真ピンから表示できます。</p>` : '');
  dayGalleryCancel = loadGalleryThumbnails(el.dayViewPhotoGallery, shown, { onOpenLightbox: openPhotoLightbox });
}

function renderSummary({ moves, visits }) {
  const totalDist = moves.reduce((s, a) => s + (a.distanceMeters || 0), 0);
  const moveMs = moves.reduce((s, a) => s + (a.endEpoch != null ? Math.max(0, a.endEpoch - a.startEpoch) : 0), 0);
  const parts = [];
  if (moves.length) parts.push(`移動 ${formatKm(totalDist)}`, `移動時間 ${formatDuration(moveMs)}`);
  if (visits.length) parts.push(`滞在 ${visits.length}か所`);
  el.dayViewSummary.textContent = parts.join(' ・ ');
}

function renderDay(dateStr) {
  const displayData = dayDisplayData();
  const dates = datesWithData(displayData);
  const segments = (displayData.pathSegments || []).filter((s) => s.dateStr === dateStr);
  const timeline = buildTimeline(dateStr, displayData, segments);
  dayView = { ...dayView, dateStr, dates, segments, segLayers: [], stopMarkers: [], items: timeline.items, moves: timeline.moves, photos: photosForDay(dateStr) };

  el.dayViewTitle.textContent = `${formatDateTitle(dateStr)}の経路`;
  const i = dates.indexOf(dateStr);
  el.btnDayViewPrev.disabled = i <= 0;
  el.btnDayViewNext.disabled = i === -1 || i >= dates.length - 1;
  renderSummary(timeline);

  clearRoute(ui.dayViewMap, dayViewLayerRef);
  clearMarkers(dayViewMarkerLayerRef);

  if (segments.length === 0 && timeline.visits.length === 0) {
    el.dayViewMessage.hidden = false;
    el.dayViewMessage.textContent = 'この日の詳細な経路データはありません。';
    renderTimelineList();
    renderDayPhotos();
    renderLegend(segments, timeline.moves);
    const photoPoints = dayPhotosVisible ? dayView.photos.map((p) => [p.lat, p.lng]) : [];
    if (photoPoints.length > 0) ui.dayViewMap.fitBounds(L.latLngBounds(photoPoints), { padding: [30, 30], maxZoom: 15, animate: false });
    return;
  }
  el.dayViewMessage.hidden = true;

  dayView.segLayers = renderDayRoute(ui.dayViewMap, dayViewLayerRef, segments, { labelFor: modeLabel });

  if (!dayViewMarkerLayerRef.layer) dayViewMarkerLayerRef.layer = L.layerGroup().addTo(ui.dayViewMap);
  timeline.visits.forEach((v, idx) => {
    const n = idx + 1;
    const marker = L.marker([v.lat, v.lng], {
      icon: stopIcon(n),
      keyboard: false, // reachable via the timeline list instead (same content, in order)
      title: `${n}. ${placeNameFor(v)}`,
      riseOnHover: true,
      pane: DAY_STOP_PANE,
    });
    marker.bindTooltip(
      () => `${n}. ${escapeHtml(placeNameFor(v))}<br>${formatClock(v.startEpoch)}–${formatClock(v.endEpoch)}（滞在 ${formatDuration(dwellMs(v))}）`,
      { direction: 'top', offset: [0, -12] }
    );
    marker.on('click', () => {
      const index = dayView.items.findIndex((it) => it.kind === 'stay' && it.number === n);
      const btn = el.dayViewTimeline.querySelector(`.day-tl-item[data-index="${index}"]`);
      if (btn) {
        btn.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        btn.focus({ preventScroll: true });
      }
    });
    marker.addTo(dayViewMarkerLayerRef.layer);
    dayView.stopMarkers.push(marker);
  });

  renderDayPhotos();
  renderLegend(segments, timeline.moves);
  renderTimelineList();
  requestPlaceLabels(timeline.visits, displayData);

  const allPoints = [
    ...segments.flatMap((s) => s.points || []),
    ...timeline.visits.map((v) => [v.lat, v.lng]),
    ...(dayPhotosVisible ? dayView.photos.map((p) => [p.lat, p.lng]) : []),
  ];
  if (allPoints.length > 0) ui.dayViewMap.fitBounds(L.latLngBounds(allPoints), { padding: [30, 30], animate: false });
}

function refreshPlaceName(clusterId) {
  if (!dayView || el.dayViewOverlay.hidden) return;
  const item = dayView.items.find((it) => it.kind === 'stay' && it.visit.clusterId === clusterId);
  if (!item) return;
  const name = placeNameFor(item.visit);
  el.dayViewTimeline.querySelectorAll(`.day-tl-title[data-cluster-id="${clusterId}"]`).forEach((t) => {
    t.textContent = name;
  });
  dayView.items.forEach((it) => {
    if (it.kind !== 'stay' || it.visit.clusterId !== clusterId) return;
    const marker = dayView.stopMarkers[it.number - 1];
    const node = marker && marker.getElement();
    if (node) node.setAttribute('title', `${it.number}. ${name}`);
  });
}

export function openDayView(dateStr) {
  if (!state.raw) return;
  const opener = document.activeElement;
  el.dayViewOverlay.hidden = false;
  if (!ui.dayViewMap) {
    ui.dayViewMap = initRouteMap(el.dayViewMapDiv);
    ui.dayViewMap.createPane(DAY_STOP_PANE);
    ui.dayViewMap.getPane(DAY_STOP_PANE).style.zIndex = 650;
  }
  // The map container was `hidden` until just now, so Leaflet hasn't been
  // able to measure it yet — measure before fitting bounds.
  ui.dayViewMap.invalidateSize();
  dayView = { opener };
  renderDay(dateStr);
  if (!unsubscribeLabels) unsubscribeLabels = onPlaceLabelUpdated(refreshPlaceName);
  el.btnDayViewClose.focus();
}

function stepDay(delta) {
  if (!dayView) return;
  const i = dayView.dates.indexOf(dayView.dateStr);
  const next = dayView.dates[i + delta];
  if (!next) return;
  renderDay(next);
  // Keep focus inside the dialog, on the (newly announced) date heading.
  el.dayViewTitle.focus();
}

export function closeDayView() {
  if (el.dayViewOverlay.hidden) return;
  el.dayViewOverlay.hidden = true;
  if (dayGalleryCancel) {
    dayGalleryCancel();
    dayGalleryCancel = null;
  }
  const opener = dayView && dayView.opener;
  dayView = null;
  if (opener && document.contains(opener)) opener.focus();
}

function focusableIn(container) {
  return [...container.querySelectorAll('button, [href], input, select, [tabindex]:not([tabindex="-1"])')].filter(
    (n) => !n.disabled && n.offsetParent !== null
  );
}

export function wireRouteTab() {
  el.btnDayViewClose.addEventListener('click', closeDayView);
  el.btnDayViewPrev.addEventListener('click', () => stepDay(-1));
  el.btnDayViewNext.addEventListener('click', () => stepDay(1));
  el.btnDayViewPhotos.addEventListener('click', () => {
    if (!dayView) return;
    dayPhotosVisible = !dayPhotosVisible;
    renderDayPhotos();
    renderLegend(dayView.segments, dayView.moves);
  });
  // A click on the dimmed backdrop (outside the dialog) closes it.
  el.dayViewOverlay.addEventListener('click', (e) => {
    if (e.target === el.dayViewOverlay) closeDayView();
  });
  el.dayViewOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDayView();
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !el.dayViewMapDiv.contains(e.target)) {
      // Arrow keys with focus inside the map still pan it (Leaflet keyboard nav).
      e.preventDefault();
      stepDay(e.key === 'ArrowLeft' ? -1 : 1);
    } else if (e.key === 'Tab') {
      // Keep keyboard focus inside the modal dialog.
      const nodes = focusableIn(el.dayViewPanel);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}

export function getDayViewState() {
  if (!dayView || el.dayViewOverlay.hidden) return null;
  return {
    dateStr: dayView.dateStr,
    dates: dayView.dates,
    items: dayView.items.map((it) => it.kind),
    stops: dayView.stopMarkers.length,
    segments: dayView.segments.length,
    photos: dayView.photos.length,
    segmentTips: dayView.segLayers.map((layers) => (layers[0] && layers[0].getTooltip() ? String(layers[0].getTooltip().getContent()) : '')),
    photosVisible: dayPhotosVisible,
    photoPins: dayViewPhotoLayerRef.markersByPath ? dayViewPhotoLayerRef.markersByPath.size : 0,
  };
}
