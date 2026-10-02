// On-demand detail-name (Nominatim/Overpass) fetching for the prefecture-detail
// ranking rows and their map pin tooltips.

import { computeModalVisitLocation, formatPlaceLabel } from './aggregate.mjs';
import { el, state, ui } from './context.mjs';

// ---- On-demand detail-name fetch queue for the prefecture-detail ranking
// list (see watchRankingRowsForLabelFetch below): sequential, visible-rows-first,
// discarded on navigation away from the panel that queued them. ----
let labelQueue = [];
let labelQueueRunning = false;
let labelQueueToken = 0;
let labelPanelObserver = null;

export function resetLabelQueue() {
  labelQueueToken += 1;
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
    if (muniName) marker.setTooltipContent(`${formatPlaceLabel(muniName, entry)} — 滞在 ${marker.__count} 回`);
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
      if (myToken !== labelQueueToken) break; // panel closed/navigated away mid-fetch — discard
      state.placeLabelCache.set(clusterId, { status: result.error ? 'error' : 'done', label: result.label });
      updateRowLabelDisplay(clusterId);
    }
  } finally {
    labelQueueRunning = false;
  }
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
