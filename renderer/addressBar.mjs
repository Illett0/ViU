// Address bar / search (issue #36, browsing UI): the breadcrumb turns
// into a text field — via its 🔍 button, Ctrl+L or "/", like a browser's
// address bar — that finds prefectures (in either language), visited
// municipalities, fetched detail names and dates in the data, and jumps there.
// Esc or leaving the field shows the breadcrumb again.

import { escapeHtml, municipalityName } from './aggregate.mjs';
import { navigateTo } from './state.mjs';
import { el, state } from './context.mjs';
import { prefectureNameEn, tr } from './i18n.mjs';
import { stopTimelapse } from './timelapse.mjs';
import { openDayView } from './routeTab.mjs';
import { getDerived, render, setGranularity } from './app.mjs';

const MAX_RESULTS = 8;
let results = [];
let active = -1;

function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFKC');
}

// Every searchable destination, built fresh from what's currently
// displayable (privacy and exclusion zones applied) each time the query
// changes — small enough (47 + visited municipalities + days) to not need
// an index.
function candidates() {
  const derived = getDerived();
  const out = [];
  for (const p of state.raw.prefectures) {
    out.push({ kind: 'prefecture', label: p.name, keys: [p.name, p.nameJa, prefectureNameEn(p.code)], code: p.code });
  }
  const munis = new Map();
  for (const v of derived.displayData.visits) {
    if (v.muniCode && !munis.has(v.muniCode)) munis.set(v.muniCode, v.prefCode);
  }
  for (const [muniCode, prefCode] of munis) {
    const name = municipalityName(state.municipalityByCode, muniCode);
    const pref = state.raw.prefectures.find((p) => p.code === prefCode);
    out.push({ kind: 'municipality', label: name, sub: pref ? pref.name : '', keys: [name], muniCode, code: prefCode });
  }
  if (!state.privacy) {
    const visitByCluster = new Map(derived.displayData.visits.filter((v) => v.clusterId != null).map((v) => [v.clusterId, v]));
    for (const [clusterId, entry] of state.placeLabelCache) {
      const v = visitByCluster.get(clusterId);
      if (!v || !entry || entry.status !== 'done' || !entry.label) continue;
      out.push({ kind: 'place', label: entry.label, sub: municipalityName(state.municipalityByCode, v.muniCode), keys: [entry.label], clusterId, code: v.prefCode });
    }
    const days = new Set(derived.displayData.visits.map((v) => v.dateStr).filter(Boolean));
    for (const a of derived.displayData.activities) if (a.dateStr) days.add(a.dateStr);
    for (const d of [...days].sort()) out.push({ kind: 'day', label: d, keys: [d, d.replace(/-/g, '/')], dateStr: d });
  }
  return out;
}

const KIND_LABELS = {
  prefecture: () => tr('都道府県', 'Prefecture'),
  municipality: () => tr('市区町村', 'Municipality'),
  place: () => tr('滞在地点', 'Stay point'),
  day: () => tr('日付', 'Date'),
};

function search(query) {
  const q = normalize(query.trim());
  if (!q) return [];
  const scored = [];
  for (const c of candidates()) {
    const keys = c.keys.filter(Boolean).map(normalize);
    const prefix = keys.some((k) => k.startsWith(q));
    if (!prefix && !keys.some((k) => k.includes(q))) continue;
    scored.push({ ...c, score: prefix ? 0 : 1 });
  }
  // Prefix matches first; dates newest-first among themselves.
  return scored
    .sort((a, b) => a.score - b.score || (a.kind === 'day' && b.kind === 'day' ? b.label.localeCompare(a.label) : 0))
    .slice(0, MAX_RESULTS);
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
  state.tab = 'map';
  if (r.kind === 'prefecture') {
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
