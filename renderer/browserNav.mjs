// Browser conventions on top of the state.mjs history stack:
// - standard inputs: Alt+←/→ and the mouse's back/forward buttons, Alt+Home
//   (map of Japan), Ctrl+D (bookmark), Ctrl+H (history list)
// - each page remembers how it was left (map center/zoom, panel/screen
//   scroll) and gets it back on back/forward/history jump
// - links carry their destination in data-href ("pref:13", "place:42",
//   "muni:13101", "day:2024-01-20"); ones already opened this session are
//   styled as visited, and hovering/focusing one previews where it goes in a
//   status bar at the bottom left, like a browser's URL preview.
// The visited set lives in memory only (never persisted) and holds only keys
// of pages the user actually opened.

import { escapeHtml, formatPlaceLabel, municipalityName } from './aggregate.mjs';
import { currentView, goBack, goForward, navigateTo } from './state.mjs';
import { el, state, ui } from './context.mjs';
import { tr } from './i18n.mjs';
import { stopTimelapse } from './timelapse.mjs';
import { openHistoryMenu } from './historyMenu.mjs';
import { bookmarkCurrentPage, openBookmarkPanel } from './bookmarks.mjs';
import { render } from './app.mjs';

const SCREEN_BY_TAB = { map: 'mapScreen', route: 'routeScreen', chronology: 'chronologyScreen', stats: 'statsScreen' };

export function historyBack() {
  stopTimelapse();
  goBack(state);
  render();
}

export function historyForward() {
  stopTimelapse();
  goForward(state);
  render();
}

export function goHome() {
  const view = currentView(state);
  if (view.view === 'national' && view.tab === 'map' && !view.day) return;
  stopTimelapse();
  navigateTo(state, 'national', {});
  render();
}

// ---------- Scroll / viewport restoration ----------

function captureScroll(entry) {
  if (!state.raw) return;
  const screen = el[SCREEN_BY_TAB[entry.tab]];
  entry.scroll = {
    map: entry.tab === 'map' && ui.map ? { center: ui.map.getCenter(), zoom: ui.map.getZoom() } : null,
    panel: el.detailPanel.scrollTop,
    screen: screen ? screen.scrollTop : 0,
  };
}

// Called by render() before drawing a returned-to page: a saved map view
// replaces the usual fit-to-target for this one render.
export function prepareRestore(entry) {
  if (entry.scroll && entry.scroll.map && state.tab === 'map') ui.keepViewOnce = true;
}

// Called by render() after drawing it.
export function restoreScroll(entry) {
  const saved = entry.scroll;
  if (!saved) return;
  if (saved.map && state.tab === 'map' && ui.map) ui.map.setView(saved.map.center, saved.map.zoom, { animate: false });
  el.detailPanel.scrollTop = saved.panel;
  const screen = el[SCREEN_BY_TAB[state.tab]];
  if (screen) screen.scrollTop = saved.screen;
}

// ---------- Visited links ----------

function pageKeys(entry) {
  const keys = [];
  if (entry.day) keys.push(`day:${entry.day}`);
  if (entry.tab !== 'map') return keys;
  if (entry.view === 'prefecture') keys.push(`pref:${entry.params.code}`);
  if (entry.view === 'place') {
    if (entry.params.clusterId != null) keys.push(`place:${entry.params.clusterId}`);
    else if (entry.params.muniCode) keys.push(`muni:${entry.params.muniCode}`);
  }
  return keys;
}

export function markVisited(entry) {
  for (const key of pageKeys(entry)) ui.visitedHrefs.add(key);
}

// Cluster ids change meaning on re-clustering or another file.
export function clearVisited() {
  ui.visitedHrefs.clear();
}

export function decorateLinks(root = document) {
  root.querySelectorAll('[data-href]').forEach((node) => node.classList.toggle('visited', ui.visitedHrefs.has(node.dataset.href)));
}

// ---------- Link preview (status bar) ----------

function prefName(code) {
  const pref = state.raw && state.raw.prefectures.find((p) => p.code === code);
  return pref ? pref.name : tr('県', 'Prefecture');
}

export function hrefLabel(href) {
  if (!state.raw || !href) return null;
  const sep = href.indexOf(':');
  const kind = href.slice(0, sep);
  const value = href.slice(sep + 1);
  if (kind === 'day') return tr('{d} の1日ビュー', 'Day view: {d}', { d: value });
  if (kind === 'pref') return prefName(value);
  if (kind === 'muni') {
    const muni = state.municipalityByCode.get(value);
    return muni ? `${prefName(muni.prefCode)} › ${municipalityName(state.municipalityByCode, value)}` : null;
  }
  if (kind === 'place') {
    const clusterId = Number(value);
    const visit = state.raw.visits.find((v) => v.clusterId === clusterId);
    if (!visit) return null;
    const muni = municipalityName(state.municipalityByCode, visit.muniCode);
    const cached = state.placeLabelCache.get(clusterId);
    const place = cached && cached.status === 'done' ? formatPlaceLabel(muni, cached) : muni;
    return `${prefName(visit.prefCode)} › ${place}`;
  }
  return null;
}

function showPreview(node) {
  const label = hrefLabel(node.dataset.href);
  if (!label) return hidePreview();
  el.linkStatus.innerHTML = `&rarr; ${escapeHtml(label)}`;
  el.linkStatus.hidden = false;
}

function hidePreview() {
  el.linkStatus.hidden = true;
}

// Short confirmation (role="status", so screen readers hear it too).
export function showToast(text) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2500);
}

// ---------- Wiring ----------

function isTyping() {
  const a = document.activeElement;
  return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
}

export function wireBrowserNav() {
  state.onLeave = captureScroll;

  document.addEventListener('keydown', (e) => {
    if (!state.raw || !el.settingsScreen.hidden) return;
    const dayViewOpen = !el.dayViewOverlay.hidden;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.altKey && !ctrl && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      if (e.key === 'ArrowLeft') historyBack();
      else historyForward();
    } else if (e.altKey && !ctrl && e.key === 'Home') {
      e.preventDefault();
      goHome();
    } else if (ctrl && !e.altKey && !e.shiftKey && key === 'd') {
      e.preventDefault();
      // The ☆ panel sits under the day view's modal, so bookmark straight away.
      if (dayViewOpen) bookmarkCurrentPage();
      else openBookmarkPanel();
    } else if (ctrl && !e.altKey && !e.shiftKey && key === 'h' && !dayViewOpen && !isTyping()) {
      e.preventDefault();
      openHistoryMenu();
    }
  });

  // Mouse back/forward (X1/X2) buttons. mousedown's default is suppressed
  // too, so Chromium doesn't treat them as its own page navigation.
  document.addEventListener('mousedown', (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  });
  document.addEventListener('mouseup', (e) => {
    if ((e.button !== 3 && e.button !== 4) || !state.raw || !el.settingsScreen.hidden) return;
    e.preventDefault();
    if (e.button === 3) historyBack();
    else historyForward();
  });

  const linkFrom = (target) => (target && target.closest ? target.closest('[data-href]') : null);
  document.addEventListener('mouseover', (e) => {
    const node = linkFrom(e.target);
    if (node) showPreview(node);
  });
  document.addEventListener('mouseout', (e) => {
    const node = linkFrom(e.target);
    if (node && !node.contains(e.relatedTarget)) hidePreview();
  });
  document.addEventListener('focusin', (e) => {
    const node = linkFrom(e.target);
    if (node) showPreview(node);
    else hidePreview();
  });
  document.addEventListener('click', () => hidePreview(), true);
}
