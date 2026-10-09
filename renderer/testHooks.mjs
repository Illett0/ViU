import { currentView, navigateTo } from './state.mjs';
import { mainlandBounds } from './mapView.mjs';
import { computeConquestRates, isPassOnly, computeClusterRanking } from './aggregate.mjs';
import { el, geojsonLayerRef, photoLayerRef, routePhotoLayerRef, state, timelapsePointsRef, ui } from './context.mjs';
import { recluster } from './loading.mjs';
import { togglePhotoLayer } from './photos.mjs';
import { resetTimelapse, startTimelapse, stopTimelapse } from './timelapse.mjs';
import { closeSettings, openSettings, persistZones } from './settings.mjs';
import { openDayView, getDayViewState } from './routeTab.mjs';
import { getDerived, render, setGranularity, setPrivacy } from './app.mjs';

export function installTestHooks() {
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
    getTimelapsePointCount() {
      return timelapsePointsRef.layer ? timelapsePointsRef.layer.getLayers().length : 0;
    },
    getVisitedPrefectures() {
      return [...getDerived().periodAggregates.values()].filter((e) => e.stayCount > 0 || e.firstEpoch != null);
    },
    // Pans/zooms the underlying Leaflet map to a prefecture's bounds without
    // changing state.view — unlike goToPrefecture, this stays in the national
    // coverage-map/timelapse view (aggregate coloring for all of Japan keeps
    // animating), it just moves the camera. Useful for framing the timelapse
    // playback on a specific region instead of the full-country zoom level.
    panToPrefectureBounds(code) {
      const feature = state.prefGeoJSON.features.find((f) => f.properties.code === code);
      if (feature) ui.map.fitBounds(mainlandBounds(feature), { padding: [20, 20] });
    },
    getMunicipalityAggregates() {
      return [...getDerived().muniAggregates.values()].filter((e) => e.stayCount > 0);
    },
    getPassOnlyMunicipalities() {
      return [...getDerived().muniAggregates.values()].filter(isPassOnly);
    },
    getRawLocations() {
      return {
        visits: state.raw.visits.map((v) => ({ prefCode: v.prefCode, muniCode: v.muniCode })),
        pathPoints: state.raw.pathPoints.map((p) => ({ prefCode: p[3], muniCode: p[6] })),
      };
    },
    getClusterRanking() {
      return computeClusterRanking(getDerived().displayData, { privacy: state.privacy, municipalityByCode: state.municipalityByCode, limit: 20, sortBy: state.sortBy });
    },
    getConquestRates() {
      const derived = getDerived();
      return computeConquestRates(derived.muniAggregates, state.raw.municipalities, state.raw.prefectures);
    },
    getPlaceLabelCache() {
      return { size: state.placeLabelCache.size, entries: [...state.placeLabelCache.entries()], ...getLabelQueueState() };
    },
    setMapView(lat, lng, zoom) {
      ui.map.setView([lat, lng], zoom, { animate: false });
    },
    getMapZoom() {
      return ui.map ? { zoom: ui.map.getZoom(), center: ui.map.getCenter(), context: ui.lastMapContext } : null;
    },
    getMapBounds() {
      if (!ui.map) return null;
      const b = ui.map.getBounds();
      return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
    },
    // The choropleth's per-prefecture Leaflet style options (prefecture
    // granularity only), keyed by prefecture code.
    getPrefectureStyles() {
      const out = {};
      if (!geojsonLayerRef.layer) return out;
      geojsonLayerRef.layer.eachLayer((lyr) => {
        const { color, weight, fillColor, fillOpacity } = lyr.options;
        out[lyr.feature.properties.code] = { color, weight, fillColor, fillOpacity };
      });
      return out;
    },
    getMaxZoom() {
      return ui.map ? ui.map.getMaxZoom() : null;
    },
    getView() {
      return currentView(state);
    },
    // Converts a known fixture lat/lng into page (viewport) pixel coordinates,
    // so E2E tests can dispatch a real mouse click at an exact map location
    // (e.g. to hit a specific 滞在地点 pin, or a backdrop point known to fall
    // inside a given prefecture's polygon) instead of guessing pixel offsets —
    // real Leaflet click-handling/z-order bugs (see mapView.mjs) can only be
    // exercised via genuine mouse events, not by calling goToPrefecture/goToPlace.
    latLngToPoint(lat, lng) {
      if (!ui.map) return null;
      const pt = ui.map.latLngToContainerPoint([lat, lng]);
      const rect = el.leafletMapDiv.getBoundingClientRect();
      return { x: rect.left + pt.x, y: rect.top + pt.y };
    },
    // Bypasses the actual folder-scan flow (real GPS-tagged photo files aren't
    // available in a test/CI context) so the photo-layer rendering path itself
    // can still be exercised end-to-end.
    setPhotos(photos) {
      state.photos = photos || [];
      render();
    },
    getPhotoMarkerCount() {
      return {
        map: photoLayerRef.markersByPath ? photoLayerRef.markersByPath.size : 0,
        route: routePhotoLayerRef.markersByPath ? routePhotoLayerRef.markersByPath.size : 0,
      };
    },
    // Actual plotted position of each photo marker on the 制覇マップ (post
    // nudgePhotosAwayFromPins) — lets E2E tests click exactly on a photo even
    // when it's been nudged away from its true coordinates to clear a
    // coincident 滞在地点 pin (issue #23).
    getPhotoMarkerLatLngs() {
      if (!photoLayerRef.markersByPath) return [];
      return [...photoLayerRef.markersByPath.entries()].map(([filePath, marker]) => {
        const ll = marker.getLatLng();
        return { filePath, lat: ll.lat, lng: ll.lng };
      });
    },
    togglePhotoLayer,
    openDayView,
    getDayViewState,
  };
}
