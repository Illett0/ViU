// Orchestrator: derived data, render(), navigation helpers, and the
// remaining top-level event wiring. Feature areas live in their own modules
// (see context.mjs for the shared state they all read/write).

import { currentView, navigateTo, goBack, goForward, canGoBack, canGoForward } from './state.mjs';
import { applyPrivacyZoomLimit } from './mapView.mjs';
import { renderStats } from './statsView.mjs';
import { renderChronology } from './chronologyView.mjs';
import { applyPrivacy, applyExclusionZones, filterByPeriod, filterUpToPeriod, computePrefectureAggregates, computeMunicipalityAggregates, computeConquestRates, isPassOnly, computeDwellCapNote, computeClusterRanking, computeStats, computeWalkingComparisonRatio, computeLongestTrips, computeDayOfWeekStats, computeHourlyHistogram, computeTopDays, computeNewlyVisitedInYear, computeChronology } from './aggregate.mjs';
import { el, state, ui } from './context.mjs';
import { resetLabelQueue } from './labels.mjs';
import { recluster, refreshRecentFilesList, wireLoading } from './loading.mjs';
import { initPhotoLink, wirePhotos } from './photos.mjs';
import { renderBreadcrumb, renderMapTab } from './mapTab.mjs';
import { renderRouteTab, wireRouteTab } from './routeTab.mjs';
import { stopTimelapse, wireTimelapse } from './timelapse.mjs';
import { wireSettings } from './settings.mjs';
import { installTestHooks } from './testHooks.mjs';

export function getDerived() {
  const privacyData = applyPrivacy(state.raw, state.privacy);
  const globalAggregates = computePrefectureAggregates(privacyData, state.raw.prefectures);
  const globalMuniAggregates = computeMunicipalityAggregates(privacyData, state.raw.municipalities);

  // During timelapse playback, the map should paint progressively rather than
  // flicker on/off per exact month, so we use a cumulative "up to this month"
  // filter instead of the normal exact-match period filter.
  const periodData = state.timelapse.playing
    ? filterUpToPeriod(privacyData, { year: state.filter.year, month: state.filter.month })
    : filterByPeriod(privacyData, state.filter);

  const periodAggregates = computePrefectureAggregates(periodData, state.raw.prefectures);
  const muniAggregates = computeMunicipalityAggregates(periodData, state.raw.municipalities);
  const newlyVisited = state.filter.year != null && !state.timelapse.playing ? computeNewlyVisitedInYear(globalAggregates, state.filter.year) : null;

  // Exclusion zones only affect ranking/pins/visit-lists/route — never the
  // prefecture/municipality "visited" status or the overall stats, so this is
  // a further-filtered view used only by those specific consumers.
  const displayData = applyExclusionZones(periodData, state.zones);

  return { privacyData, globalAggregates, globalMuniAggregates, periodData, periodAggregates, muniAggregates, newlyVisited, displayData };
}

// ---------- Rendering ----------

export function render() {
  if (!state.raw) return;
  state.renderGen += 1;

  el.btnBack.disabled = !canGoBack(state);
  el.btnForward.disabled = !canGoForward(state);

  el.tabRoute.disabled = state.privacy;
  if (state.privacy && state.tab === 'route') state.tab = 'map';

  // issue #21 (写真のみモード): timeline-derived tabs/controls are
  // meaningless with zero visits/pathSegments, so they're hidden outright
  // here rather than shown in an always-empty state (unlike the
  // privacy-mode route tab above, which stays visible-but-disabled since
  // there the underlying data still exists, just hidden).
  el.tabRoute.hidden = state.photosOnlyMode;
  document.querySelector('.tab-btn[data-tab="chronology"]').hidden = state.photosOnlyMode;
  document.querySelector('.tab-btn[data-tab="stats"]').hidden = state.photosOnlyMode;
  el.clusterFilter.hidden = state.photosOnlyMode;
  el.btnTimelapsePlay.hidden = state.photosOnlyMode;
  el.btnTimelapseReset.hidden = state.photosOnlyMode;
  el.photosOnlyBanner.hidden = !state.photosOnlyMode;
  if (state.photosOnlyMode && (state.tab === 'route' || state.tab === 'chronology' || state.tab === 'stats')) {
    state.tab = 'map';
  }

  el.btnPhotoToggle.disabled = state.privacy;
  el.btnRoutePhotoToggle.disabled = state.privacy;
  if (state.privacy) state.photoLayerVisible = false;
  el.btnPhotoToggle.classList.toggle('active', state.photoLayerVisible);
  el.btnRoutePhotoToggle.classList.toggle('active', state.photoLayerVisible);

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  });
  el.mapScreen.hidden = state.tab !== 'map';
  el.routeScreen.hidden = state.tab !== 'route';
  el.chronologyScreen.hidden = state.tab !== 'chronology';
  el.statsScreen.hidden = state.tab !== 'stats';

  const view = currentView(state);
  const showingPrefRanking = state.tab === 'map' && view.view === 'prefecture' && !state.privacy;
  if (!showingPrefRanking) {
    resetLabelQueue();
    ui.currentDetailPrefCode = null;
  }

  const derived = getDerived();
  renderBreadcrumb();

  const visitedPrefCount = [...derived.periodAggregates.values()].filter((e) => e.stayCount > 0 || e.firstEpoch != null).length;
  const visitedMuniCount = [...derived.muniAggregates.values()].filter((e) => e.stayCount > 0).length;
  const passOnlyMuniCount = [...derived.muniAggregates.values()].filter(isPassOnly).length;
  if (state.granularity === 'municipality') {
    const passNote = passOnlyMuniCount > 0 ? `<span class="pass-only-note"><span class="pass-only-swatch"></span>通過のみ ${passOnlyMuniCount}</span>` : '';
    el.prefBadge.innerHTML = `<span class="count-num">${visitedMuniCount}</span> / ${state.raw.municipalities.length} 市区町村${passNote}`;
  } else {
    el.prefBadge.innerHTML = `<span class="count-num">${visitedPrefCount}</span> / ${state.raw.prefectures.length} 県`;
  }

  if (state.tab === 'map') {
    renderMapTab(derived);
  } else if (state.tab === 'route') {
    renderRouteTab(derived);
  } else if (state.tab === 'chronology') {
    renderChronologyTab(derived);
  } else {
    const municipalityByCode = state.municipalityByCode;
    const stats = computeStats(derived.periodData);
    renderStats(el.statsContent, {
      stats,
      clusterRanking: computeClusterRanking(derived.displayData, { privacy: state.privacy, municipalityByCode, limit: 50, sortBy: state.sortBy }),
      sortBy: state.sortBy,
      onSortByChange: (sortBy) => {
        state.sortBy = sortBy;
        render();
      },
      privacy: state.privacy,
      newlyVisited: derived.newlyVisited,
      walkingRatio: computeWalkingComparisonRatio(stats),
      longestTrips: computeLongestTrips(derived.displayData, municipalityByCode, 10),
      dayOfWeek: computeDayOfWeekStats(derived.periodData),
      hourly: computeHourlyHistogram(derived.periodData),
      topDays: computeTopDays(derived.periodData, 5),
      dwellCapNote: computeDwellCapNote(derived.periodData),
      conquestRates: computeConquestRates(derived.muniAggregates, state.raw.municipalities, state.raw.prefectures),
      onConquestClick: (row) => {
        setGranularity('municipality');
        navigateTo(state, 'prefecture', { code: row.code });
        state.tab = 'map';
        render();
      },
    });
  }
}

// Year/month filter, cluster-distance threshold, and privacy-mode changes all
// recompute derived data from scratch (aggregates, clusters, or what's even
// visible) — a drilled-into 'place'/'prefecture' view can easily point at a
// clusterId or muniCode that no longer means the same thing afterward (e.g.
// re-clustering can merge/split clusters, changing every clusterId). Rather
// than try to carry the old selection forward, just drop back to the
// national view, per spec.
export function resetNavigationToNational() {
  state.history = [{ view: 'national', params: {} }];
  state.historyIndex = 0;
  ui.lastMapContext = null;
}

export function setGranularity(g) {
  state.granularity = g;
  document.querySelectorAll('.granularity-btn').forEach((b) => b.classList.toggle('active', b.dataset.granularity === g));
  ui.lastMapContext = null; // force a re-fit next map render
}

export let muniRedrawScheduled = false;
export function scheduleMuniViewportRedraw() {
  if (muniRedrawScheduled) return;
  muniRedrawScheduled = true;
  requestAnimationFrame(() => {
    muniRedrawScheduled = false;
    if (!state.raw || state.tab !== 'map') return;
    if (state.granularity === 'municipality' && currentView(state).view === 'national') {
      renderMapTab(getDerived());
    }
  });
}

export function renderChronologyTab(derived) {
  const events = computeChronology(derived.periodData, derived.periodAggregates, derived.muniAggregates, state.municipalityByCode, {
    includeMunicipalities: state.chronologyIncludeMuni,
  });
  renderChronology(el.chronologyContent, events, (ev) => {
    state.tab = 'map';
    if (ev.type === 'prefecture') {
      setGranularity('prefecture');
      navigateTo(state, 'prefecture', { code: ev.code });
    } else {
      setGranularity('municipality');
      navigateTo(state, 'prefecture', { code: ev.prefCode });
    }
    render();
  });
}

el.btnBack.addEventListener('click', () => {
  stopTimelapse();
  goBack(state);
  render();
});
el.btnForward.addEventListener('click', () => {
  stopTimelapse();
  goForward(state);
  render();
});

export function setPrivacy(value) {
  const wasPrivacyOn = state.privacy;
  state.privacy = value;
  window.pathBrowser.setPrivacyMode(value);
  el.btnPrivacy.classList.toggle('off', !state.privacy);
  el.privacyLabel.textContent = state.privacy ? 'プライバシーモード ON' : 'プライバシーモード OFF';
  document.getElementById('privacy-icon').textContent = state.privacy ? '\u{1F512}' : '\u{1F513}';
  if (ui.map) applyPrivacyZoomLimit(ui.map, state.privacy);
  resetNavigationToNational();
  // issue #21: render()'s own privacy gate (`if (state.privacy) state.photoLayerVisible = false`)
  // is one-way — once forced false it stays false even after privacy turns
  // back off. That's fine in normal mode (photos are optional there), but in
  // 写真のみモード the photo layer *is* the map's whole purpose, so once the
  // user turns privacy off, show it automatically rather than leaving them
  // to find the toggle button on an otherwise-empty grey map.
  if (state.photosOnlyMode && wasPrivacyOn && !value) {
    state.photoLayerVisible = true;
  }
  render();
}

el.btnPrivacy.addEventListener('click', () => setPrivacy(!state.privacy));

el.filterYear.addEventListener('change', () => {
  stopTimelapse();
  state.filter.year = el.filterYear.value ? Number(el.filterYear.value) : null;
  if (!state.filter.year) {
    state.filter.month = null;
    el.filterMonth.value = '';
  }
  resetNavigationToNational();
  render();
});
el.filterMonth.addEventListener('change', () => {
  stopTimelapse();
  state.filter.month = el.filterMonth.value ? Number(el.filterMonth.value) : null;
  resetNavigationToNational();
  render();
});

el.clusterThresholdInput.addEventListener('input', () => {
  el.clusterThresholdLabel.textContent = el.clusterThresholdInput.value + 'm';
});
el.clusterThresholdInput.addEventListener('change', () => {
  recluster(Number(el.clusterThresholdInput.value));
});

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    state.tab = btn.dataset.tab;
    render();
  });
});

document.querySelectorAll('.granularity-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    setGranularity(btn.dataset.granularity);
    render();
  });
});

el.btnExportPng.addEventListener('click', async () => {
  const rect = el.leafletMapDiv.getBoundingClientRect();
  const original = el.btnExportPng.innerHTML;
  try {
    const savedPath = await window.pathBrowser.exportMapPng({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
    el.btnExportPng.innerHTML = savedPath ? '&#9989;' : original;
  } finally {
    setTimeout(() => {
      el.btnExportPng.innerHTML = original;
    }, 1500);
  }
});

el.chronologyIncludeMuni.addEventListener('change', () => {
  state.chronologyIncludeMuni = el.chronologyIncludeMuni.checked;
  render();
});

// ---------- Startup ----------

// Keep the main process's reverse-geocode gate in sync with the renderer's
// initial privacy state (see main.js app:set-privacy-mode) — matters after a
// page reload, where the main process may still remember an earlier OFF.
window.pathBrowser.setPrivacyMode(state.privacy);
wireLoading();
wirePhotos();
wireRouteTab();
wireTimelapse();
wireSettings();
installTestHooks();
refreshRecentFilesList();
initPhotoLink();
