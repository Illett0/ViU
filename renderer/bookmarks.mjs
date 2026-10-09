// Bookmarks (issue #35, browsing UI): save the current view under a
// name and reopen it later. Persisted by main.js in userData/bookmarks.json
// (lib/bookmarks.js) and shared across timeline files, like exclusion zones.
//
// A bookmark records tab, view, period filter and granularity. A stay point
// is stored by its real-world anchor (the cluster's modal location), not its
// clusterId — cluster ids change with the cluster-distance slider or another
// file — and is resolved back to whichever stay point is nearest on open.

import { computeModalVisitLocation, distanceMeters, escapeHtml, isInAnyZone } from './aggregate.mjs';
import { currentView, navigateTo } from './state.mjs';
import { el, state } from './context.mjs';
import { tr } from './i18n.mjs';
import { stopTimelapse } from './timelapse.mjs';
import { historyEntryLabel } from './historyMenu.mjs';
import { getDerived, render, resetNavigationToNational, setGranularity } from './app.mjs';

// Farther than the largest cluster distance (200m) means "not the same place".
const ANCHOR_MATCH_METERS = 200;

const TAB_LABELS = {
  route: () => tr('経路マップ', 'Route Map'),
  chronology: () => tr('年表', 'Chronology'),
  stats: () => tr('移動統計', 'Travel Stats'),
};

function defaultName() {
  const view = currentView(state);
  const base = TAB_LABELS[state.tab] ? TAB_LABELS[state.tab]() : historyEntryLabel(view);
  const { year, month } = state.filter;
  if (year == null) return base;
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
  state.tab = bookmark.tab || 'map';

  resetNavigationToNational();
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

function open() {
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

export function updateBookmarkButton() {
  el.btnBookmarks.disabled = !state.raw;
}

export async function initBookmarks() {
  state.bookmarks = (await window.pathBrowser.getBookmarks()) || [];
}

export function wireBookmarks() {
  el.btnBookmarks.addEventListener('click', () => (isOpen() ? close() : open()));
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
