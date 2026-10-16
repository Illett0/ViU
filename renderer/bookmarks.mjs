// Bookmarks (issue #35, browsing UI): save the current view under a
// name and reopen it later. Persisted by main.js in userData/bookmarks.json
// (lib/bookmarks.js) and shared across timeline files, like exclusion zones.
//
// A bookmark records tab, view, the open day-view date (if any), period
// filter and granularity. A stay point
// is stored by its real-world anchor (the cluster's modal location), not its
// clusterId — cluster ids change with the cluster-distance slider or another
// file — and is resolved back to whichever stay point is nearest on open.

import { computeModalVisitLocation, distanceMeters, escapeHtml, isInAnyZone } from './aggregate.mjs';
import { createEntry, currentView, navigateTo, resetHistory } from './state.mjs';
import { el, state, ui } from './context.mjs';
import { tr } from './i18n.mjs';
import { stopTimelapse } from './timelapse.mjs';
import { historyEntryLabel } from './historyMenu.mjs';
import { showToast } from './browserNav.mjs';
import { getDerived, render, setGranularity } from './app.mjs';

// Farther than the largest cluster distance (200m) means "not the same place".
const ANCHOR_MATCH_METERS = 200;

function defaultName() {
  const base = historyEntryLabel(currentView(state));
  const { year, month } = state.filter;
  if (year == null || currentView(state).day) return base;
  const period = month == null ? tr('{y}年', '{y}', { y: year }) : tr('{y}年{m}月', '{y}-{mm}', { y: year, m: month, mm: String(month).padStart(2, '0') });
  return base + tr('（{p}）', ' ({p})', { p: period });
}

function captureCurrent(name) {
  const view = currentView(state);
  const bookmark = {
    name,
    tab: state.tab,
    view: view.view,
    params: { code: view.params.code ?? null, muniCode: view.params.muniCode ?? null },
    anchor: null,
    day: view.day || null,
    filter: { year: state.filter.year, month: state.filter.month },
    granularity: state.granularity,
    createdAt: Date.now(),
  };
  if (view.view === 'place' && view.params.clusterId != null) {
    const members = getDerived().displayData.visits.filter((v) => v.clusterId === view.params.clusterId);
    const modal = computeModalVisitLocation(members);
    if (modal) bookmark.anchor = { lat: modal.lat, lng: modal.lng };
  }
  return bookmark;
}

// The visit nearest to `anchor` in what's currently displayable (privacy and
// exclusion zones applied), or null if nothing is within ANCHOR_MATCH_METERS.
function nearestVisit(anchor) {
  if (isInAnyZone(anchor.lat, anchor.lng, state.zones)) return null;
  let best = null;
  let bestDist = ANCHOR_MATCH_METERS;
  for (const v of getDerived().displayData.visits) {
    const d = distanceMeters(anchor.lat, anchor.lng, v.lat, v.lng);
    if (d <= bestDist) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

export function openBookmark(bookmark) {
  stopTimelapse();
  const yearAvailable = [...el.filterYear.options].some((o) => o.value === String(bookmark.filter.year));
  state.filter = yearAvailable ? { year: bookmark.filter.year, month: bookmark.filter.month } : { year: null, month: null };
  el.filterYear.value = state.filter.year ?? '';
  el.filterMonth.value = state.filter.month ?? '';
  setGranularity(bookmark.granularity || 'prefecture');

  resetHistory(state, createEntry('national'));
  ui.lastMapContext = null;
  let found = true;
  if (bookmark.view === 'prefecture' || bookmark.view === 'place') {
    navigateTo(state, 'prefecture', { code: bookmark.params.code });
  }
  if (bookmark.view === 'place') {
    if (bookmark.anchor) {
      const visit = nearestVisit(bookmark.anchor);
      if (!visit) found = false;
      else if (state.privacy) navigateTo(state, 'place', { clusterId: null, muniCode: visit.muniCode, code: visit.prefCode });
      else navigateTo(state, 'place', { clusterId: visit.clusterId, muniCode: null, code: visit.prefCode });
    } else if (bookmark.params.muniCode) {
      navigateTo(state, 'place', { clusterId: null, muniCode: bookmark.params.muniCode, code: bookmark.params.code });
    }
  }
  // The bookmarked tab / day view is the same page, not one more entry.
  const page = currentView(state);
  page.tab = bookmark.tab || 'map';
  page.day = state.privacy ? null : bookmark.day || null;
  state.tab = page.tab;
  render();
  if (!found) {
    alert(tr('ブックマークした滞在地点は、今のデータでは見つかりませんでした（除外ゾーン内・別のファイルなど）。都道府県を表示します。', 'The bookmarked stay point was not found in the current data (inside an exclusion zone, a different file, etc.). Showing its prefecture instead.'));
  }
}

async function persist() {
  state.bookmarks = await window.pathBrowser.saveBookmarks(state.bookmarks);
}

function renderList() {
  if (state.bookmarks.length === 0) {
    el.bookmarkList.innerHTML = `<li class="empty-note">${tr('ブックマークはまだありません。', 'No bookmarks yet.')}</li>`;
    return;
  }
  el.bookmarkList.innerHTML = state.bookmarks
    .map(
      (b, i) =>
        `<li><button type="button" class="history-item bookmark-open" data-index="${i}">${escapeHtml(b.name)}</button>` +
        `<button type="button" class="bookmark-delete" data-index="${i}" aria-label="${escapeHtml(tr('「{n}」を削除', 'Delete "{n}"', { n: b.name }))}">&times;</button></li>`
    )
    .join('');
  el.bookmarkList.querySelectorAll('.bookmark-open').forEach((btn) =>
    btn.addEventListener('click', () => {
      close();
      openBookmark(state.bookmarks[Number(btn.dataset.index)]);
    })
  );
  el.bookmarkList.querySelectorAll('.bookmark-delete').forEach((btn) =>
    btn.addEventListener('click', async () => {
      state.bookmarks.splice(Number(btn.dataset.index), 1);
      await persist();
      renderList();
      el.bookmarkName.focus();
    })
  );
}

function isOpen() {
  return !el.bookmarkPanel.hidden;
}

export function openBookmarkPanel() {
  if (!state.raw) return;
  el.bookmarkName.value = defaultName();
  renderList();
  el.bookmarkPanel.hidden = false;
  el.btnBookmarks.setAttribute('aria-expanded', 'true');
  el.bookmarkName.focus();
  el.bookmarkName.select();
}

function close({ restoreFocus = false } = {}) {
  if (!isOpen()) return;
  el.bookmarkPanel.hidden = true;
  el.btnBookmarks.setAttribute('aria-expanded', 'false');
  if (restoreFocus) el.btnBookmarks.focus();
}

// Ctrl+D inside the day view, whose modal covers the ☆ panel: saves the
// page under its default name right away and says so.
export async function bookmarkCurrentPage() {
  if (!state.raw) return;
  const name = defaultName();
  state.bookmarks.push(captureCurrent(name));
  await persist();
  showToast(tr('☆「{n}」をブックマークしました', '☆ Bookmarked "{n}"', { n: name }));
}

export function updateBookmarkButton() {
  el.btnBookmarks.disabled = !state.raw;
}

export async function initBookmarks() {
  state.bookmarks = (await window.pathBrowser.getBookmarks()) || [];
}

export function wireBookmarks() {
  el.btnBookmarks.addEventListener('click', () => (isOpen() ? close() : openBookmarkPanel()));
  el.bookmarkForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el.bookmarkName.value.trim() || defaultName();
    state.bookmarks.push(captureCurrent(name));
    await persist();
    renderList();
  });
  el.bookmarkPanel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close({ restoreFocus: true });
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (isOpen() && !el.bookmarkPanel.contains(e.target) && !el.btnBookmarks.contains(e.target)) close();
  });
}
