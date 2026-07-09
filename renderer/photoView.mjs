// Photo layer rendering: GPS-tagged photo pins overlaid on either the
// 制覇マップ or 経路マップ Leaflet map instance, clustered via
// leaflet.markercluster (vendor/leaflet.markercluster/). Decoupled from app
// state the same way mapView.mjs's renderClusterMarkers is — callers pass in
// whatever app-level lookups (place name, lightbox) are needed as callbacks,
// this module only knows about `photos` records ({filePath, lat, lng,
// takenAtMs, source}) and Leaflet.

const PHOTO_MARKER_COLOR = '#e377c2';
const PHOTO_MARKER_BORDER = '#ffffff';
const PHOTO_MARKER_PANE = 'photoMarkerPane';

function ensurePhotoPane(map) {
  if (!map.getPane(PHOTO_MARKER_PANE)) {
    // Above clusterMarkerPane (620, see mapView.mjs) — the photo layer is
    // always the most-recently-toggled-on overlay, so it should never be
    // hidden underneath the 滞在地点 pins when both happen to be visible
    // at once (制覇マップ, drilled into a prefecture, with photos toggled on).
    map.createPane(PHOTO_MARKER_PANE);
    map.getPane(PHOTO_MARKER_PANE).style.zIndex = 640;
  }
}

function formatTakenAt(ms, isFallback) {
  if (ms == null) return '撮影日時不明';
  const d = new Date(ms);
  const s = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return isFallback ? `${s}（推定・ファイル作成日時）` : s;
}

function sourceLabel(source) {
  if (source === 'exif') return '位置情報: Exif';
  if (source === 'takeout') return '位置情報: Google Takeout';
  return '';
}

function popupHtml(photo, placeName) {
  return `
    <div class="photo-popup">
      <div class="photo-popup-thumb-wrap"><span class="photo-popup-loading">読み込み中…</span></div>
      <div class="photo-popup-meta">
        <div class="photo-popup-date">${formatTakenAt(photo.takenAtMs, photo.takenAtIsFallback)}</div>
        ${placeName ? `<div class="photo-popup-place">${placeName}</div>` : ''}
        <div class="photo-popup-source">${sourceLabel(photo.source)}</div>
      </div>
    </div>`;
}

export function clearPhotoLayer(map, layerRef) {
  if (layerRef.layer) {
    map.removeLayer(layerRef.layer);
    layerRef.layer = null;
  }
}

// `photos` — array of {filePath, lat, lng, takenAtMs, takenAtIsFallback,
// source}, already filtered by the caller (period filter, exclusion zones,
// privacy mode — this module doesn't know about any of those).
// `options.resolvePlaceName(lat, lng)` — synchronous, returns a municipality
// name string or null (reuses the app's already-loaded muni GeoJSON, no IPC).
// `options.onOpenLightbox(dataUrl, photo)` — called when a thumbnail is
// clicked inside its popup.
export function renderPhotoLayer(map, layerRef, photos, { resolvePlaceName, onOpenLightbox } = {}) {
  clearPhotoLayer(map, layerRef);
  if (!photos || photos.length === 0) return;

  ensurePhotoPane(map);

  const cluster = L.markerClusterGroup({
    maxClusterRadius: 50,
    spiderfyOnMaxZoom: true,
    clusterPane: PHOTO_MARKER_PANE,
    iconCreateFunction: (c) =>
      L.divIcon({
        html: `<div><span>${c.getChildCount()}</span></div>`,
        className: 'photo-marker-cluster',
        iconSize: L.point(36, 36),
      }),
  });

  for (const photo of photos) {
    const marker = L.circleMarker([photo.lat, photo.lng], {
      radius: 7,
      color: PHOTO_MARKER_BORDER,
      weight: 2,
      fillColor: PHOTO_MARKER_COLOR,
      fillOpacity: 0.9,
      pane: PHOTO_MARKER_PANE,
    });

    const placeName = resolvePlaceName ? resolvePlaceName(photo.lat, photo.lng) : null;
    marker.bindPopup(popupHtml(photo, placeName), { maxWidth: 260 });

    // Thumbnail is fetched on demand (only when this specific photo's popup
    // is actually opened), not eagerly for every photo — see main.js's
    // photos:get-thumbnail handler. Keeps toggling the layer on cheap even
    // with thousands of photos.
    marker.on('popupopen', async () => {
      const popupEl = marker.getPopup().getElement();
      const thumbWrap = popupEl && popupEl.querySelector('.photo-popup-thumb-wrap');
      if (!thumbWrap) return;
      const result = await window.pathBrowser.getPhotoThumbnail(photo.filePath);
      if (result && result.dataUrl) {
        thumbWrap.innerHTML = `<img class="photo-popup-thumb" src="${result.dataUrl}" alt="" />`;
        thumbWrap.querySelector('img').addEventListener('click', () => {
          if (onOpenLightbox) onOpenLightbox(result.dataUrl, photo);
        });
      } else {
        thumbWrap.innerHTML = '<div class="photo-popup-unsupported">プレビュー非対応の形式です（HEIC等）</div>';
      }
    });

    cluster.addLayer(marker);
  }

  cluster.addTo(map);
  layerRef.layer = cluster;
}
