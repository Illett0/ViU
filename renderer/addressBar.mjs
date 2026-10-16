// Address bar / search (issue #36, browsing UI): the breadcrumb turns
// into a text field — via its 🔍 button, Ctrl+L or "/", like a browser's
// address bar — that finds prefectures (in either language), every
// municipality (visited or not), detail names fetched in this or any earlier
// session, dates and periods, and jumps there. Esc or leaving the field shows
// the breadcrumb again. Matching is substring (prefix matches first).
//
// Dates can be typed loosely: 2024-01-20 / 2024/1/20 / 2024年1月20日 open that
// day; 2024-01 / 2024年1月 and 2024 / 2024年 switch to that month/year;
// 1/20 / 1月20日 list that day in every year with records.

import { computeModalVisitLocation, escapeHtml, isPassOnly, municipalityName } from './aggregate.mjs';
import { navigateTo } from './state.mjs';
import { el, state } from './context.mjs';
import { prefectureNameEn, tr } from './i18n.mjs';
import { stopTimelapse } from './timelapse.mjs';
import { openDayView } from './routeTab.mjs';
import { getDerived, render, resetNavigationToNational, setGranularity } from './app.mjs';

const MAX_RESULTS = 10;
let results = [];
let active = -1;

function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFKC');
}

function prefName(code) {
  const pref = state.raw.prefectures.find((p) => p.code === code);
  return pref ? pref.name : '';
}

// Every searchable destination, built fresh from what's currently
// displayable (privacy and exclusion zones applied) each time the query
// changes — small enough (47 + ~1,900 municipalities + places + days) to not
// need an index.
function candidates(derived) {
  const out = [];
  for (const p of state.raw.prefectures) {
    out.push({ kind: 'prefecture', label: p.name, keys: [p.name, p.nameJa, prefectureNameEn(p.code)], code: p.code });
  }
  const visitedMunis = new Set(derived.displayData.visits.map((v) => v.muniCode).filter(Boolean));
  for (const m of state.raw.municipalities) {
    const visited = visitedMunis.has(m.code);
    const entry = derived.muniAggregates.get(m.code);
    const status = visited ? '' : entry && isPassOnly(entry) ? tr('通過のみ', 'Passed through') : tr('未訪問', 'Not visited');
    const sub = status ? `${prefName(m.prefCode)} · ${status}` : prefName(m.prefCode);
    out.push({ kind: 'municipality', label: m.name, sub, keys: [m.name], muniCode: m.code, code: m.prefCode, unvisited: !visited });
  }
  if (!state.privacy) {
    const visitByCluster = new Map(derived.displayData.visits.filter((v) => v.clusterId != null).map((v) => [v.clusterId, v]));
    for (const [clusterId, entry] of state.placeLabelCache) {
      const v = visitByCluster.get(clusterId);
      if (!v || !entry || entry.status !== 'done' || !entry.label) continue;
      out.push({ kind: 'place', label: entry.label, sub: municipalityName(state.municipalityByCode, v.muniCode), keys: [entry.label], clusterId, code: v.prefCode });
    }
    for (const d of [...recordedDays(derived)].sort()) out.push({ kind: 'day', label: d, keys: [d, d.replace(/-/g, '/')], dateStr: d });
  }
  return out;
}

function recordedDays(derived) {
  const days = new Set(derived.displayData.visits.map((v) => v.dateStr).filter(Boolean));
  for (const a of derived.displayData.activities) if (a.dateStr) days.add(a.dateStr);
  return days;
}

function availableYears() {
  return new Set([...el.filterYear.options].map((o) => Number(o.value)).filter(Boolean));
}

const pad = (n) => String(n).padStart(2, '0');

function periodLabel(year, month) {
  return month == null ? tr('{y}年', '{y}', { y: year }) : tr('{y}年{m}月', '{y}-{mm}', { y: year, m: month, mm: pad(month) });
}

// Destinations read from the query's shape rather than matched as text.
function parsedCandidates(query, derived) {
  const q = normalize(query).replace(/\s+/g, '');
  const out = [];
  const days = state.privacy ? new Set() : recordedDays(derived);
  const day = (ds) => ({ kind: 'day', label: ds, dateStr: ds });
  let m;
  if ((m = q.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/))) {
    const ds = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    if (days.has(ds)) out.push(day(ds));
  } else if ((m = q.match(/^(\d{4})[-/.年](\d{1,2})月?$/))) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month >= 1 && month <= 12 && availableYears().has(year)) out.push({ kind: 'period', label: periodLabel(year, month), sub: tr('この期間で表示', 'Show this period'), year, month });
  } else if ((m = q.match(/^(\d{4})年?$/))) {
    const year = Number(m[1]);
    if (availableYears().has(year)) out.push({ kind: 'period', label: periodLabel(year, null), sub: tr('この期間で表示', 'Show this period'), year, month: null });
  } else if ((m = q.match(/^(\d{1,2})[-/月](\d{1,2})日?$/))) {
    const md = `-${pad(m[1])}-${pad(m[2])}`;
    for (const ds of [...days].filter((d) => d.endsWith(md)).sort().reverse()) out.push(day(ds));
  }
  return out;
}

const KIND_LABELS = {
  prefecture: () => tr('都道府県', 'Prefecture'),
  municipality: () => tr('市区町村', 'Municipality'),
  place: () => tr('滞在地点', 'Stay point'),
  day: () => tr('日付', 'Date'),
  period: () => tr('期間', 'Period'),
};

function search(query) {
  const q = normalize(query.trim());
  if (!q) return [];
  const derived = getDerived();
  const parsed = parsedCandidates(query, derived);
  const seen = new Set(parsed.map((c) => `${c.kind}:${c.dateStr || c.label}`));
  const scored = [];
  for (const c of candidates(derived)) {
    if (seen.has(`${c.kind}:${c.dateStr || c.label}`)) continue;
    const keys = c.keys.filter(Boolean).map(normalize);
    const prefix = keys.some((k) => k.startsWith(q));
    if (!prefix && !keys.some((k) => k.includes(q))) continue;
    scored.push({ ...c, score: prefix ? 0 : 1 });
  }
  // Prefix matches first; places you have been before ones you haven't;
  // dates newest-first among themselves.
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      (a.unvisited ? 1 : 0) - (b.unvisited ? 1 : 0) ||
      (a.kind === 'day' && b.kind === 'day' ? b.label.localeCompare(a.label) : 0)
  );
  return [...parsed, ...scored].slice(0, MAX_RESULTS);
}

// Detail names fetched in earlier sessions live only in the main process's
// disk cache; pull the ones for the current stay points in (no request is
// sent) so they're searchable — and shown in the ranking — right away.
async function loadCachedLabels() {
  if (state.privacy) return;
  const byCluster = new Map();
  for (const v of getDerived().displayData.visits) {
    if (v.clusterId == null || state.placeLabelCache.has(v.clusterId)) continue;
    if (!byCluster.has(v.clusterId)) byCluster.set(v.clusterId, []);
    byCluster.get(v.clusterId).push(v);
  }
  const wanted = [];
  for (const [clusterId, visits] of byCluster) {
    const modal = computeModalVisitLocation(visits);
    if (modal) wanted.push({ clusterId, placeId: modal.placeId || null, lat: modal.lat, lng: modal.lng });
  }
  if (wanted.length === 0) return;
  const gen = state.renderGen;
  const labels = await window.pathBrowser.getCachedLabels(wanted.map(({ placeId, lat, lng }) => ({ placeId, lat, lng })));
  if (state.privacy || state.renderGen !== gen) return; // data changed meanwhile (privacy, recluster, …)
  wanted.forEach((w, i) => {
    if (labels[i] && !state.placeLabelCache.has(w.clusterId)) state.placeLabelCache.set(w.clusterId, { status: 'done', label: labels[i] });
  });
  if (!el.addressInput.hidden && el.addressInput.value.trim()) {
    results = search(el.addressInput.value);
    active = results.length > 0 ? 0 : -1;
    renderResults();
  }
}

function renderResults() {
  if (results.length === 0) {
    el.addressResults.innerHTML = el.addressInput.value.trim() ? `<li class="address-empty">${tr('見つかりませんでした', 'No matches')}</li>` : '';
    el.addressResults.hidden = !el.addressInput.value.trim();
    el.addressInput.setAttribute('aria-expanded', String(!el.addressResults.hidden));
    el.addressInput.removeAttribute('aria-activedescendant');
    return;
  }
  el.addressResults.innerHTML = results
    .map(
      (r, i) =>
        `<li id="address-result-${i}" role="option" class="address-result${i === active ? ' active' : ''}" aria-selected="${i === active}" data-index="${i}">` +
        `<span class="address-kind">${KIND_LABELS[r.kind]()}</span>${escapeHtml(r.label)}${r.sub ? `<span class="address-sub">${escapeHtml(r.sub)}</span>` : ''}</li>`
    )
    .join('');
  el.addressResults.hidden = false;
  el.addressInput.setAttribute('aria-expanded', 'true');
  if (active >= 0) el.addressInput.setAttribute('aria-activedescendant', `address-result-${active}`);
  else el.addressInput.removeAttribute('aria-activedescendant');
  el.addressResults.querySelectorAll('.address-result').forEach((li) => {
    // mousedown, not click: keep the input from blurring (and closing) first.
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      go(results[Number(li.dataset.index)]);
    });
  });
}

function go(r) {
  if (!r) return;
  close();
  stopTimelapse();
  if (r.kind === 'day') {
    openDayView(r.dateStr);
    return;
  }
  if (r.kind === 'period') {
    // Same as choosing it in the header's year/month selects.
    state.filter = { year: r.year, month: r.month };
    el.filterYear.value = r.year;
    el.filterMonth.value = r.month ?? '';
    resetNavigationToNational();
  } else if (r.kind === 'prefecture') {
    navigateTo(state, 'prefecture', { code: r.code });
  } else if (r.kind === 'municipality') {
    setGranularity('municipality');
    navigateTo(state, 'place', { clusterId: null, muniCode: r.muniCode, code: r.code });
  } else {
    navigateTo(state, 'place', { clusterId: r.clusterId, muniCode: null, code: r.code });
  }
  render();
}

export function openAddressBar() {
  if (!state.raw || !el.addressInput.hidden) return;
  el.breadcrumb.hidden = true;
  el.btnSearch.hidden = true;
  el.addressInput.hidden = false;
  el.addressInput.value = '';
  results = [];
  active = -1;
  renderResults();
  el.addressInput.focus();
  loadCachedLabels();
}

function close() {
  if (el.addressInput.hidden) return;
  el.addressInput.hidden = true;
  el.addressResults.hidden = true;
  el.addressInput.setAttribute('aria-expanded', 'false');
  el.breadcrumb.hidden = false;
  el.btnSearch.hidden = !state.raw;
}

export function updateAddressBar() {
  if (el.addressInput.hidden) el.btnSearch.hidden = !state.raw;
}

export function wireAddressBar() {
  el.btnSearch.addEventListener('click', openAddressBar);
  // Clicking the breadcrumb's empty space (not a crumb) also starts typing.
  el.breadcrumb.addEventListener('click', (e) => {
    if (e.target === el.breadcrumb) openAddressBar();
  });
  el.addressInput.addEventListener('input', () => {
    results = search(el.addressInput.value);
    active = results.length > 0 ? 0 : -1;
    renderResults();
  });
  el.addressInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length === 0) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      renderResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
      el.btnSearch.focus();
    }
  });
  el.addressInput.addEventListener('blur', () => close());
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    const shortcut = ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') || (e.key === '/' && !typing);
    if (!shortcut || !state.raw || !el.dayViewOverlay.hidden || !el.settingsScreen.hidden) return;
    e.preventDefault();
    openAddressBar();
  });
}
