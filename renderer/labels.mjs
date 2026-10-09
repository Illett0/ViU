// On-demand detail-name (Nominatim/Overpass) fetching for the prefecture-detail
// ranking rows and their map pin tooltips.

import { computeModalVisitLocation, formatPlaceLabel, escapeHtml } from './aggregate.mjs';
import { el, state, ui } from './context.mjs';
import { tr } from './i18n.mjs';

// ---- On-demand detail-name fetch queue for the prefecture-detail ranking
// list (see watchRankingRowsForLabelFetch below): sequential, visible-rows-first,
// discarded on navigation away from the panel that queued them. ----
let labelQueue = [];
let labelQueueRunning = false;
let labelQueueToken = 0;
let labelPanelObserver = null;

// Other views showing place names (the day view's timeline list) subscribe
// here to re-render a row once its detail name arrives.
const labelListeners = new Set();
export function onPlaceLabelUpdated(fn) {
  labelListeners.add(fn);
  return () => labelListeners.delete(fn);
}

export function resetLabelQueue() {
  labelQueueToken += 1;
  // Queued-but-not-started items were marked 'pending' in the cache by
  // enqueueLabelFetch; drop those marks so a later view can queue them again
  // (otherwise they'd read "取得中…" forever and never be fetched).
  for (const { clusterId } of labelQueue) {
    const entry = state.placeLabelCache.get(clusterId);
    if (entry && entry.status === 'pending') state.placeLabelCache.delete(clusterId);
  }
  labelQueue = [];
  if (labelPanelObserver) {
    labelPanelObserver.disconnect();
    labelPanelObserver = null;
  }
}

export function updateRowLabelDisplay(clusterId) {
  const entry = state.placeLabelCache.get(clusterId);
  const target = el.detailPanelContent.querySelector(`.detail-name[data-cluster-id="${clusterId}"]`);
  if (target) {
    const muniName = target.dataset.muniName;
    target.textContent = formatPlaceLabel(muniName, entry);
  }
  const marker = ui.currentMarkersByKey.get(clusterId);
  if (marker) {
    const muniName = marker.__muniName;
    if (muniName) marker.setTooltipContent(`${escapeHtml(formatPlaceLabel(muniName, entry))} — ${tr('滞在 {n} 回', '{n} stays', { n: marker.__count })}`);
  }
}

export function enqueueLabelFetch(clusterId, modal, priority) {
  if (state.placeLabelCache.has(clusterId)) return;
  state.placeLabelCache.set(clusterId, { status: 'pending', label: null });
  const item = { clusterId, modal };
  if (priority) labelQueue.unshift(item);
  else labelQueue.push(item);
  runLabelQueue();
}

export async function runLabelQueue() {
  if (labelQueueRunning) return;
  labelQueueRunning = true;
  const myToken = labelQueueToken;
  try {
    while (labelQueue.length > 0 && myToken === labelQueueToken) {
      const { clusterId, modal } = labelQueue.shift();
      let result;
      try {
        result = await window.pathBrowser.reverseGeocode(modal.placeId, modal.lat, modal.lng);
      } catch {
        result = { label: null, error: 'failed' };
      }
      // Keep a fetched result even if the panel that queued it is gone — it's
      // valid data, and dropping it would leave the entry stuck at 'pending'.
      // A refusal because privacy mode was turned on mid-flight isn't an
      // answer, though: forget it so it can be fetched again later.
      if (result.error === 'privacy-mode') state.placeLabelCache.delete(clusterId);
      else state.placeLabelCache.set(clusterId, { status: result.error ? 'error' : 'done', label: result.label });
      updateRowLabelDisplay(clusterId);
      for (const fn of labelListeners) fn(clusterId);
    }
  } finally {
    labelQueueRunning = false;
  }
  // Items queued by a newer view while the last fetch above was in flight.
  if (labelQueue.length > 0) runLabelQueue();
}

// Wires an IntersectionObserver over the ranking rows so only rows that have
// actually scrolled into view get queued, and newly-visible rows jump to the
// front — an off-screen row should never get fetched ahead of a visible one.
export function watchRankingRowsForLabelFetch(rows, scopedVisits) {
  if (labelPanelObserver) labelPanelObserver.disconnect();

  const rowByClusterId = new Map(rows.filter((r) => r.clusterId != null).map((r) => [String(r.clusterId), r]));

  labelPanelObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const clusterId = Number(entry.target.dataset.clusterId);
        if (state.placeLabelCache.has(clusterId)) continue;
        const memberVisits = scopedVisits.filter((v) => v.clusterId === clusterId);
        const modal = computeModalVisitLocation(memberVisits);
        if (modal) enqueueLabelFetch(clusterId, modal, true);
      }
    },
    { root: el.detailPanel, threshold: 0.1 }
  );

  el.detailPanelContent.querySelectorAll('.detail-name[data-cluster-id]').forEach((elRow) => {
    if (rowByClusterId.has(elRow.dataset.clusterId)) labelPanelObserver.observe(elRow);
  });
}

export function getLabelQueueState() {
  return { queueLength: labelQueue.length, running: labelQueueRunning };
}
