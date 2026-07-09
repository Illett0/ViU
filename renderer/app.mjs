import { createState, currentView, navigateTo, goBack, goForward, canGoBack, canGoForward } from './state.mjs';
import {
  initMap,
  applyPrivacyZoomLimit,
  renderNational,
  renderNationalMunicipality,
  renderPrefectureMunicipality,
  mainlandBounds,
  findMunicipalityCodeForPoint,
  renderClusterMarkers,
  clearMarkers,
} from './mapView.mjs';
import { initRouteMap, renderRoute, clearRoute, colorForMode } from './routeView.mjs';
import { renderPhotoLayer, clearPhotoLayer } from './photoView.mjs';
import { renderStats, modeLabel, formatDuration } from './statsView.mjs';
import { initZoneMap, renderZoneCircles, renderPendingCircle, renderZoneList, renderSuggestions } from './settingsView.mjs';
import { renderChronology } from './chronologyView.mjs';
import {
  applyPrivacy,
  applyExclusionZones,
  isInAnyZone,
  filterByPeriod,
  filterUpToPeriod,
  distanceMeters,
  computePrefectureAggregates,
  computeMunicipalityAggregates,
  computeConquestRates,
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
} from './aggregate.mjs';

const state = createState();
state.clusterThreshold = 50;
state.municipalityByCode = new Map();
state.renderGen = 0;
state.granularity = 'prefecture';
state.zones = [];
state.sortBy = 'count';
state.chronologyIncludeMuni = false;
state.dismissedSuggestions = new Set();
state.timelapse = { playing: false, timer: null, steps: [], index: -1 };
// Persists for the whole session (keyed by clusterId), so revisiting a
// prefecture shows previously-fetched detail names instantly. Backed by the
// existing disk cache in lib/nominatim.js (keyed by placeId/coords), so this
// is purely a renderer-side memo to avoid redundant IPC round-trips.
state.placeLabelCache = new Map(); // clusterId -> { status: 'pending'|'done'|'error', label }
state.photos = []; // scanned photos with a location ({filePath, lat, lng, takenAtMs, takenAtIsFallback, source})
state.photoLayerVisible = false;
state.linkedPhotoFolder = null;

const el = {
  btnOpen: document.getElementById('btn-open-file'),
  btnOpenMain: document.getElementById('btn-open-file-main'),
  welcome: document.getElementById('welcome-screen'),
  recentFilesSection: document.getElementById('recent-files-section'),
  recentFilesList: document.getElementById('recent-files-list'),
  progressScreen: document.getElementById('progress-screen'),
  progressFill: document.getElementById('progress-bar-fill'),
  progressLabel: document.getElementById('progress-label'),
  privacyNoticeScreen: document.getElementById('privacy-notice-screen'),
  btnPrivacyNoticeContinue: document.getElementById('btn-privacy-notice-continue'),
  mapScreen: document.getElementById('map-screen'),
  routeScreen: document.getElementById('route-screen'),
  routeMapDiv: document.getElementById('route-map'),
  routeMessage: document.getElementById('route-message'),
  routeLegend: document.getElementById('route-legend'),
  chronologyScreen: document.getElementById('chronology-screen'),
  chronologyContent: document.getElementById('chronology-content'),
  chronologyIncludeMuni: document.getElementById('chronology-include-muni'),
  statsScreen: document.getElementById('stats-screen'),
  statsContent: document.getElementById('stats-content'),
  tabs: document.getElementById('tabs'),
  tabRoute: document.getElementById('tab-route'),
  breadcrumb: document.getElementById('breadcrumb'),
  btnBack: document.getElementById('btn-back'),
  btnForward: document.getElementById('btn-forward'),
  btnSettings: document.getElementById('btn-settings'),
  btnPrivacy: document.getElementById('btn-privacy'),
  privacyLabel: document.getElementById('privacy-label'),
  periodFilter: document.getElementById('period-filter'),
  filterYear: document.getElementById('filter-year'),
  filterMonth: document.getElementById('filter-month'),
  clusterFilter: document.getElementById('cluster-filter'),
  clusterThresholdInput: document.getElementById('cluster-threshold'),
  clusterThresholdLabel: document.getElementById('cluster-threshold-label'),
  leafletMapDiv: document.getElementById('leaflet-map'),
  prefBadge: document.getElementById('prefecture-count-badge'),
  islandBadge: document.getElementById('island-badge'),
  detailPanel: document.getElementById('detail-panel'),
  detailPanelContent: document.getElementById('detail-panel-content'),
  btnTimelapsePlay: document.getElementById('btn-timelapse-play'),
  btnTimelapseReset: document.getElementById('btn-timelapse-reset'),
  btnExportPng: document.getElementById('btn-export-png'),
  timelapseOverlay: document.getElementById('timelapse-overlay'),
  timelapsePeriod: document.getElementById('timelapse-period'),
  timelapseCount: document.getElementById('timelapse-count'),
  settingsScreen: document.getElementById('settings-screen'),
  settingsImportBanner: document.getElementById('settings-import-banner'),
  btnSettingsClose: document.getElementById('btn-settings-close'),
  btnSettingsGotoMap: document.getElementById('btn-settings-goto-map'),
  zoneMapDiv: document.getElementById('zone-map'),
  zoneSuggestions: document.getElementById('zone-suggestions'),
  zonePending: document.getElementById('zone-pending'),
  zoneRadiusInput: document.getElementById('zone-radius'),
  zoneRadiusLabel: document.getElementById('zone-radius-label'),
  btnZoneConfirm: document.getElementById('btn-zone-confirm'),
  btnZoneCancel: document.getElementById('btn-zone-cancel'),
  zoneList: document.getElementById('zone-list'),
  zoneHiddenCount: document.getElementById('zone-hidden-count'),
  btnClearCache: document.getElementById('btn-clear-cache'),
  cacheClearResult: document.getElementById('cache-clear-result'),
  dayViewOverlay: document.getElementById('day-view-overlay'),
  dayViewTitle: document.getElementById('day-view-title'),
  dayViewMapDiv: document.getElementById('day-view-map'),
  dayViewMessage: document.getElementById('day-view-message'),
  dayViewLegend: document.getElementById('day-view-legend'),
  btnDayViewClose: document.getElementById('btn-day-view-close'),
  btnPhotoToggle: document.getElementById('btn-photo-toggle'),
  btnRoutePhotoToggle: document.getElementById('btn-route-photo-toggle'),
  photoLinkedFolder: document.getElementById('photo-linked-folder'),
  btnLinkPhotoFolder: document.getElementById('btn-link-photo-folder'),
  btnRescanPhotoFolder: document.getElementById('btn-rescan-photo-folder'),
  photoScanProgress: document.getElementById('photo-scan-progress'),
  photoScanProgressFill: document.getElementById('photo-scan-progress-fill'),
  photoScanSummary: document.getElementById('photo-scan-summary'),
  photoLightboxOverlay: document.getElementById('photo-lightbox-overlay'),
  photoLightboxImg: document.getElementById('photo-lightbox-img'),
  photoLightboxCaption: document.getElementById('photo-lightbox-caption'),
  btnPhotoLightboxClose: document.getElementById('btn-photo-lightbox-close'),
};

let map = null;
let routeMap = null;
let dayViewMap = null;
const dayViewLayerRef = { layer: null };
const dayViewMarkerLayerRef = { layer: null };
let zoneMap = null;
let lastMapContext = null; // tracks view+granularity so we only fitBounds on real navigation, not on every pan/zoom redraw
let pendingZoneCenter = null;
const geojsonLayerRef = { layer: null };
const photoLayerRef = { layer: null }; // 制覇マップ側の写真レイヤー
const routePhotoLayerRef = { layer: null }; // 経路マップ側の写真レイヤー（別Leafletインスタンスなので別レイヤー参照が要る）
const markerLayerRef = { layer: null };
const routeLayerRef = { layer: null };
const zoneLayerRef = { layer: null };
const zonePendingLayerRef = { layer: null };

// ---- On-demand detail-name fetch queue for the prefecture-detail ranking
// list (see fetchLabelsForVisibleRows below): sequential, visible-rows-first,
// discarded on navigation away from the panel that queued them. ----
let labelQueue = [];
let labelQueueRunning = false;
let labelQueueToken = 0;
let labelPanelObserver = null;
let currentDetailPrefCode = null;
let currentMarkersByKey = new Map();

function resetLabelQueue() {
  labelQueueToken += 1;
  labelQueue = [];
  if (labelPanelObserver) {
    labelPanelObserver.disconnect();
    labelPanelObserver = null;
  }
}

const zonesReady = window.pathBrowser.getZones().then((zones) => {
  state.zones = zones || [];
});

// ---------- Recent files (welcome screen) ----------

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
  return (n / (1024 * 1024)).toFixed(1) + 'MB';
}

function formatImportedAt(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

async function refreshRecentFilesList() {
  const list = await window.pathBrowser.getRecentFiles();
  renderRecentFilesList(list || []);
}

function renderRecentFilesList(list) {
  el.recentFilesSection.hidden = list.length === 0;
  el.recentFilesList.innerHTML = list
    .map(
      (e) => `
      <li class="recent-file-item" data-hash="${e.hash}">
        <button class="recent-file-open" data-hash="${e.hash}">
          <span class="recent-file-name">${e.originalName || 'タイムライン.json'}</span>
          <span class="recent-file-meta">${formatImportedAt(e.lastOpenedAt || e.importedAt)} ・ ${formatBytes(e.sizeBytes)}</span>
        </button>
        <button class="recent-file-remove" data-hash="${e.hash}" title="履歴から削除（バックアップも削除されます）">&times;</button>
      </li>`
    )
    .join('');

  el.recentFilesList.querySelectorAll('.recent-file-open').forEach((btn) => {
    btn.addEventListener('click', () => openRecentFile(btn.dataset.hash));
  });
  el.recentFilesList.querySelectorAll('.recent-file-remove').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const updated = await window.pathBrowser.removeRecentFile(btn.dataset.hash);
      renderRecentFilesList(updated || []);
    });
  });
}

async function openRecentFile(hash) {
  const resolved = await window.pathBrowser.resolveRecentFile(hash);
  if (!resolved) {
    // Neither the original path nor the internal backup could be found
    // (e.g. the backup was manually deleted from disk outside the app).
    el.progressLabel.textContent = '';
    alert('このファイルは見つかりませんでした（元のファイル・アプリ内バックアップともに利用できません）。履歴から削除します。');
    const updated = await window.pathBrowser.removeRecentFile(hash);
    renderRecentFilesList(updated || []);
    return;
  }
  await openFile(resolved);
}

refreshRecentFilesList();

// ---------- Photo layer (写真連携 Stage1) ----------

function resolvePlaceName(lat, lng) {
  if (!state.muniGeoJSON) return null;
  const code = findMunicipalityCodeForPoint(state.muniGeoJSON, lat, lng);
  return code ? municipalityName(state.municipalityByCode, code) : null;
}

// Reuses state.filter.year/month (the same period filter driving the map and
// stats), but — unlike visits/activities, which carry a per-point UTC-offset
// for exact local-calendar-day math (see worker/parseWorker.js) — a photo's
// taken-at timestamp is just read against the host machine's local timezone.
// Good enough for a year/month filter; a trip that crosses a timezone
// boundary won't meaningfully change which month a photo falls in.
function photoMatchesPeriod(photo) {
  const { year, month } = state.filter;
  if (year == null && month == null) return true;
  if (photo.takenAtMs == null) return false;
  const d = new Date(photo.takenAtMs);
  if (year != null && d.getFullYear() !== year) return false;
  if (month != null && d.getMonth() + 1 !== month) return false;
  return true;
}

function getVisiblePhotos() {
  if (state.privacy) return []; // Photo layer is disabled entirely under privacy mode, like the route map.
  return state.photos.filter((p) => photoMatchesPeriod(p) && !isInAnyZone(p.lat, p.lng, state.zones));
}

function openPhotoLightbox(dataUrl, photo) {
  el.photoLightboxImg.src = dataUrl;
  const name = photo.filePath.split(/[\\/]/).pop();
  const place = resolvePlaceName(photo.lat, photo.lng);
  el.photoLightboxCaption.textContent = [name, place].filter(Boolean).join(' — ');
  el.photoLightboxOverlay.hidden = false;
}

function closePhotoLightbox() {
  el.photoLightboxOverlay.hidden = true;
  el.photoLightboxImg.src = ''; // Release the (potentially large) decoded image promptly.
}

function togglePhotoLayer() {
  if (state.privacy) return; // Buttons are disabled in this state too; belt and suspenders.
  state.photoLayerVisible = !state.photoLayerVisible;
  el.btnPhotoToggle.classList.toggle('active', state.photoLayerVisible);
  el.btnRoutePhotoToggle.classList.toggle('active', state.photoLayerVisible);
  render();
}

function formatPhotoScanSummary(summary) {
  if (!summary) return '';
  return `${summary.total}枚中 ${summary.withLocation}枚に位置情報が見つかりました（Exif ${summary.withLocationExif} / Takeout ${summary.withLocationTakeout}）`;
}

async function startPhotoScan(folder) {
  el.btnLinkPhotoFolder.disabled = true;
  el.btnRescanPhotoFolder.disabled = true;
  el.photoScanProgress.hidden = false;
  el.photoScanProgressFill.style.width = '0%';
  el.photoScanSummary.textContent = 'スキャン中...';

  const unsubscribe = window.pathBrowser.onPhotoScanProgress((payload) => {
    const pct = payload.total > 0 ? Math.round((payload.current / payload.total) * 100) : 0;
    el.photoScanProgressFill.style.width = pct + '%';
    el.photoScanSummary.textContent = `スキャン中... (${payload.current}/${payload.total})`;
  });

  try {
    const result = await window.pathBrowser.scanPhotoFolder(folder);
    state.linkedPhotoFolder = folder;
    state.photos = (result.photos || []).filter((p) => p.hasLocation);
    el.photoLinkedFolder.textContent = folder;
    el.photoScanSummary.textContent = formatPhotoScanSummary(result.summary);
    el.btnRescanPhotoFolder.hidden = false;
  } catch (err) {
    el.photoScanSummary.textContent = `スキャンに失敗しました: ${err && err.message ? err.message : err}`;
  } finally {
    unsubscribe();
    el.photoScanProgress.hidden = true;
    el.btnLinkPhotoFolder.disabled = false;
    el.btnRescanPhotoFolder.disabled = false;
    render(); // No-op until a timeline file is loaded (render() itself guards on state.raw).
  }
}

// Runs once at startup: if a folder was linked in a previous session,
// re-scan it (cheap — unchanged files are skipped via the on-disk cache, see
// worker/photoScanWorker.js) so photos are already available the moment the
// user toggles the layer on, without an extra manual "re-scan" click.
async function initPhotoLink() {
  const folder = await window.pathBrowser.getLinkedPhotoFolder();
  if (!folder) return;
  el.photoLinkedFolder.textContent = folder;
  el.btnRescanPhotoFolder.hidden = false;
  await startPhotoScan(folder);
}

initPhotoLink();

el.btnLinkPhotoFolder.addEventListener('click', async () => {
  const folder = await window.pathBrowser.choosePhotoFolder();
  if (folder) await startPhotoScan(folder);
});
el.btnRescanPhotoFolder.addEventListener('click', () => {
  if (state.linkedPhotoFolder) startPhotoScan(state.linkedPhotoFolder);
});
el.btnPhotoToggle.addEventListener('click', togglePhotoLayer);
el.btnRoutePhotoToggle.addEventListener('click', togglePhotoLayer);
el.btnPhotoLightboxClose.addEventListener('click', closePhotoLightbox);

// ---------- File loading ----------

// `explicitPath`, when given (reopening from the recent-files list), skips
// the native file-choose dialog entirely.
async function openFile(explicitPath) {
  const filePath = explicitPath || (await window.pathBrowser.chooseFile());
  if (!filePath) return;

  stopTimelapse();
  el.welcome.hidden = true;
  el.progressScreen.hidden = false;
  el.progressFill.style.width = '0%';
  el.progressLabel.textContent = '読み込み中...';

  const unsubscribe = window.pathBrowser.onProgress((payload) => {
    const phaseLabel =
      {
        reading: 'ファイル読み込み中',
        parsing: 'JSON解析中',
        normalizing: '位置情報を正規化中',
        municipality: '市区町村を判定中',
        clustering: '滞在地点をクラスタリング中',
        finalizing: '仕上げ中',
      }[payload.phase] || payload.phase;
    const pct = payload.total > 0 ? Math.round((payload.current / payload.total) * 100) : 0;
    el.progressFill.style.width = pct + '%';
    el.progressLabel.textContent = `${phaseLabel} (${payload.current}/${payload.total})`;
  });

  try {
    const [result, prefGeoJSON, muniGeoJSON] = await Promise.all([
      window.pathBrowser.parseFile(filePath),
      window.pathBrowser.getPrefectureGeoJSON(),
      window.pathBrowser.getMunicipalityGeoJSON(),
      zonesReady,
    ]);
    state.raw = result;
    state.prefGeoJSON = prefGeoJSON;
    state.muniGeoJSON = muniGeoJSON;
    state.municipalityByCode = buildMunicipalityIndex(result.municipalities);
    state.clusterThreshold = 50;
    state.history = [{ view: 'national', params: {} }];
    state.historyIndex = 0;
    state.filter = { year: null, month: null };
    state.dismissedSuggestions = new Set();
    lastMapContext = null;

    populateYearOptions();
    el.clusterThresholdInput.value = '50';
    el.clusterThresholdLabel.textContent = '50m';

    el.progressScreen.hidden = true;
    el.tabs.hidden = false;
    el.periodFilter.hidden = false;
    el.clusterFilter.hidden = false;
    el.btnSettings.hidden = false;
    el.mapScreen.hidden = false;

    if (!map) {
      map = initMap(el.leafletMapDiv);
      map.on('moveend zoomend', scheduleMuniViewportRedraw);
    }
    applyPrivacyZoomLimit(map, state.privacy);

    render();
    // Every import (not just the first) routes through a privacy-notice
    // screen and then the exclusion-zone settings screen before the user
    // starts browsing — pins/rankings/route are visible immediately once
    // this is skipped, so reviewing HOME/WORK-type suggestions first is a
    // privacy checkpoint, not a one-time tutorial. The notice screen exists
    // because the exclusion-zone screen itself necessarily shows precise
    // home/work-candidate locations — worth a beat of "if you're
    // screen-sharing or recording, be aware" before that appears. Both
    // steps are skippable (privacy-notice via "続ける", settings via
    // "マップへ"/"閉じる" — closeSettings()).
    el.tabs.hidden = true;
    el.mapScreen.hidden = true;
    el.privacyNoticeScreen.hidden = false;
    refreshRecentFilesList(); // keep the welcome screen's list current for next time
  } catch (err) {
    el.progressLabel.textContent = '読み込みに失敗しました: ' + err.message;
  } finally {
    unsubscribe();
  }
}

function populateYearOptions() {
  const years = new Set();
  for (const v of state.raw.visits) if (v.year) years.add(v.year);
  for (const p of state.raw.pathPoints) if (p[4]) years.add(p[4]);
  const sorted = [...years].sort();

  el.filterYear.innerHTML = '<option value="">すべて</option>' + sorted.map((y) => `<option value="${y}">${y}年</option>`).join('');
  el.filterMonth.innerHTML =
    '<option value="">すべて</option>' + Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}">${m}月</option>`).join('');
}

// ---------- Re-clustering ----------

async function recluster(threshold) {
  if (!state.raw) return;
  state.clusterThreshold = threshold;
  el.clusterThresholdLabel.textContent = threshold + 'm （再計算中…）';

  const points = state.raw.visits.map((v) => ({ lat: v.lat, lng: v.lng, placeId: v.placeId }));
  try {
    const result = await window.pathBrowser.recluster(state.raw.fingerprint, threshold, points);
    state.raw.visits.forEach((v, i) => {
      v.clusterId = result.assignment[i];
    });
    state.raw.clusters = result.clusters;
    el.clusterThresholdLabel.textContent = threshold + 'm';
    resetNavigationToNational();
    render();
  } catch (err) {
    el.clusterThresholdLabel.textContent = threshold + 'm （失敗）';
    console.error('recluster failed', err);
  }
}

// ---------- Derived data ----------

// Exact point-in-polygon lookup, falling back to nearest-centroid only for
// the rare point that misses every polygon (e.g. a coastline simplification gap).
function nearestMunicipalityCode(lat, lng) {
  const exact = state.muniGeoJSON && findMunicipalityCodeForPoint(state.muniGeoJSON, lat, lng);
  if (exact) return exact;

  let best = null;
  let bestDist = Infinity;
  for (const m of state.raw.municipalities) {
    const d = distanceMeters(lat, lng, m.centroid.lat, m.centroid.lng);
    if (d < bestDist) {
      bestDist = d;
      best = m.code;
    }
  }
  return best;
}

// ---------- On-demand detail-name fetching for ranking rows ----------

function updateRowLabelDisplay(clusterId) {
  const entry = state.placeLabelCache.get(clusterId);
  const target = el.detailPanelContent.querySelector(`.detail-name[data-cluster-id="${clusterId}"]`);
  if (target) {
    const muniName = target.dataset.muniName;
    target.textContent = formatPlaceLabel(muniName, entry);
  }
  const marker = currentMarkersByKey.get(clusterId);
  if (marker) {
    const muniName = marker.__muniName;
    if (muniName) marker.setTooltipContent(`${formatPlaceLabel(muniName, entry)} — 滞在 ${marker.__count} 回`);
  }
}

function enqueueLabelFetch(clusterId, modal, priority) {
  if (state.placeLabelCache.has(clusterId)) return;
  state.placeLabelCache.set(clusterId, { status: 'pending', label: null });
  const item = { clusterId, modal };
  if (priority) labelQueue.unshift(item);
  else labelQueue.push(item);
  runLabelQueue();
}

async function runLabelQueue() {
  if (labelQueueRunning) return;
  labelQueueRunning = true;
  const myToken = labelQueueToken;
  try {
    while (labelQueue.length > 0 && myToken === labelQueueToken) {
      const { clusterId, modal } = labelQueue.shift();
      let result;
      try {
        result = await window.pathBrowser.reverseGeocode(modal.placeId, modal.lat, modal.lng);
      } catch {
        result = { label: null, error: 'failed' };
      }
      if (myToken !== labelQueueToken) break; // panel closed/navigated away mid-fetch — discard
      state.placeLabelCache.set(clusterId, { status: result.error ? 'error' : 'done', label: result.label });
      updateRowLabelDisplay(clusterId);
    }
  } finally {
    labelQueueRunning = false;
  }
}

// Wires an IntersectionObserver over the ranking rows so only rows that have
// actually scrolled into view get queued, and newly-visible rows jump to the
// front — an off-screen row should never get fetched ahead of a visible one.
function watchRankingRowsForLabelFetch(rows, scopedVisits) {
  if (labelPanelObserver) labelPanelObserver.disconnect();

  const rowByClusterId = new Map(rows.filter((r) => r.clusterId != null).map((r) => [String(r.clusterId), r]));

  labelPanelObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const clusterId = Number(entry.target.dataset.clusterId);
        if (state.placeLabelCache.has(clusterId)) continue;
        const memberVisits = scopedVisits.filter((v) => v.clusterId === clusterId);
        const modal = computeModalVisitLocation(memberVisits);
        if (modal) enqueueLabelFetch(clusterId, modal, true);
      }
    },
    { root: el.detailPanel, threshold: 0.1 }
  );

  el.detailPanelContent.querySelectorAll('.detail-name[data-cluster-id]').forEach((elRow) => {
    if (rowByClusterId.has(elRow.dataset.clusterId)) labelPanelObserver.observe(elRow);
  });
}

function getDerived() {
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

function render() {
  if (!state.raw) return;
  state.renderGen += 1;

  el.btnBack.disabled = !canGoBack(state);
  el.btnForward.disabled = !canGoForward(state);

  el.tabRoute.disabled = state.privacy;
  if (state.privacy && state.tab === 'route') state.tab = 'map';

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
    currentDetailPrefCode = null;
  }

  const derived = getDerived();
  renderBreadcrumb();

  const visitedPrefCount = [...derived.periodAggregates.values()].filter((e) => e.stayCount > 0 || e.firstEpoch != null).length;
  const visitedMuniCount = [...derived.muniAggregates.values()].filter((e) => e.stayCount > 0).length;
  if (state.granularity === 'municipality') {
    el.prefBadge.innerHTML = `<span class="count-num">${visitedMuniCount}</span> / ${state.raw.municipalities.length} 市区町村`;
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
function resetNavigationToNational() {
  state.history = [{ view: 'national', params: {} }];
  state.historyIndex = 0;
  lastMapContext = null;
}

function setGranularity(g) {
  state.granularity = g;
  document.querySelectorAll('.granularity-btn').forEach((b) => b.classList.toggle('active', b.dataset.granularity === g));
  lastMapContext = null; // force a re-fit next map render
}

let muniRedrawScheduled = false;
function scheduleMuniViewportRedraw() {
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

function renderMapTab(derived) {
  const view = currentView(state);
  // clusterId/muniCode are included so that switching between two different
  // 滞在地点 *within the same prefecture* still counts as a context change —
  // previously the key was just `place:<prefCode>:<granularity>`, identical
  // for every place in that prefecture, so `fit` only ever fired once (on
  // the very first place click) and then never again, leaving the map
  // stuck wherever it happened to be for every subsequent place selection.
  const context = `${view.view}:${view.params.code ?? ''}:${view.params.clusterId ?? ''}:${view.params.muniCode ?? ''}:${state.granularity}`;
  const fit = context !== lastMapContext;
  lastMapContext = context;

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
      map,
      geojsonLayerRef,
      state.prefGeoJSON,
      derived.periodAggregates,
      (code) => {
        navigateTo(state, 'prefecture', { code });
        render();
      },
      { selectedCode, dimmed }
    );
  } else if (view.view === 'national') {
    renderNationalMunicipality(
      map,
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
    if (view.view === 'national') map.fitBounds([[24, 122], [46, 154]], { padding: [10, 10] });
  }

  el.islandBadge.hidden = true;

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
      if (feature) map.fitBounds(mainlandBounds(feature), { padding: [20, 20] });
    }
    if (state.granularity === 'municipality') {
      renderPrefectureMunicipality(
        map,
        geojsonLayerRef,
        state.muniGeoJSON,
        prefCode,
        derived.muniAggregates,
        () => {
          // Already inside this prefecture; municipality clicks here just focus the detail panel, handled via the marker/list instead.
        },
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
    renderPhotoLayer(map, photoLayerRef, getVisiblePhotos(), { resolvePlaceName, onOpenLightbox: openPhotoLightbox });
  } else {
    clearPhotoLayer(map, photoLayerRef);
  }
}

// Gives the currently-selected 滞在地点's pin a visibly distinct style (bigger,
// accent-colored ring) so it's clear which pin the detail panel refers to,
// and brings it to the front so it isn't visually buried under others.
function highlightSelectedMarker(params) {
  const key = params.clusterId ?? (params.muniCode != null ? 'muni:' + params.muniCode : null);
  if (key == null) return;
  const marker = currentMarkersByKey.get(key);
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
const PLACE_ZOOM = 14;
const MIN_USEFUL_ZOOM = 11; // roughly "prefecture view, but pins are already distinguishable"
function zoomToSelectedMarker(params) {
  const key = params.clusterId ?? (params.muniCode != null ? 'muni:' + params.muniCode : null);
  if (key == null) return;
  const marker = currentMarkersByKey.get(key);
  if (!marker) return;
  const latlng = marker.getLatLng();
  if (map.getZoom() < MIN_USEFUL_ZOOM) {
    // Too zoomed out to tell pins apart — jump in.
    map.setView(latlng, PLACE_ZOOM);
  } else if (!map.getBounds().contains(latlng)) {
    // Already zoomed in enough to browse between pins (manually, or from an
    // earlier selection) — keep that zoom level, just make sure the newly
    // selected pin is actually on screen.
    map.panTo(latlng);
  }
  // else: already zoomed in enough and already visible — leave the view untouched.
}

// Which transport modes are currently toggled off in the route map legend —
// module-level (not part of `state`) since it's a pure display filter for
// this tab, not something that should reset navigation or be undo/redo-able.
// Not reset on file reload deliberately... actually it should be, since mode
// names are stable across imports; left as-is between renders within a
// session is fine.
const routeHiddenModes = new Set();

function renderRouteTab(derived) {
  if (!routeMap) routeMap = initRouteMap(el.routeMapDiv);
  routeMap.invalidateSize();

  // Rendered unconditionally (before the "no route data" early-return below)
  // — photos for the current period can exist even when there's no route
  // data to draw (e.g. a period with photos but no GPS trace that day).
  if (state.photoLayerVisible) {
    renderPhotoLayer(routeMap, routePhotoLayerRef, getVisiblePhotos(), { resolvePlaceName, onOpenLightbox: openPhotoLightbox });
  } else {
    clearPhotoLayer(routeMap, routePhotoLayerRef);
  }

  // No longer requires a year filter — with mode-accurate rendering the
  // full-history segment count (~8-9k) comfortably fits under routeView's
  // render cap, so "all periods" is just another period to draw.
  const segments = derived.displayData.pathSegments || [];

  if (segments.length === 0) {
    el.routeMessage.hidden = false;
    el.routeMessage.textContent = 'この期間に表示できる経路データがありません。';
    clearRoute(routeMap, routeLayerRef);
    el.routeLegend.innerHTML = '';
    return;
  }

  el.routeMessage.hidden = true;

  const visibleSegments = routeHiddenModes.size > 0 ? segments.filter((s) => !routeHiddenModes.has(s.mode)) : segments;
  renderRoute(routeMap, routeLayerRef, visibleSegments);

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

function renderChronologyTab(derived) {
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

// Wires the `.back-link` button pushed at the top of renderPrefectureDetail/
// renderPlaceDetail's markup — a local, in-panel duplicate of the header's
// global 戻る button, since that one is easy to miss while focused on the
// detail panel itself.
function wireBackLink() {
  const btn = el.detailPanelContent.querySelector('[data-nav="back"]');
  if (btn) {
    btn.addEventListener('click', () => {
      goBack(state);
      render();
    });
  }
}

function renderNationalDetail(derived) {
  const parts = [];
  parts.push('<h2>日本全体</h2>');
  parts.push('<p style="color:var(--color-text-dim); font-size:13px;">都道府県（または市区町村）をクリックすると詳細が表示されます。</p>');
  if (derived.newlyVisited && derived.newlyVisited.length > 0) {
    parts.push(`<h3>${state.filter.year}年に初めて訪れた県</h3>`);
    parts.push('<ul class="newly-visited-list">' + derived.newlyVisited.map((p) => `<li>${p.name}</li>`).join('') + '</ul>');
  }
  el.detailPanelContent.innerHTML = parts.join('');
}

function renderPrefectureDetail(derived, code) {
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

  // Exclusion-zone-filtered rows for ranking/pins/visit-lists, per spec.
  const scopedVisits = derived.displayData.visits.filter((v) => v.prefCode === code);
  const rows = computeClusterRanking({ visits: scopedVisits }, { privacy: state.privacy, municipalityByCode: state.municipalityByCode, limit: null, sortBy: state.sortBy });

  if (currentDetailPrefCode !== code) {
    resetLabelQueue();
    currentDetailPrefCode = code;
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
              ? `<span class="detail-name" data-cluster-id="${r.clusterId}" data-muni-name="${r.muniName}">${formatPlaceLabel(r.muniName, state.placeLabelCache.get(r.clusterId))}</span>`
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
  currentMarkersByKey = renderClusterMarkers(map, markerLayerRef, rows, goToRow, state.placeLabelCache);
  for (const row of rows) {
    const marker = currentMarkersByKey.get(row.clusterId ?? 'muni:' + row.muniCode);
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
        map.fitBounds(L.latLngBounds(islandRows.map((r) => [r.lat, r.lng])), { padding: [40, 40] });
      });
    }
  }
}

function renderPlaceDetail(derived, params) {
  const { clusterId, muniCode, code } = params;
  const prefEntry = derived.periodAggregates.get(code);
  const parts = [];

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
        .map((v) => (v.dateStr ? `<div class="place-item day-item" data-date="${v.dateStr}">${v.dateStr}</div>` : '<div class="place-item">-</div>'))
        .join('')
    );

    el.detailPanelContent.innerHTML = parts.join('');
    wireBackLink();
    el.detailPanelContent.querySelectorAll('.day-item[data-date]').forEach((elDay) => {
      elDay.addEventListener('click', () => openDayView(elDay.dataset.date));
    });

    if (modal) {
      const gen = state.renderGen;
      window.pathBrowser.reverseGeocode(modal.placeId, modal.lat, modal.lng).then((res) => {
        if (state.renderGen !== gen) return; // user navigated away before this resolved
        const target = el.detailPanelContent.querySelector('#nominatim-label');
        if (target) target.textContent = res.label || '（取得できませんでした）';
      });
      map.panTo([modal.lat, modal.lng]);
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
    if (row) map.panTo([row.lat, row.lng]);
  }
}

// ---------- Day view (滞在日 -> その日の経路マップ) ----------
// A lightweight modal, independent of the main map/route-tab state machine
// (so opening/closing it never disturbs the caller's navigation/history) —
// just a narrow-to-one-day rendering of the same pathSegments the route tab
// uses, via the same routeView.mjs helpers.

function openDayView(dateStr) {
  if (!state.raw) return;
  el.dayViewOverlay.hidden = false;
  el.dayViewTitle.textContent = `${dateStr} の経路`;

  if (!dayViewMap) {
    dayViewMap = initRouteMap(el.dayViewMapDiv);
  }
  // The map container was `hidden` until the line above, so Leaflet hasn't
  // been able to measure it yet.
  requestAnimationFrame(() => dayViewMap.invalidateSize());

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
    clearRoute(dayViewMap, dayViewLayerRef);
    clearMarkers(dayViewMarkerLayerRef);
    el.dayViewLegend.innerHTML = '';
    return;
  }
  el.dayViewMessage.hidden = true;

  renderRoute(dayViewMap, dayViewLayerRef, segments);

  // Visit markers for context (where the day's stays were), matching the
  // main map's orange stay-pin styling.
  if (!dayViewMarkerLayerRef.layer) dayViewMarkerLayerRef.layer = L.layerGroup().addTo(dayViewMap);
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
    dayViewMap.fitBounds(L.latLngBounds(allPoints), { padding: [30, 30] });
  }
}

function closeDayView() {
  el.dayViewOverlay.hidden = true;
}

el.btnDayViewClose.addEventListener('click', closeDayView);

function renderBreadcrumb() {
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

// ---------- Timelapse ----------

function getTimelapseSteps() {
  const keys = new Set();
  for (const v of state.raw.visits) if (v.year) keys.add(v.year + '-' + String(v.month).padStart(2, '0'));
  for (const p of state.raw.pathPoints) if (p[4]) keys.add(p[4] + '-' + String(p[5]).padStart(2, '0'));
  return [...keys].sort().map((k) => {
    const [y, m] = k.split('-');
    return { year: Number(y), month: Number(m) };
  });
}

function startTimelapse() {
  const steps = getTimelapseSteps();
  if (steps.length === 0) return;
  state.timelapse.playing = true;
  state.timelapse.steps = steps;
  state.timelapse.index = 0;
  el.btnTimelapsePlay.innerHTML = '&#9208;';
  el.timelapseOverlay.hidden = false;
  tickTimelapse();
}

function tickTimelapse() {
  if (!state.timelapse.playing) return;
  const step = state.timelapse.steps[state.timelapse.index];
  state.filter.year = step.year;
  state.filter.month = step.month;
  el.filterYear.value = String(step.year);
  el.filterMonth.value = String(step.month);
  render();

  const derived = getDerived();
  const count =
    state.granularity === 'municipality'
      ? [...derived.muniAggregates.values()].filter((e) => e.stayCount > 0).length
      : [...derived.periodAggregates.values()].filter((e) => e.stayCount > 0 || e.firstEpoch != null).length;
  el.timelapsePeriod.textContent = `${step.year}年${step.month}月`;
  el.timelapseCount.textContent = `${state.granularity === 'municipality' ? '市区町村' : '都道府県'} ${count} 件`;

  state.timelapse.index += 1;
  if (state.timelapse.index >= state.timelapse.steps.length) {
    state.timelapse.playing = false;
    el.btnTimelapsePlay.innerHTML = '&#9654;';
    return;
  }
  state.timelapse.timer = setTimeout(tickTimelapse, 500);
}

function stopTimelapse() {
  state.timelapse.playing = false;
  if (state.timelapse.timer) clearTimeout(state.timelapse.timer);
  state.timelapse.timer = null;
  el.btnTimelapsePlay.innerHTML = '&#9654;';
}

function resetTimelapse() {
  stopTimelapse();
  state.filter.year = null;
  state.filter.month = null;
  el.filterYear.value = '';
  el.filterMonth.value = '';
  el.timelapseOverlay.hidden = true;
  render();
}

// ---------- Settings / exclusion zones ----------

function computeSuggestions() {
  if (!state.raw) return [];
  const suggestions = [];
  for (const p of state.raw.frequentPlaces || []) {
    if (p.label !== 'HOME' && p.label !== 'WORK') continue;
    if (isInAnyZone(p.lat, p.lng, state.zones)) continue;
    const key = 'freq:' + (p.placeId || `${p.lat},${p.lng}`);
    if (state.dismissedSuggestions.has(key)) continue;
    const name = municipalityName(state.municipalityByCode, nearestMunicipalityCode(p.lat, p.lng));
    suggestions.push({
      key,
      text: `${p.label === 'HOME' ? '自宅' : '職場'}と推定される地点（${name}）を除外ゾーンに登録しますか？（半径300m）`,
      lat: p.lat,
      lng: p.lng,
      radiusMeters: 300,
    });
  }

  const allRanking = computeClusterRanking(applyPrivacy(state.raw, false), { privacy: false, municipalityByCode: state.municipalityByCode, limit: 1 });
  if (allRanking.length > 0) {
    const top = allRanking[0];
    const key = 'top:' + top.clusterId;
    if (!isInAnyZone(top.lat, top.lng, state.zones) && !state.dismissedSuggestions.has(key)) {
      suggestions.push({
        key,
        text: `最も滞在回数が多い地点（${top.muniName}、${top.count}回、自宅の可能性があります）を除外ゾーンに登録しますか？（半径300m）`,
        lat: top.lat,
        lng: top.lng,
        radiusMeters: 300,
      });
    }
  }
  return suggestions;
}

async function persistZones() {
  await window.pathBrowser.saveZones(state.zones);
}

function renderSettingsScreen() {
  if (!zoneMap) {
    zoneMap = initZoneMap(el.zoneMapDiv);
    zoneMap.on('click', (e) => {
      pendingZoneCenter = e.latlng;
      el.zonePending.hidden = false;
      renderPendingCircle(zoneMap, zonePendingLayerRef, pendingZoneCenter, Number(el.zoneRadiusInput.value));
    });
  }
  zoneMap.invalidateSize();
  renderZoneCircles(zoneMap, zoneLayerRef, state.zones);

  const suggestions = computeSuggestions();
  renderSuggestions(el.zoneSuggestions, suggestions, {
    onAccept: async (i) => {
      const s = suggestions[i];
      state.zones.push({ lat: s.lat, lng: s.lng, radiusMeters: s.radiusMeters });
      await persistZones();
      renderSettingsScreen();
    },
    onDismiss: (i) => {
      state.dismissedSuggestions.add(suggestions[i].key);
      renderSettingsScreen();
    },
  });

  renderZoneList(el.zoneList, state.zones, {
    labelFor: (z) => municipalityName(state.municipalityByCode, nearestMunicipalityCode(z.lat, z.lng)),
    onDelete: async (i) => {
      state.zones.splice(i, 1);
      await persistZones();
      renderSettingsScreen();
    },
  });

  if (state.raw) {
    const withZones = applyExclusionZones(applyPrivacy(state.raw, state.privacy), state.zones);
    el.zoneHiddenCount.textContent = `非表示: ${withZones.excludedVisitCount} 件`;
  } else {
    el.zoneHiddenCount.textContent = '';
  }
}

function openSettings({ fromImport = false } = {}) {
  stopTimelapse();
  el.settingsScreen.hidden = false;
  el.mapScreen.hidden = true;
  el.routeScreen.hidden = true;
  el.chronologyScreen.hidden = true;
  el.statsScreen.hidden = true;
  el.tabs.hidden = true;
  // Shown only on the auto-open-after-import path (see openFile), not when
  // the user opens settings manually via the toolbar button — it's a
  // one-time "check this before you browse" nudge, not a permanent notice.
  el.settingsImportBanner.hidden = !fromImport;
  renderSettingsScreen();
}

function closeSettings() {
  el.settingsScreen.hidden = true;
  el.tabs.hidden = false;
  render(); // re-shows whichever screen matches state.tab (mapScreen included)
  // The main Leaflet map's container was hidden (display:none) for the
  // whole privacy-notice + settings detour — Leaflet caches its container
  // size and doesn't notice a display:none→visible flip on its own, so
  // without this the map can render cut off/misaligned until the window is
  // resized or the map is panned. Must run *after* render() has actually
  // un-hidden #map-screen, otherwise it measures a still-hidden (0-size) container.
  if (map && state.tab === 'map') map.invalidateSize();
}

// ---------- Event wiring ----------

// Wrapped in a no-arg arrow function — addEventListener passes the
// MouseEvent as the first argument, which would otherwise land in openFile's
// `explicitPath` parameter (truthy, so `explicitPath || chooseFile()` skips
// the file dialog and tries to read the event object itself as a path).
el.btnOpen.addEventListener('click', () => openFile());
el.btnOpenMain.addEventListener('click', () => openFile());

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

function setPrivacy(value) {
  state.privacy = value;
  el.btnPrivacy.classList.toggle('off', !state.privacy);
  el.privacyLabel.textContent = state.privacy ? 'プライバシーモード ON' : 'プライバシーモード OFF';
  document.getElementById('privacy-icon').textContent = state.privacy ? '\u{1F512}' : '\u{1F513}';
  if (map) applyPrivacyZoomLimit(map, state.privacy);
  resetNavigationToNational();
  render();
}

el.btnPrivacy.addEventListener('click', () => setPrivacy(!state.privacy));

// Wrapped for the same reason as openFile's listeners above — openSettings
// destructures its argument (`{ fromImport = false } = {}`), so a MouseEvent
// passed straight through wouldn't crash (it just has no `.fromImport`
// property, silently yielding the correct `false` by luck) but that's
// fragile; wrapping makes the omission explicit rather than accidental.
el.btnSettings.addEventListener('click', () => openSettings());
el.btnSettingsClose.addEventListener('click', closeSettings);
el.btnSettingsGotoMap.addEventListener('click', closeSettings);

el.btnClearCache.addEventListener('click', async () => {
  const proceed = confirm('市区町村判定・クラスタリング結果とNominatimの地名キャッシュを削除します。次回ファイルを開いたときに再計算されます（除外ゾーンや最近使ったファイルの履歴は削除されません）。続けますか？');
  if (!proceed) return;
  el.btnClearCache.disabled = true;
  try {
    const { geoCount, nominatimCount } = await window.pathBrowser.clearCache();
    el.cacheClearResult.hidden = false;
    el.cacheClearResult.textContent = `キャッシュをクリアしました（判定結果 ${geoCount}件、地名 ${nominatimCount}件）。`;
  } finally {
    el.btnClearCache.disabled = false;
  }
});

el.btnPrivacyNoticeContinue.addEventListener('click', () => {
  el.privacyNoticeScreen.hidden = true;
  openSettings({ fromImport: true });
});

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

el.btnTimelapsePlay.addEventListener('click', () => {
  if (state.timelapse.playing) stopTimelapse();
  else startTimelapse();
});
el.btnTimelapseReset.addEventListener('click', resetTimelapse);

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

el.zoneRadiusInput.addEventListener('input', () => {
  el.zoneRadiusLabel.textContent = el.zoneRadiusInput.value + 'm';
  if (pendingZoneCenter) renderPendingCircle(zoneMap, zonePendingLayerRef, pendingZoneCenter, Number(el.zoneRadiusInput.value));
});
el.btnZoneConfirm.addEventListener('click', async () => {
  if (!pendingZoneCenter) return;
  state.zones.push({ lat: pendingZoneCenter.lat, lng: pendingZoneCenter.lng, radiusMeters: Number(el.zoneRadiusInput.value) });
  pendingZoneCenter = null;
  el.zonePending.hidden = true;
  renderPendingCircle(zoneMap, zonePendingLayerRef, null, 0);
  await persistZones();
  renderSettingsScreen();
});
el.btnZoneCancel.addEventListener('click', () => {
  pendingZoneCenter = null;
  el.zonePending.hidden = true;
  renderPendingCircle(zoneMap, zonePendingLayerRef, null, 0);
});

el.chronologyIncludeMuni.addEventListener('change', () => {
  state.chronologyIncludeMuni = el.chronologyIncludeMuni.checked;
  render();
});

// Exposed for UI-automation / E2E testing only (Leaflet polygon clicks are hard to
// target reliably via pixel coordinates). Not used by any normal app code path.
window.__pathBrowserTest = {
  goToPrefecture(code) {
    navigateTo(state, 'prefecture', { code });
    render();
  },
  goToPlace(params) {
    navigateTo(state, 'place', params);
    render();
  },
  setTab(tab) {
    state.tab = tab;
    render();
  },
  setPrivacy,
  setClusterThreshold(threshold) {
    return recluster(threshold);
  },
  setFilter(year, month) {
    stopTimelapse();
    state.filter.year = year ?? null;
    state.filter.month = month ?? null;
    render();
  },
  setGranularity(g) {
    setGranularity(g);
    render();
  },
  setSortBy(sortBy) {
    state.sortBy = sortBy;
    render();
  },
  openSettings,
  closeSettings,
  addZone(lat, lng, radiusMeters) {
    state.zones.push({ lat, lng, radiusMeters });
    return persistZones();
  },
  clearZones() {
    state.zones = [];
    return persistZones();
  },
  startTimelapse,
  stopTimelapse,
  resetTimelapse,
  getTimelapseState() {
    return { ...state.timelapse, steps: state.timelapse.steps.length };
  },
  getVisitedPrefectures() {
    return [...getDerived().periodAggregates.values()].filter((e) => e.stayCount > 0 || e.firstEpoch != null);
  },
  getMunicipalityAggregates() {
    return [...getDerived().muniAggregates.values()].filter((e) => e.stayCount > 0);
  },
  getClusterRanking() {
    return computeClusterRanking(getDerived().displayData, { privacy: state.privacy, municipalityByCode: state.municipalityByCode, limit: 20, sortBy: state.sortBy });
  },
  getConquestRates() {
    const derived = getDerived();
    return computeConquestRates(derived.muniAggregates, state.raw.municipalities, state.raw.prefectures);
  },
  getPlaceLabelCache() {
    return { size: state.placeLabelCache.size, entries: [...state.placeLabelCache.entries()], queueLength: labelQueue.length, running: labelQueueRunning };
  },
  getMapZoom() {
    return map ? { zoom: map.getZoom(), center: map.getCenter(), context: lastMapContext } : null;
  },
};
