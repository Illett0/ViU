// Side-by-side period comparison (issue #38, browsing UI — like a
// browser's split view): a second coverage map replaces the detail panel and
// shows the same view (national / prefecture, same granularity) for another
// period, with pan/zoom kept in sync both ways. The left map keeps using the
// header's year/month filter; the right one has its own (state.compare.filter).
// Choropleth only — pins, photos and the timelapse stay on the left map.

import { currentView, navigateTo } from './state.mjs';
import { applyPrivacyZoomLimit, initMap, renderNational, renderNationalMunicipality, renderPrefectureMunicipality } from './mapView.mjs';
import { isPassOnly } from './aggregate.mjs';
import { el, state, ui } from './context.mjs';
import { tr } from './i18n.mjs';
import { stopTimelapse } from './timelapse.mjs';
import { getDerived, render } from './app.mjs';

const compareLayerRef = { layer: null };

export function periodLabel(filter) {
  if (filter.year == null) return tr('全期間', 'All time');
  if (filter.month == null) return tr('{y}年', '{y}', { y: filter.year });
  return tr('{y}年{m}月', '{y}-{mm}', { y: filter.year, m: filter.month, mm: String(filter.month).padStart(2, '0') });
}

function visitedBadge(derived) {
  if (state.granularity === 'municipality') {
    const visited = [...derived.muniAggregates.values()].filter((e) => e.stayCount > 0).length;
    const passOnly = [...derived.muniAggregates.values()].filter(isPassOnly).length;
    return `<span class="count-num">${visited}</span> / ${state.raw.municipalities.length} ${tr('市区町村', 'municipalities')}` +
      (passOnly > 0 ? `<span class="pass-only-note">${tr('通過のみ', 'Passed through')} ${passOnly}</span>` : '');
  }
  const visited = [...derived.periodAggregates.values()].filter((e) => e.stayCount > 0 || e.firstEpoch != null).length;
  return `<span class="count-num">${visited}</span> / ${state.raw.prefectures.length} ${tr('県', 'prefectures')}`;
}

// Mirror one map's camera onto the other without echoing back.
let syncing = false;
function mirror(from, to) {
  if (syncing || !state.compare.on) return;
  syncing = true;
  to.setView(from.getCenter(), from.getZoom(), { animate: false });
  syncing = false;
}

function ensureCompareMap() {
  if (ui.compareMap) return;
  ui.compareMap = initMap(el.compareMapDiv);
  ui.map.on('move', () => mirror(ui.map, ui.compareMap));
  ui.compareMap.on('move', () => mirror(ui.compareMap, ui.map));
  // The municipality layer is culled to the viewport, so redraw on moves.
  ui.compareMap.on('moveend', () => {
    if (state.compare.on && state.granularity === 'municipality' && currentView(state).view === 'national') renderCompare();
  });
}

function fillPeriodOptions() {
  el.compareYear.innerHTML = el.filterYear.innerHTML;
  el.compareMonth.innerHTML = el.filterMonth.innerHTML;
  el.compareYear.value = state.compare.filter.year ?? '';
  el.compareMonth.value = state.compare.filter.month ?? '';
}

// A useful default: the year before the left map's year, or the latest year
// when the left map shows all time.
function defaultCompareFilter() {
  const years = [...el.filterYear.options].map((o) => Number(o.value)).filter(Boolean).sort((a, b) => a - b);
  if (years.length === 0) return { year: null, month: null };
  const left = state.filter.year;
  if (left == null) return { year: years[years.length - 1], month: null };
  const earlier = years.filter((y) => y < left);
  return { year: earlier.length ? earlier[earlier.length - 1] : years.find((y) => y !== left) ?? null, month: null };
}

export function renderCompare() {
  const on = state.compare.on && state.tab === 'map' && !!state.raw && !state.photosOnlyMode;
  el.comparePanel.hidden = !on;
  el.detailPanel.hidden = on;
  el.mapPeriodBadge.hidden = !on;
  el.btnCompare.classList.toggle('active', state.compare.on);
  el.btnCompare.setAttribute('aria-pressed', String(state.compare.on));
  // The timelapse animates the left map only; not offered while comparing.
  el.btnTimelapsePlay.disabled = on;
  if (!on) return;

  ensureCompareMap();
  applyPrivacyZoomLimit(ui.compareMap, state.privacy);
  ui.compareMap.invalidateSize();
  mirror(ui.map, ui.compareMap);

  const derived = getDerived({ filter: state.compare.filter });
  const view = currentView(state);
  const selectedCode = view.view === 'prefecture' || view.view === 'place' ? view.params.code : null;
  const goPrefecture = (code) => {
    navigateTo(state, 'prefecture', { code });
    render();
  };
  if (state.granularity === 'prefecture') {
    renderNational(ui.compareMap, compareLayerRef, state.prefGeoJSON, derived.periodAggregates, goPrefecture, { selectedCode });
  } else if (view.view === 'national') {
    renderNationalMunicipality(ui.compareMap, compareLayerRef, state.muniGeoJSON, derived.muniAggregates, (muniCode) => {
      const muni = state.municipalityByCode.get(muniCode);
      if (muni) goPrefecture(muni.prefCode);
    });
  } else {
    renderPrefectureMunicipality(ui.compareMap, compareLayerRef, state.muniGeoJSON, selectedCode, derived.muniAggregates, () => {});
  }

  el.mapPeriodBadge.textContent = periodLabel(state.filter);
  el.compareCountBadge.innerHTML = visitedBadge(derived);
}

// Per-prefecture style options of the comparison map's choropleth (E2E).
export function getCompareLayerStyles() {
  const out = {};
  if (!compareLayerRef.layer) return out;
  compareLayerRef.layer.eachLayer((lyr) => {
    const { color, weight, fillColor } = lyr.options;
    out[lyr.feature.properties.code] = { color, weight, fillColor };
  });
  return out;
}

export function setCompare(on) {
  state.compare.on = on;
  if (on) {
    stopTimelapse();
    if (!state.compare.touched) state.compare.filter = defaultCompareFilter();
    fillPeriodOptions();
  }
  render();
  // The left map's container just changed width.
  if (ui.map) ui.map.invalidateSize();
}

export function refreshComparePeriodOptions() {
  if (state.compare.on) fillPeriodOptions();
}

export function wireCompare() {
  el.btnCompare.addEventListener('click', () => setCompare(!state.compare.on));
  const onChange = () => {
    state.compare.touched = true;
    state.compare.filter = {
      year: el.compareYear.value ? Number(el.compareYear.value) : null,
      month: el.compareYear.value && el.compareMonth.value ? Number(el.compareMonth.value) : null,
    };
    if (!el.compareYear.value) el.compareMonth.value = '';
    renderCompare();
  };
  el.compareYear.addEventListener('change', onChange);
  el.compareMonth.addEventListener('change', onChange);
}
