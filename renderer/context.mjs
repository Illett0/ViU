// Shared renderer state, DOM element refs, and mutable UI handles (Leaflet
// map instances, layer refs, per-view bookkeeping) used across the renderer
// modules. Kept in one leaf module so the feature modules (which import each
// other in cycles — e.g. render() <-> renderMapTab()) never depend on another
// module's own top-level `let` bindings, which would be in the temporal dead
// zone depending on evaluation order.

import { createState } from './state.mjs';

export const state = createState();
state.clusterThreshold = 50;
state.municipalityByCode = new Map();
state.renderGen = 0;
state.granularity = 'prefecture';
state.zones = [];
state.bookmarks = []; // issue #35, see bookmarks.mjs
state.sortBy = 'count';
state.chronologyIncludeMuni = false;
state.dismissedSuggestions = new Set();
state.timelapse = { playing: false, timer: null, steps: [], index: -1 };
// Persists for the whole session (keyed by clusterId), so revisiting a
// prefecture shows previously-fetched detail names instantly. Backed by the
// existing disk cache in lib/nominatim.js (keyed by placeId/coords), so this
// is purely a renderer-side memo to avoid redundant IPC round-trips.
state.placeLabelCache = new Map(); // clusterId -> { status: 'pending'|'done'|'error', label }
state.rawPhotos = []; // every scanned photo, located or not ({filePath, lat, lng, hasLocation, takenAtMs, takenAtIsFallback, source})
state.photos = []; // state.rawPhotos with Stage3 timeline-based estimates applied (see applyPhotoEstimates), filtered to hasLocation
state.photoLayerVisible = false;
state.linkedPhotoFolder = null;

export const el = {
  btnOpen: document.getElementById('btn-open-file'),
  btnOpenMain: document.getElementById('btn-open-file-main'),
  btnPhotosOnly: document.getElementById('btn-photos-only'),
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
  addressInput: document.getElementById('address-input'),
  addressResults: document.getElementById('address-results'),
  btnSearch: document.getElementById('btn-search'),
  btnBack: document.getElementById('btn-back'),
  btnForward: document.getElementById('btn-forward'),
  btnHistory: document.getElementById('btn-history'),
  historyMenu: document.getElementById('history-menu'),
  btnBookmarks: document.getElementById('btn-bookmarks'),
  bookmarkPanel: document.getElementById('bookmark-panel'),
  bookmarkForm: document.getElementById('bookmark-form'),
  bookmarkName: document.getElementById('bookmark-name'),
  bookmarkList: document.getElementById('bookmark-list'),
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
  photosOnlyBanner: document.getElementById('photos-only-banner'),
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
  btnDeleteAllData: document.getElementById('btn-delete-all-data'),
  btnDeleteAllDataWelcome: document.getElementById('btn-delete-all-data-welcome'),
  settingsVersion: document.getElementById('settings-version'),
  dayViewOverlay: document.getElementById('day-view-overlay'),
  dayViewTitle: document.getElementById('day-view-title'),
  dayViewMapDiv: document.getElementById('day-view-map'),
  dayViewMessage: document.getElementById('day-view-message'),
  dayViewLegend: document.getElementById('day-view-legend'),
  btnDayViewClose: document.getElementById('btn-day-view-close'),
  dayViewPanel: document.getElementById('day-view-panel'),
  dayViewSummary: document.getElementById('day-view-summary'),
  dayViewTimeline: document.getElementById('day-view-timeline'),
  btnDayViewPrev: document.getElementById('btn-day-view-prev'),
  btnDayViewNext: document.getElementById('btn-day-view-next'),
  btnDayViewPhotos: document.getElementById('btn-day-view-photos'),
  dayViewPhotoCount: document.getElementById('day-view-photo-count'),
  dayViewPhotos: document.getElementById('day-view-photos'),
  dayViewPhotoGallery: document.getElementById('day-view-photo-gallery'),
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

export const ui = {
  map: null,
  routeMap: null,
  dayViewMap: null,
  zoneMap: null,
  lastMapContext: null, // tracks view+granularity so we only fitBounds on real navigation, not on every pan/zoom redraw
  placeGalleryCancel: null, // cancels the previous renderPlaceDetail's in-flight thumbnail fetches (photosForPlace gallery)
  pendingZoneCenter: null,
  currentDetailPrefCode: null,
  currentMarkersByKey: new Map(),
  keepViewOnce: false, // set by leavePlaceKeepingView (mapTab.mjs): skip the next render's fitBounds/zoom
};

export const dayViewLayerRef = { layer: null };
export const dayViewMarkerLayerRef = { layer: null };
export const dayViewPhotoLayerRef = { layer: null };
export const geojsonLayerRef = { layer: null };
export const photoLayerRef = { layer: null }; // 制覇マップ側の写真レイヤー
export const routePhotoLayerRef = { layer: null }; // 経路マップ側の写真レイヤー（別Leafletインスタンスなので別レイヤー参照が要る）
export const markerLayerRef = { layer: null };
export const timelapsePointsRef = { layer: null, renderer: null };
export const routeLayerRef = { layer: null };
export const zoneLayerRef = { layer: null };
export const zonePendingLayerRef = { layer: null };

export const zonesReady = window.pathBrowser.getZones().then((zones) => {
  state.zones = zones || [];
});
