// 制覇マップ tab: choropleth + drill-down (national -> prefecture -> place),
// detail panel, breadcrumb.

import { currentView, navigateTo } from './state.mjs';
import { renderNational, renderNationalMunicipality, renderPrefectureMunicipality, mainlandBounds, renderClusterMarkers, clearMarkers, renderTimelapsePoints, clearTimelapsePoints } from './mapView.mjs';
import { renderPhotoLayer, clearPhotoLayer, galleryHtml, loadGalleryThumbnails, MAX_GALLERY_PHOTOS } from './photoView.mjs';
import { formatDuration } from './statsView.mjs';
import { distanceMeters, destinationPoint, isPassOnly, computeModalVisitLocation, municipalityName, formatPlaceLabel, escapeHtml, dwellMs, computeClusterRanking } from './aggregate.mjs';
import { el, geojsonLayerRef, markerLayerRef, photoLayerRef, state, timelapsePointsRef, ui } from './context.mjs';
import { resetLabelQueue, watchRankingRowsForLabelFetch } from './labels.mjs';
import { getVisiblePhotos, openPhotoLightbox, photosForPlace, resolvePlaceName } from './photos.mjs';
import { openDayView } from './routeTab.mjs';
import { render } from './app.mjs';

// A 滞在地点 pin always wins a pixel-exact overlap with a photo pin (see
// mapView.mjs's clusterMarkerPane/photoMarkerPane z-order, issue #23), so a
// photo whose real coordinates sit right on a stay-point pin needs *some*
// nudge or it's permanently hidden on the map. This used to nudge by a fixed
// *screen-pixel* distance so the visual gap stayed constant at any zoom —
// but that meant the real-world displacement it introduced scaled with zoom
// too: at a zoomed-out view (a whole prefecture/country), a 30px nudge could
// relocate a photo's plotted position by kilometers, badly misrepresenting
// where it was actually taken. Accuracy takes priority over guaranteed
// click-separation here: the nudge is now a small FIXED real-world distance
// (~10m — GPS-noise scale, not a visible relocation) regardless of zoom.
// Only the *plotted* position moves; photo.lat/lng (popup metadata,
// resolvePlaceName) are left untouched — see photoView.mjs's createPhotoMarker.
//
// One consequence: at a typical place-level zoom, 10m can be just a couple
// of screen pixels, so a nudged photo may still render effectively behind
// its stay pin and not be independently clickable there — same as if this
// function didn't exist. That's an accepted trade-off, not a bug: zooming in
// further separates them, and the place-detail panel's own photo gallery
// (Stage 4, issue #2 — see photosForPlace) already surfaces exactly these
// photos without depending on the map pin being clickable at all.
//
// The trigger threshold (15m) intentionally stays well under the minimum
// possible `state.clusterThreshold` (20m, the slider's floor) — this app's
// own visit-clustering radius — so a photo within it is essentially
// guaranteed to belong to the *same* stay cluster as its nearest pin, not a
// merely-nearby-but-distinct one (see lib/cluster.js's union-find over that
// same distance). No need to reference state.clusterThreshold directly.
export const PHOTO_NUDGE_TRIGGER_METERS = 15;
export const PHOTO_NUDGE_DISTANCE_METERS = 10;
export function nudgePhotosAwayFromPins(photos, stayPinLatLngs) {
  if (!stayPinLatLngs.length || !photos.length) return photos;
  return photos.map((photo) => {
    let nearestPin = null;
    let nearestMeters = Infinity;
    for (const pin of stayPinLatLngs) {
      const d = distanceMeters(photo.lat, photo.lng, pin.lat, pin.lng);
      if (d < nearestMeters) {
        nearestMeters = d;
        nearestPin = pin;
      }
    }
    if (!nearestPin || nearestMeters > PHOTO_NUDGE_TRIGGER_METERS) return photo;

    // Direction "away from the pin" is undefined at exact overlap (the
    // common case — identical GPS coordinate), so fall back to a fixed
    // bearing (north). This is a cosmetic direction at a ~10m scale, so the
    // usual longitude/latitude-scaling correction for bearing isn't needed.
    let bearingDeg = 0;
    if (nearestMeters > 0.5) {
      const dLat = photo.lat - nearestPin.lat;
      const dLng = photo.lng - nearestPin.lng;
      bearingDeg = (Math.atan2(dLng, dLat) * 180) / Math.PI;
    }
    const nudged = destinationPoint(nearestPin.lat, nearestPin.lng, bearingDeg, PHOTO_NUDGE_DISTANCE_METERS);
    return { ...photo, plotLat: nudged.lat, plotLng: nudged.lng };
  });
}

// 滞在地点 -> its prefecture's ranking, without moving the map: the user has
// typically zoomed/panned to look around the selected place, and a click on
// empty map is a "back" gesture, not a request to re-frame the prefecture.
export function leavePlaceKeepingView() {
  const view = currentView(state);
  if (view.view !== 'place') return;
  ui.keepViewOnce = true;
  navigateTo(state, 'prefecture', { code: view.params.code });
  render();
}

// Map-level click that hit nothing interactive at all (sea, or outside every
// polygon): same "back" gesture as clicking the backdrop polygon. Clicks on
// polygons, pins, photo markers, and popups are handled by their own layers.
export function handleMapBackgroundClick(e) {
  const target = e.originalEvent && e.originalEvent.target;
  if (target && target.closest && target.closest('.leaflet-interactive, .leaflet-marker-icon, .leaflet-popup, .marker-cluster')) return;
  leavePlaceKeepingView();
}

export function renderMapTab(derived) {
  const view = currentView(state);
  // clusterId/muniCode are included so that switching between two different
  // 滞在地点 *within the same prefecture* still counts as a context change —
  // previously the key was just `place:<prefCode>:<granularity>`, identical
  // for every place in that prefecture, so `fit` only ever fired once (on
  // the very first place click) and then never again, leaving the map
  // stuck wherever it happened to be for every subsequent place selection.
  const context = `${view.view}:${view.params.code ?? ''}:${view.params.clusterId ?? ''}:${view.params.muniCode ?? ''}:${state.granularity}`;
  const fit = context !== ui.lastMapContext && !ui.keepViewOnce;
  ui.lastMapContext = context;
  ui.keepViewOnce = false;

  // Cluster pins are only ever drawn once drilled into a prefecture, so dim
  // the choropleth then (and highlight the selected prefecture's border)
  // rather than changing fill colors — keeps the fill's meaning consistent.
  const selectedCode = view.view === 'prefecture' || view.view === 'place' ? view.params.code : null;
  const dimmed = view.view !== 'national';

  if (state.granularity === 'prefecture') {
    // Runs even when drilled into a prefecture/place — intentionally: the
    // dimmed national choropleth stays visible as a backdrop, with the
    // current prefecture's border highlighted via `selectedCode`, and clicking
    // a *different* prefecture on that backdrop should switch straight to it
    // (no need to back out to the national view first). Click priority for
    // pins is guaranteed independently of this handler via a dedicated marker
    // pane (see renderClusterMarkers in mapView.mjs, zIndex above the
    // choropleth's pane), so a click that actually lands on a pin always hits
    // the pin first — this handler only ever fires for clicks that land on
    // the polygon backdrop itself. (Previously this handler was disabled
    // entirely whenever `dimmed` was true, as a broader-than-necessary
    // workaround for the pin-click-swallowing bug; that also disabled
    // switching prefectures once drilled in, which is the regression this
    // restores.)
    renderNational(
      ui.map,
      geojsonLayerRef,
      state.prefGeoJSON,
      derived.periodAggregates,
      (code) => {
        // The backdrop covers the entire visible map under a 'place' view,
        // while the actual 滞在地点 pin the user is looking at is a small
        // circle floating on top of it. A click on the selected prefecture's
        // own backdrop (i.e. anywhere that isn't a pin) means "done with this
        // place" — go back to the prefecture ranking, keeping the current
        // zoom/position rather than re-fitting to the whole prefecture.
        if (code === selectedCode) {
          leavePlaceKeepingView();
          return;
        }
        navigateTo(state, 'prefecture', { code });
        render();
      },
      { selectedCode, dimmed }
    );
  } else if (view.view === 'national') {
    renderNationalMunicipality(
      ui.map,
      geojsonLayerRef,
      state.muniGeoJSON,
      derived.muniAggregates,
      (muniCode) => {
        const muni = state.municipalityByCode.get(muniCode);
        navigateTo(state, 'prefecture', { code: muni ? muni.prefCode : null });
        render();
      },
      { dimmed, full: state.timelapse.playing }
    );
  }

  if (fit && (view.view === 'national' || state.granularity === 'prefecture')) {
    if (view.view === 'national') ui.map.fitBounds([[24, 122], [46, 154]], { padding: [10, 10] });
  }

  el.islandBadge.hidden = true;

  if (view.view === 'national' && state.timelapse.playing) {
    renderTimelapsePoints(
      ui.map,
      timelapsePointsRef,
      computeClusterRanking(derived.displayData, { privacy: state.privacy, municipalityByCode: state.municipalityByCode, limit: null })
    );
  } else {
    clearTimelapsePoints(timelapsePointsRef);
  }

  if (view.view === 'national') {
    clearMarkers(markerLayerRef);
    renderNationalDetail(derived);
  } else if (view.view === 'prefecture' || view.view === 'place') {
    // 'place' (a specific 滞在地点 drilled into from the prefecture ranking)
    // reuses the exact same map setup as 'prefecture' — same fitBounds, same
    // municipality overlay, same cluster markers — since it's really "still
    // looking at this prefecture, with one place selected", not a distinct
    // map mode. Previously this branch only ran for 'prefecture', so opening
    // a place detail left the muni layer/markers frozen from whatever was
    // last drawn and (depending on what triggered the render) sometimes stale
    // click handlers — this is the "地図上でのクリック判定がおかしい" bug.
    const prefCode = view.params.code;
    // Only fit to the whole prefecture when landing on the prefecture-level
    // ranking (no specific place selected yet) — once a specific 滞在地点 is
    // selected, zoomToSelectedMarker (below, after markers are drawn) zooms
    // in around that point instead. Doing the prefecture-wide fit here
    // unconditionally on every `fit` was the "zooms out to the whole
    // prefecture when clicking a place" bug.
    if (fit && view.view === 'prefecture') {
      const feature = state.prefGeoJSON.features.find((f) => f.properties.code === prefCode);
      if (feature) ui.map.fitBounds(mainlandBounds(feature), { padding: [20, 20] });
    }
    if (state.granularity === 'municipality') {
      renderPrefectureMunicipality(
        ui.map,
        geojsonLayerRef,
        state.muniGeoJSON,
        prefCode,
        derived.muniAggregates,
        // Clicking a municipality polygon (i.e. anywhere that isn't a pin)
        // while a 滞在地点 is selected goes back to the prefecture ranking,
        // same as the prefecture-granularity backdrop above.
        () => leavePlaceKeepingView(),
        { dimmed: true }
      );
    }
    renderPrefectureDetail(derived, prefCode);
    if (view.view === 'place') {
      // Overlays the place-specific stat panel over the ranking list that
      // renderPrefectureDetail just built, and highlights that place's pin.
      renderPlaceDetail(derived, view.params);
      highlightSelectedMarker(view.params);
      // Markers only exist after renderPrefectureDetail (via
      // renderClusterMarkers) has run, so this has to happen here rather
      // than alongside the prefecture-wide fit above.
      if (fit) zoomToSelectedMarker(view.params);
    }
  }

  if (state.photoLayerVisible) {
    const stayPinLatLngs = view.view === 'national' ? [] : [...ui.currentMarkersByKey.values()].map((m) => m.getLatLng());
    renderPhotoLayer(ui.map, photoLayerRef, nudgePhotosAwayFromPins(getVisiblePhotos(), stayPinLatLngs), {
      resolvePlaceName,
      onOpenLightbox: openPhotoLightbox,
    });
  } else {
    clearPhotoLayer(ui.map, photoLayerRef);
  }
}

// Gives the currently-selected 滞在地点's pin a visibly distinct style (bigger,
// accent-colored ring) so it's clear which pin the detail panel refers to,
// and brings it to the front so it isn't visually buried under others.
export function highlightSelectedMarker(params) {
  const key = params.clusterId ?? (params.muniCode != null ? 'muni:' + params.muniCode : null);
  if (key == null) return;
  const marker = ui.currentMarkersByKey.get(key);
  if (!marker) return;
  marker.setStyle({ color: '#ffffff', weight: 3, fillColor: '#e05263', radius: (marker.options.radius || 6) + 4 });
  marker.bringToFront();
}

// Zooms in around the specific selected 滞在地点 — but only when the current
// zoom is too far out to make sense of an individual point (e.g. still at
// the prefecture-wide fit). If the user has already zoomed in manually (or
// a previous selection already zoomed in) to a level where several
// 滞在地点 pins are distinguishable at once, forcing a jump to a fixed close
// zoom every single click would fight that — so above MIN_USEFUL_ZOOM this
// only pans (if needed) to keep the newly selected pin in view, without
// touching the zoom level at all.
export const PLACE_ZOOM = 14;
export const MIN_USEFUL_ZOOM = 11; // roughly "prefecture view, but pins are already distinguishable"
export function zoomToSelectedMarker(params) {
  const key = params.clusterId ?? (params.muniCode != null ? 'muni:' + params.muniCode : null);
  if (key == null) return;
  const marker = ui.currentMarkersByKey.get(key);
  if (!marker) return;
  const latlng = marker.getLatLng();
  if (ui.map.getZoom() < MIN_USEFUL_ZOOM) {
    // Too zoomed out to tell pins apart — jump in.
    ui.map.setView(latlng, PLACE_ZOOM);
  } else if (!ui.map.getBounds().contains(latlng)) {
    // Already zoomed in enough to browse between pins (manually, or from an
    // earlier selection) — keep that zoom level, just make sure the newly
    // selected pin is actually on screen.
    ui.map.panTo(latlng);
  }
  // else: already zoomed in enough and already visible — leave the view untouched.
}

// Wires the `.back-link` button pushed at the top of renderPrefectureDetail/
// renderPlaceDetail's markup — a local, in-panel duplicate of the header's
// global 戻る button, since that one is easy to miss while focused on the
// detail panel itself.
export function wireBackLink() {
  const btn = el.detailPanelContent.querySelector('[data-nav="back"]');
  if (btn) {
    btn.addEventListener('click', () => {
      // Deliberately NOT goBack(state): the label ("← 都道府県に戻る" /
      // "← 日本地図に戻る") promises a specific hierarchy-parent destination,
      // but goBack() just pops the shared linear history stack, which can
      // also be pushed to from unrelated entry points (Chronology tab,
      // breadcrumbs, the Stats-tab map jump) — so "back" could land
      // somewhere that isn't this view's parent at all. Navigate to the
      // computed parent directly instead. 'place' always belongs to its
      // prefecture (municipality-granularity 'place' still reuses the same
      // prefecture map, see renderMapTab), and 'prefecture' always belongs
      // to the national view.
      const view = currentView(state);
      if (view.view === 'place') {
        navigateTo(state, 'prefecture', { code: view.params.code });
      } else if (view.view === 'prefecture') {
        navigateTo(state, 'national', {});
      }
      render();
    });
  }
}

export function renderNationalDetail(derived) {
  const parts = [];
  parts.push('<h2>日本全体</h2>');
  parts.push('<p style="color:var(--color-text-dim); font-size:13px;">都道府県（または市区町村）をクリックすると詳細が表示されます。</p>');
  if (derived.newlyVisited && derived.newlyVisited.length > 0) {
    parts.push(`<h3>${state.filter.year}年に初めて訪れた県</h3>`);
    parts.push('<ul class="newly-visited-list">' + derived.newlyVisited.map((p) => `<li>${p.name}</li>`).join('') + '</ul>');
  }
  el.detailPanelContent.innerHTML = parts.join('');
}

export function renderPrefectureDetail(derived, code) {
  const entry = derived.periodAggregates.get(code);
  const name = entry ? entry.name : '不明';
  const placeCount = entry ? entry.placeCount : 0;
  const stayCount = entry ? entry.stayCount : 0;
  const firstDate = entry && entry.firstEpoch ? new Date(entry.firstEpoch).toISOString().slice(0, 10) : '-';
  const lastDate = entry && entry.lastEpoch ? new Date(entry.lastEpoch).toISOString().slice(0, 10) : '-';

  const scopedVisitsAll = derived.periodData.visits.filter((v) => v.prefCode === code);
  const totalDwell = scopedVisitsAll.reduce((s, v) => s + dwellMs(v), 0);
  const avgDwell = scopedVisitsAll.length ? totalDwell / scopedVisitsAll.length : 0;

  const totalMuniInPref = state.raw.municipalities.filter((m) => m.prefCode === code).length;
  const visitedMuniInPref = [...derived.muniAggregates.values()].filter((m) => m.prefCode === code && m.stayCount > 0).length;
  const passOnlyMuniInPref = [...derived.muniAggregates.values()].filter((m) => m.prefCode === code && isPassOnly(m)).length;

  const parts = [];
  parts.push('<button class="back-link" data-nav="back">← 日本地図に戻る</button>');
  parts.push(`<h2>${name}</h2>`);
  // placeCount (distinct 滞在地点数) is now the map の塗り分け/ランキング指標
  // — shown first, with the raw visit-event count (stayCount) kept right
  // after as a separate, still-useful stat (how often, vs. how many places).
  parts.push(`<div class="stat-row"><span class="label">訪問地点数</span><span>${placeCount} 件</span></div>`);
  parts.push(`<div class="stat-row"><span class="label">滞在回数</span><span>${stayCount} 回</span></div>`);
  parts.push(`<div class="stat-row"><span class="label">最初に訪れた日</span><span>${firstDate}</span></div>`);
  parts.push(`<div class="stat-row"><span class="label">最後に訪れた日</span><span>${lastDate}</span></div>`);
  parts.push(`<div class="stat-row"><span class="label">合計滞在時間</span><span>${formatDuration(totalDwell)}</span></div>`);
  parts.push(`<div class="stat-row"><span class="label">平均滞在時間</span><span>${formatDuration(avgDwell)}</span></div>`);
  parts.push(`<div class="stat-row"><span class="label">市区町村制覇率</span><span>${visitedMuniInPref} / ${totalMuniInPref}</span></div>`);
  if (passOnlyMuniInPref > 0) {
    parts.push(`<div class="stat-row"><span class="label">通過のみの市区町村</span><span>${passOnlyMuniInPref}</span></div>`);
  }

  // Exclusion-zone-filtered rows for ranking/pins/visit-lists, per spec.
  const scopedVisits = derived.displayData.visits.filter((v) => v.prefCode === code);
  const rows = computeClusterRanking({ visits: scopedVisits }, { privacy: state.privacy, municipalityByCode: state.municipalityByCode, limit: null, sortBy: state.sortBy });

  if (ui.currentDetailPrefCode !== code) {
    resetLabelQueue();
    ui.currentDetailPrefCode = code;
  }

  parts.push('<h3 style="margin-top:16px;">滞在地点</h3>');
  if (rows.length === 0) {
    parts.push('<p class="empty-note">この期間の滞在データはありません。</p>');
  } else {
    parts.push(
      rows
        .map((r) => {
          const nameHtml =
            r.clusterId != null && !state.privacy
              ? `<span class="detail-name" data-cluster-id="${r.clusterId}" data-muni-name="${escapeHtml(r.muniName)}">${escapeHtml(formatPlaceLabel(r.muniName, state.placeLabelCache.get(r.clusterId)))}</span>`
              : r.muniName;
          return `<div class="place-item" data-cluster-id="${r.clusterId ?? ''}" data-muni-code="${r.muniCode ?? ''}"><span class="place-count">${r.count}回</span> — ${nameHtml}</div>`;
        })
        .join('')
    );
  }

  el.detailPanelContent.innerHTML = parts.join('');
  wireBackLink();

  const goToRow = (row) => {
    navigateTo(state, 'place', { clusterId: row.clusterId ?? null, muniCode: row.muniCode ?? null, code });
    render();
  };
  ui.currentMarkersByKey = renderClusterMarkers(ui.map, markerLayerRef, rows, goToRow, state.placeLabelCache);
  for (const row of rows) {
    const marker = ui.currentMarkersByKey.get(row.clusterId ?? 'muni:' + row.muniCode);
    if (marker) {
      marker.__muniName = row.muniName;
      marker.__count = row.count;
    }
  }
  el.detailPanelContent.querySelectorAll('.place-item').forEach((elItem, i) => {
    elItem.addEventListener('click', () => goToRow(rows[i]));
  });

  if (!state.privacy) watchRankingRowsForLabelFetch(rows, scopedVisits);

  // Island-visit badge: mainland-bbox zoom (see mapView.mjs) can leave
  // out-of-frame visited spots (Ogasawara for Tokyo, remote islands for
  // Kagoshima/Okinawa/Hokkaido, ...); offer a one-click jump to them.
  const feature = state.prefGeoJSON.features.find((f) => f.properties.code === code);
  if (feature) {
    const bounds = mainlandBounds(feature);
    const islandRows = rows.filter((r) => r.lat != null && !bounds.contains([r.lat, r.lng]));
    if (islandRows.length > 0) {
      el.islandBadge.hidden = false;
      el.islandBadge.innerHTML = `離島に訪問済みの地点があります（${islandRows.length}件） <button class="btn btn-icon" id="btn-jump-island">ジャンプ</button>`;
      document.getElementById('btn-jump-island').addEventListener('click', () => {
        ui.map.fitBounds(L.latLngBounds(islandRows.map((r) => [r.lat, r.lng])), { padding: [40, 40] });
      });
    }
  }
}

export function renderPlaceDetail(derived, params) {
  const { clusterId, muniCode, code } = params;
  const prefEntry = derived.periodAggregates.get(code);
  const parts = [];

  if (ui.placeGalleryCancel) {
    ui.placeGalleryCancel();
    ui.placeGalleryCancel = null;
  }

  const backLabel = state.granularity === 'municipality' ? '市区町村マップに戻る' : '都道府県に戻る';
  parts.push(`<button class="back-link" data-nav="back">← ${backLabel}</button>`);

  if (clusterId != null && !state.privacy) {
    const memberVisits = derived.displayData.visits.filter((v) => v.clusterId === clusterId).sort((a, b) => a.startEpoch - b.startEpoch);
    const first = memberVisits[0];
    // The modal (most-frequent placeId, or most-frequent exact coordinate)
    // location is a better anchor for reverse geocoding than the earliest
    // visit or the cluster centroid — it's the point most likely to actually
    // sit on the place in question rather than drift from GPS noise.
    const modal = computeModalVisitLocation(memberVisits);
    const modalVisit = modal ? memberVisits.find((v) => v.lat === modal.lat && v.lng === modal.lng) : null;
    const muniLabel = municipalityName(state.municipalityByCode, (modalVisit || first)?.muniCode);
    const totalDwell = memberVisits.reduce((s, v) => s + dwellMs(v), 0);
    const avgDwell = memberVisits.length ? totalDwell / memberVisits.length : 0;

    parts.push('<h2>滞在地点</h2>');
    parts.push(`<div class="stat-row"><span class="label">都道府県</span><span>${prefEntry ? prefEntry.name : ''}</span></div>`);
    parts.push(`<div class="stat-row"><span class="label">市区町村</span><span>${muniLabel}</span></div>`);
    parts.push(`<div class="stat-row"><span class="label">詳細地名</span><span id="nominatim-label">取得中…</span></div>`);
    parts.push(`<div class="stat-row"><span class="label">この期間の滞在回数</span><span>${memberVisits.length} 回</span></div>`);
    parts.push(`<div class="stat-row"><span class="label">合計滞在時間</span><span>${formatDuration(totalDwell)}</span></div>`);
    parts.push(`<div class="stat-row"><span class="label">平均滞在時間</span><span>${formatDuration(avgDwell)}</span></div>`);
    if (modal) {
      parts.push(`<div class="stat-row"><span class="label">座標（補助情報）</span><span>${modal.lat.toFixed(4)}, ${modal.lng.toFixed(4)}</span></div>`);
    }
    parts.push('<h3 style="margin-top:16px;">滞在日一覧</h3><p class="panel-hint">日付をクリックすると、その日の経路マップを表示します。</p>');
    parts.push(
      memberVisits
        .map((v) => (v.dateStr ? `<button type="button" class="place-item day-item" data-date="${v.dateStr}" aria-label="${v.dateStr} の経路を表示">${v.dateStr}</button>` : '<div class="place-item">-</div>'))
        .join('')
    );

    // Stage 4 (issue #2): inline photo gallery for this place, reusing the
    // exact same grid markup/thumbnail-loading/lightbox as the map's photo
    // cluster popup (photoView.mjs) for visual and behavioral consistency.
    const allPlacePhotos = photosForPlace(memberVisits);
    const placePhotos = allPlacePhotos.slice(0, MAX_GALLERY_PHOTOS);
    if (placePhotos.length > 0) {
      parts.push('<h3 style="margin-top:16px;">この場所の写真</h3>');
      parts.push(galleryHtml(placePhotos, allPlacePhotos.length));
    }

    el.detailPanelContent.innerHTML = parts.join('');
    wireBackLink();
    el.detailPanelContent.querySelectorAll('.day-item[data-date]').forEach((elDay) => {
      elDay.addEventListener('click', () => openDayView(elDay.dataset.date));
    });
    if (placePhotos.length > 0) {
      ui.placeGalleryCancel = loadGalleryThumbnails(el.detailPanelContent, placePhotos, { onOpenLightbox: openPhotoLightbox });
    }

    if (modal) {
      const gen = state.renderGen;
      window.pathBrowser.reverseGeocode(modal.placeId, modal.lat, modal.lng).then((res) => {
        if (state.renderGen !== gen) return; // user navigated away before this resolved
        const target = el.detailPanelContent.querySelector('#nominatim-label');
        if (target) target.textContent = res.label || '（取得できませんでした）';
      });
      ui.map.panTo([modal.lat, modal.lng]);
    }
  } else {
    // Privacy-mode municipality rollup: no coords, no Nominatim detail.
    const scopedVisits = derived.displayData.visits.filter((v) => v.prefCode === code);
    const rows = computeClusterRanking({ visits: scopedVisits }, { privacy: true, municipalityByCode: state.municipalityByCode, limit: null });
    const row = rows.find((r) => r.muniCode === muniCode);

    parts.push('<h2>市区町村</h2>');
    parts.push(`<div class="stat-row"><span class="label">都道府県</span><span>${prefEntry ? prefEntry.name : ''}</span></div>`);
    parts.push(`<div class="stat-row"><span class="label">市区町村</span><span>${row ? row.muniName : '不明'}</span></div>`);
    parts.push(`<div class="stat-row"><span class="label">この期間の滞在回数</span><span>${row ? row.count : 0} 回</span></div>`);
    parts.push(`<div class="stat-row"><span class="label">合計滞在時間</span><span>${row ? formatDuration(row.dwellMs) : '-'}</span></div>`);
    if (row && row.firstEpoch) parts.push(`<div class="stat-row"><span class="label">最初に訪れた日</span><span>${new Date(row.firstEpoch).toISOString().slice(0, 10)}</span></div>`);
    if (row && row.lastEpoch) parts.push(`<div class="stat-row"><span class="label">最後に訪れた日</span><span>${new Date(row.lastEpoch).toISOString().slice(0, 10)}</span></div>`);
    parts.push('<div class="privacy-note">プライバシー保護モードのため、市区町村単位の情報のみ表示しています。</div>');

    el.detailPanelContent.innerHTML = parts.join('');
    wireBackLink();
    if (row) ui.map.panTo([row.lat, row.lng]);
  }
}

export function renderBreadcrumb() {
  const crumbs = [];
  const view = currentView(state);

  crumbs.push({ label: '日本地図', view: 'national', params: {} });

  if (view.view === 'prefecture' || view.view === 'place') {
    const code = view.params.code;
    const pref = state.raw.prefectures.find((p) => p.code === code);
    crumbs.push({ label: pref ? pref.name : '県', view: 'prefecture', params: { code } });
  }
  if (view.view === 'place') {
    crumbs.push({ label: '滞在地点', view: 'place', params: view.params });
  }

  el.breadcrumb.innerHTML = crumbs
    .map((c, i) => {
      const isLast = i === crumbs.length - 1;
      const span = isLast ? `<span class="current">${c.label}</span>` : `<span class="crumb" data-index="${i}">${c.label}</span>`;
      return i === 0 ? span : `<span class="sep">›</span>${span}`;
    })
    .join('');

  el.breadcrumb.querySelectorAll('.crumb').forEach((elCrumb) => {
    elCrumb.addEventListener('click', () => {
      const i = Number(elCrumb.dataset.index);
      const target = crumbs[i];
      navigateTo(state, target.view, target.params);
      render();
    });
  });
}
