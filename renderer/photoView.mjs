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
// Stage3 (issue #1): photos with no Exif/Takeout GPS, plotted from a
// timeline-based guess instead — a duller fill + dashed border keeps them
// visually distinct from real GPS pins at a glance, never presented as fact.
const PHOTO_MARKER_ESTIMATED_FILL_OPACITY = 0.45;
const PHOTO_MARKER_ESTIMATED_DASH = '3,3';

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

// `estimationGapMs` — how far the timeline sample used for the estimate was
// from the photo's own taken-at time (0 for a same-visit match). Shown so the
// user can judge how much to trust a given estimated pin.
function formatEstimationGap(ms) {
  if (ms == null || ms <= 0) return '';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `（記録との時間差: 約${minutes}分）`;
  const hours = Math.round(minutes / 60);
  return `（記録との時間差: 約${hours}時間）`;
}

function sourceLabel(photo) {
  if (photo.source === 'exif') return '位置情報: Exif';
  if (photo.source === 'takeout') return '位置情報: Google Takeout';
  if (photo.source === 'estimated') return `位置情報: 推定${formatEstimationGap(photo.estimationGapMs)}`;
  return '';
}

function popupHtml(photo, placeName) {
  const estimated = photo.source === 'estimated';
  return `
    <div class="photo-popup">
      <div class="photo-popup-thumb-wrap"><span class="photo-popup-loading">読み込み中…</span></div>
      <div class="photo-popup-meta">
        <div class="photo-popup-date">${formatTakenAt(photo.takenAtMs, photo.takenAtIsFallback)}</div>
        ${placeName ? `<div class="photo-popup-place">${placeName}</div>` : ''}
        <div class="photo-popup-source">${sourceLabel(photo)}</div>
        ${estimated ? '<div class="photo-popup-estimated-notice">タイムラインの移動記録から推定した位置です。実際の撮影地点と異なる場合があります。</div>' : ''}
      </div>
    </div>`;
}

// Matches the 4-column grid in style.css (.photo-cluster-popup-grid): 4
// thumbs at ~96px each + gaps. Sized to stay comfortably inside the map
// even on a smallish window (Leaflet auto-pans the popup into view).
const GALLERY_POPUP_WIDTH = 408;

function galleryHtml(photos) {
  const thumbs = photos
    .map(
      (photo, i) =>
        `<div class="photo-cluster-popup-thumb-wrap${photo.source === 'estimated' ? ' photo-cluster-popup-thumb-wrap--estimated' : ''}" data-index="${i}" title="${photo.source === 'estimated' ? '推定位置の写真' : ''}"><span class="photo-popup-loading">…</span></div>`
    )
    .join('');
  return `
    <div class="photo-cluster-popup">
      <div class="photo-cluster-popup-count">${photos.length}枚の写真</div>
      <div class="photo-cluster-popup-grid">${thumbs}</div>
    </div>`;
}

// Opens a Leaflet popup at `latlng` showing every photo in a cluster as a
// thumbnail grid, instead of forcing the user to spiderfy-then-click each
// pin individually — the default leaflet.markercluster behavior becomes
// unusable once several photos share (near-)identical coordinates (e.g.
// burst shots), since spiderfied pins at max zoom end up stacked and tiny.
function openClusterGallery(map, latlng, photos, { onOpenLightbox } = {}) {
  if (!photos || photos.length === 0) return;

  // minWidth is what actually sizes the popup: the grid's 1fr columns and
  // width:100% thumbnails never push the content wider on their own, so
  // without it the popup collapses to its minimum and the thumbnails end up
  // tiny (issue #17).
  const popup = L.popup({ minWidth: GALLERY_POPUP_WIDTH, maxWidth: GALLERY_POPUP_WIDTH })
    .setLatLng(latlng)
    .setContent(galleryHtml(photos))
    .openOn(map);

  const popupEl = popup.getElement();
  if (!popupEl) return;
  photos.forEach(async (photo, i) => {
    const wrap = popupEl.querySelector(`.photo-cluster-popup-thumb-wrap[data-index="${i}"]`);
    if (!wrap) return;
    const result = await window.pathBrowser.getPhotoThumbnail(photo.filePath);
    if (result && result.dataUrl) {
      wrap.innerHTML = `<img src="${result.dataUrl}" alt="" />`;
      wrap.addEventListener('click', () => {
        if (onOpenLightbox) onOpenLightbox(result.dataUrl, photo);
      });
    } else {
      wrap.innerHTML = '<span class="photo-popup-unsupported">非対応</span>';
    }
  });
}

export function clearPhotoLayer(map, layerRef) {
  if (layerRef.layer) {
    map.removeLayer(layerRef.layer);
    layerRef.layer = null;
  }
  layerRef.markersByPath = null;
}

function createPhotoMarker(photo, { resolvePlaceName, onOpenLightbox } = {}) {
  const estimated = photo.source === 'estimated';
  const marker = L.circleMarker([photo.lat, photo.lng], {
    radius: 7,
    color: PHOTO_MARKER_BORDER,
    weight: 2,
    dashArray: estimated ? PHOTO_MARKER_ESTIMATED_DASH : null,
    fillColor: PHOTO_MARKER_COLOR,
    fillOpacity: estimated ? PHOTO_MARKER_ESTIMATED_FILL_OPACITY : 0.9,
    pane: PHOTO_MARKER_PANE,
  });

  marker.photo = photo; // Read back by the cluster's 'clusterclick' gallery handler below.

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
      thumbWrap.innerHTML = '<div class="photo-popup-unsupported">プレビューを生成できませんでした</div>';
    }
  });

  return marker;
}

// `photos` — array of {filePath, lat, lng, takenAtMs, takenAtIsFallback,
// source}, already filtered by the caller (period filter, exclusion zones,
// privacy mode — this module doesn't know about any of those).
// `options.resolvePlaceName(lat, lng)` — synchronous, returns a municipality
// name string or null (reuses the app's already-loaded muni GeoJSON, no IPC).
// `options.onOpenLightbox(dataUrl, photo)` — called when a thumbnail is
// clicked inside its popup.
//
// This is called on every render() (navigation, filter changes, etc.) while
// the photo layer is toggled on, but `photos` is frequently identical to the
// previous call — so rather than tearing the whole cluster down and rebuilding
// it every time, `layerRef` keeps the cluster group + a filePath->marker map
// alive across calls and this only adds/removes the markers that actually
// entered or left the visible set (diffed by filePath).
export function renderPhotoLayer(map, layerRef, photos, { resolvePlaceName, onOpenLightbox } = {}) {
  if (!photos || photos.length === 0) {
    clearPhotoLayer(map, layerRef);
    return;
  }

  if (!layerRef.layer) {
    ensurePhotoPane(map);
    layerRef.layer = L.markerClusterGroup({
      maxClusterRadius: 50,
      // Both defaults are replaced by the manual 'clusterclick' handler below
      // (zoom-to-bounds while there's still room to zoom in, gallery popup
      // once there isn't) — spiderfying tiny/identical-coordinate clusters
      // into a cramped fan of pins was hard to click accurately.
      spiderfyOnMaxZoom: false,
      zoomToBoundsOnClick: false,
      clusterPane: PHOTO_MARKER_PANE,
      iconCreateFunction: (c) =>
        L.divIcon({
          html: `<div><span>${c.getChildCount()}</span></div>`,
          className: 'photo-marker-cluster',
          iconSize: L.point(36, 36),
        }),
    });
    layerRef.layer.on('clusterclick', (e) => {
      // Compare against the zoom fitBounds would actually land on for this
      // cluster's own bounds, not the map's absolute max zoom — fitBounds
      // jumps straight to its target zoom rather than stepping in, so a
      // cluster whose real-world spread fits at, say, zoom 16 would
      // otherwise re-fit to that same zoom 16 on every click forever,
      // never reaching the map max and never opening the gallery. This hit
      // GPS-tagged photo clusters especially hard (their pins are spread
      // over real walking distance, unlike same-coordinate 推定/estimated
      // pins whose zero-size bounds happened to fit-zoom straight to max).
      const bounds = e.layer.getBounds().pad(0.5);
      const targetZoom = map.getBoundsZoom(bounds);
      if (targetZoom > map.getZoom()) {
        map.fitBounds(bounds);
        return;
      }
      const photos = e.layer.getAllChildMarkers().map((m) => m.photo).filter(Boolean);
      openClusterGallery(map, e.layer.getLatLng(), photos, { onOpenLightbox });
    });
    layerRef.markersByPath = new Map();
    layerRef.layer.addTo(map);
  }

  const cluster = layerRef.layer;
  const markersByPath = layerRef.markersByPath;
  const nextPaths = new Set();

  for (const photo of photos) {
    nextPaths.add(photo.filePath);
    if (markersByPath.has(photo.filePath)) continue; // Unchanged since last render — leave its marker (and any open popup) alone.
    const marker = createPhotoMarker(photo, { resolvePlaceName, onOpenLightbox });
    cluster.addLayer(marker);
    markersByPath.set(photo.filePath, marker);
  }

  for (const [filePath, marker] of markersByPath) {
    if (nextPaths.has(filePath)) continue;
    cluster.removeLayer(marker);
    markersByPath.delete(filePath);
  }
}
