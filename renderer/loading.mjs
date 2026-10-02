// Welcome-screen recent files, timeline/photos-only loading, and re-clustering.

import { initMap, applyPrivacyZoomLimit } from './mapView.mjs';
import { buildMunicipalityIndex } from './aggregate.mjs';
import { el, state, ui, zonesReady } from './context.mjs';
import { applyPhotoEstimates } from './photos.mjs';
import { stopTimelapse } from './timelapse.mjs';
import { handleMapBackgroundClick } from './mapTab.mjs';
import { render, resetNavigationToNational, scheduleMuniViewportRedraw } from './app.mjs';

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024 * 1024) return Math.round(n / 1024) + 'KB';
  return (n / (1024 * 1024)).toFixed(1) + 'MB';
}

export function formatImportedAt(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export async function refreshRecentFilesList() {
  const list = await window.pathBrowser.getRecentFiles();
  renderRecentFilesList(list || []);
}

export function renderRecentFilesList(list) {
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

export async function openRecentFile(hash) {
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

// `explicitPath`, when given (reopening from the recent-files list), skips
// the native file-choose dialog entirely.
export async function openFile(explicitPath) {
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
    state.photosOnlyMode = false; // in case this is reached from within 写真のみモード (header's "ファイルを開く")
    state.prefGeoJSON = prefGeoJSON;
    state.muniGeoJSON = muniGeoJSON;
    await finishLoadingIntoApp();
  } catch (err) {
    el.progressLabel.textContent = '読み込みに失敗しました: ' + err.message;
  } finally {
    unsubscribe();
  }
}

// issue #21: entry point for people who don't have a Google Timeline export
// at all — skips straight to plotting linked photos on the map. Populates
// state.raw with a *shape-valid but empty* stub (real prefecture/municipality
// reference lists, zero visits/activities/pathPoints/etc.) rather than
// leaving it null, so every existing state.raw.xxx access in this file (and
// mapView.mjs's choropleth, which already degrades to an all-grey "no visits"
// rendering given an empty aggregate) keeps working unmodified. The
// reference lists specifically (not empty arrays) matter for correctness,
// not just polish — see finishLoadingIntoApp()'s buildMunicipalityIndex call,
// which resolvePlaceName() (photo popup/lightbox captions) depends on.
export async function openPhotosOnly() {
  stopTimelapse();
  el.welcome.hidden = true;
  el.progressScreen.hidden = false;
  el.progressFill.style.width = '0%';
  el.progressLabel.textContent = '読み込み中...';

  try {
    const [refLists, prefGeoJSON, muniGeoJSON] = await Promise.all([
      window.pathBrowser.getReferenceLists(),
      window.pathBrowser.getPrefectureGeoJSON(),
      window.pathBrowser.getMunicipalityGeoJSON(),
      zonesReady,
    ]);
    state.raw = {
      fingerprint: 'photos-only',
      prefectures: refLists.prefectures,
      municipalities: refLists.municipalities,
      visits: [],
      activities: [],
      pathPoints: [],
      pathSegments: [],
      clusters: [],
      frequentPlaces: [],
    };
    state.photosOnlyMode = true;
    state.prefGeoJSON = prefGeoJSON;
    state.muniGeoJSON = muniGeoJSON;
    state.photoLayerVisible = true; // otherwise the map would show nothing at all until the user finds the toggle
    await finishLoadingIntoApp();
  } catch (err) {
    el.progressLabel.textContent = '読み込みに失敗しました: ' + err.message;
  }
}

// Shared tail of openFile()/openPhotosOnly() — everything from here on only
// cares that state.raw/prefGeoJSON/muniGeoJSON are already assigned, not
// where they came from.
export async function finishLoadingIntoApp() {
  state.municipalityByCode = buildMunicipalityIndex(state.raw.municipalities);
  state.clusterThreshold = 50;
  applyPhotoEstimates(); // a folder linked before this was open may now gain Stage3 estimates
  state.history = [{ view: 'national', params: {} }];
  state.historyIndex = 0;
  state.filter = { year: null, month: null };
  state.dismissedSuggestions = new Set();
  ui.lastMapContext = null;

  populateYearOptions();
  el.clusterThresholdInput.value = '50';
  el.clusterThresholdLabel.textContent = '50m';

  el.progressScreen.hidden = true;
  el.tabs.hidden = false;
  el.periodFilter.hidden = false;
  el.clusterFilter.hidden = false;
  el.btnSettings.hidden = false;
  el.mapScreen.hidden = false;

  if (!ui.map) {
    ui.map = initMap(el.leafletMapDiv);
    ui.map.on('moveend zoomend', scheduleMuniViewportRedraw);
    ui.map.on('click', handleMapBackgroundClick);
  }
  applyPrivacyZoomLimit(ui.map, state.privacy);

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
}

export function populateYearOptions() {
  const years = new Set();
  for (const v of state.raw.visits) if (v.year) years.add(v.year);
  for (const p of state.raw.pathPoints) if (p[4]) years.add(p[4]);
  // Also gather years from linked photos' taken-at dates — necessary for 写真
  // のみモード (where visits/pathPoints are always empty, so without this the
  // period filter would only ever offer "すべて"), and a straightforward
  // improvement in normal mode too when a linked photo folder has photos
  // outside the timeline's own date range.
  for (const p of state.rawPhotos) {
    if (p.takenAtMs != null) years.add(new Date(p.takenAtMs).getFullYear());
  }
  const sorted = [...years].sort();

  el.filterYear.innerHTML = '<option value="">すべて</option>' + sorted.map((y) => `<option value="${y}">${y}年</option>`).join('');
  el.filterMonth.innerHTML =
    '<option value="">すべて</option>' + Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}">${m}月</option>`).join('');
}

// ---------- Re-clustering ----------

export async function recluster(threshold) {
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

export function wireLoading() {
  // Wrapped in a no-arg arrow function — addEventListener passes the
  // MouseEvent as the first argument, which would otherwise land in openFile's
  // `explicitPath` parameter (truthy, so `explicitPath || chooseFile()` skips
  // the file dialog and tries to read the event object itself as a path).
  el.btnOpen.addEventListener('click', () => openFile());
  el.btnOpenMain.addEventListener('click', () => openFile());
  el.btnPhotosOnly.addEventListener('click', () => openPhotosOnly());
}
