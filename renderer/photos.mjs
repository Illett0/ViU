// Photo layer (写真連携): scanning, Stage3 location estimates, lightbox.

import { findMunicipalityCodeForPoint } from './mapView.mjs';
import { isInAnyZone, distanceMeters, municipalityName, estimatePhotoLocations } from './aggregate.mjs';
import { el, state } from './context.mjs';
import { populateYearOptions } from './loading.mjs';
import { render } from './app.mjs';

export function resolvePlaceName(lat, lng) {
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
export function photoMatchesPeriod(photo) {
  const { year, month } = state.filter;
  if (year == null && month == null) return true;
  if (photo.takenAtMs == null) return false;
  const d = new Date(photo.takenAtMs);
  if (year != null && d.getFullYear() !== year) return false;
  if (month != null && d.getMonth() + 1 !== month) return false;
  return true;
}

// Photos taken on one local calendar day (host timezone, same as
// photoMatchesPeriod), for the per-day route view — independent of the
// year/month period filter. Same privacy/exclusion-zone rules as the map layer.
export function photosForDay(dateStr) {
  if (state.privacy) return [];
  return state.photos
    .filter((p) => {
      if (p.takenAtMs == null || isInAnyZone(p.lat, p.lng, state.zones)) return false;
      const d = new Date(p.takenAtMs);
      const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return local === dateStr;
    })
    .sort((a, b) => a.takenAtMs - b.takenAtMs);
}

export function getVisiblePhotos() {
  if (state.privacy) return []; // Photo layer is disabled entirely under privacy mode, like the route map.
  return state.photos.filter((p) => photoMatchesPeriod(p) && !isInAnyZone(p.lat, p.lng, state.zones));
}

// Stage 4 (issue #2): photos to show inline in a 滞在地点's detail panel —
// "at this place" is defined the same way the map's own photo-pin nudging
// (nudgePhotosAwayFromPins) treats "same spot as this pin": within
// state.clusterThreshold meters of *any* of the place's own visit
// coordinates, not just one representative point, since a single cluster can
// contain several distinct-but-nearby exact coordinates (that's why they were
// clustered together in the first place).
export function photosForPlace(memberVisits) {
  if (!memberVisits.length) return [];
  const photos = getVisiblePhotos();
  if (!photos.length) return [];
  const triggerMeters = state.clusterThreshold;
  return photos.filter((photo) => memberVisits.some((v) => distanceMeters(photo.lat, photo.lng, v.lat, v.lng) <= triggerMeters));
}

let lightboxOpener = null;

export function openPhotoLightbox(dataUrl, photo) {
  if (el.photoLightboxOverlay.hidden) lightboxOpener = document.activeElement;
  el.photoLightboxImg.src = dataUrl;
  const name = photo.filePath.split(/[\\/]/).pop();
  const place = resolvePlaceName(photo.lat, photo.lng);
  const estimatedTag = photo.source === 'estimated' ? '（位置は推定）' : null;
  el.photoLightboxCaption.textContent = [name, place, estimatedTag].filter(Boolean).join(' — ');
  el.photoLightboxOverlay.hidden = false;
  el.btnPhotoLightboxClose.focus();
}

export function isPhotoLightboxOpen() {
  return !el.photoLightboxOverlay.hidden;
}

export function closePhotoLightbox() {
  el.photoLightboxOverlay.hidden = true;
  el.photoLightboxImg.src = ''; // Release the (potentially large) decoded image promptly.
  if (lightboxOpener && document.contains(lightboxOpener)) lightboxOpener.focus();
  lightboxOpener = null;
}

export function togglePhotoLayer() {
  if (state.privacy) return; // Buttons are disabled in this state too; belt and suspenders.
  state.photoLayerVisible = !state.photoLayerVisible;
  el.btnPhotoToggle.classList.toggle('active', state.photoLayerVisible);
  el.btnRoutePhotoToggle.classList.toggle('active', state.photoLayerVisible);
  render();
}

export function formatPhotoScanSummary(summary, estimatedCount) {
  if (!summary) return '';
  const base = `${summary.total}枚中 ${summary.withLocation}枚に位置情報が見つかりました（Exif ${summary.withLocationExif} / Takeout ${summary.withLocationTakeout}）`;
  return estimatedCount > 0 ? `${base}。さらに${estimatedCount}枚をタイムラインの記録から推定しました` : base;
}

// Stage3: (re-)derives state.photos from state.rawPhotos, filling in a
// timeline-estimated location for any photo that has neither Exif nor
// Takeout GPS (see estimatePhotoLocations in aggregate.mjs). Called both
// after a photo scan completes and after a timeline file finishes loading,
// since either can happen first — a previously-scanned folder is re-applied
// against a newly-loaded timeline (initPhotoLink runs before any file is
// open), and a freshly-scanned folder is applied against an already-loaded
// timeline.
export function applyPhotoEstimates() {
  const withEstimates = state.raw ? estimatePhotoLocations(state.raw, state.rawPhotos) : state.rawPhotos;
  state.photos = withEstimates.filter((p) => p.hasLocation);
}

export async function startPhotoScan(folder) {
  el.btnLinkPhotoFolder.disabled = true;
  el.btnRescanPhotoFolder.disabled = true;
  el.photoScanProgress.hidden = false;
  el.photoScanProgressFill.style.width = '0%';
  el.photoScanSummary.textContent = 'スキャン中...';

  const unsubscribe = window.pathBrowser.onPhotoScanProgress((payload) => {
    if (payload.phase === 'listing') {
      // Total is unknown until the recursive folder walk finishes, so there's
      // no meaningful percentage yet — just show how many photos were found.
      el.photoScanProgressFill.style.width = '0%';
      el.photoScanSummary.textContent = `フォルダを検索中... (${payload.current}件のファイルを検出)`;
      return;
    }
    const pct = payload.total > 0 ? Math.round((payload.current / payload.total) * 100) : 0;
    el.photoScanProgressFill.style.width = pct + '%';
    el.photoScanSummary.textContent = `スキャン中... (${payload.current}/${payload.total})`;
  });

  try {
    const result = await window.pathBrowser.scanPhotoFolder(folder);
    state.linkedPhotoFolder = folder;
    state.rawPhotos = result.photos || [];
    applyPhotoEstimates();
    // populateYearOptions() reads state.raw.visits/pathPoints unguarded, so
    // only call it once a timeline (real or 写真のみモード's stub) exists —
    // refreshes the year filter to include these photos' taken-at years,
    // which finishLoadingIntoApp()'s earlier call couldn't have known about
    // yet (photo linking happens after that, in the settings screen).
    if (state.raw) populateYearOptions();
    const estimatedCount = state.photos.filter((p) => p.source === 'estimated').length;
    el.photoLinkedFolder.textContent = folder;
    el.photoScanSummary.textContent = formatPhotoScanSummary(result.summary, estimatedCount);
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
export async function initPhotoLink() {
  const folder = await window.pathBrowser.getLinkedPhotoFolder();
  if (!folder) return;
  el.photoLinkedFolder.textContent = folder;
  el.btnRescanPhotoFolder.hidden = false;
  await startPhotoScan(folder);
}

export function wirePhotos() {
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
  // Esc closes the lightbox (and only the lightbox, when it's open on top of
  // another dialog such as the day view — capture phase so it runs first).
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && isPhotoLightboxOpen()) {
        e.preventDefault();
        e.stopPropagation();
        closePhotoLightbox();
      }
    },
    true
  );
  // Anywhere outside the image itself (dark backdrop, caption) closes it too.
  el.photoLightboxOverlay.addEventListener('click', (e) => {
    if (e.target !== el.photoLightboxImg) closePhotoLightbox();
  });
}
