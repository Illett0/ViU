// Browsing history list (issue #33, browsing UI): the back/forward
// stack in state.mjs shown as a menu — newest first, current entry marked —
// so any earlier view can be jumped to directly, like a browser's long-press
// on its back button. Opened from the ▾ button next to back/forward, or by
// right-clicking either of them.

import { escapeHtml, formatPlaceLabel, municipalityName } from './aggregate.mjs';
import { el, state } from './context.mjs';
import { tr } from './i18n.mjs';
import { stopTimelapse } from './timelapse.mjs';
import { render } from './app.mjs';

function prefName(code) {
  const pref = state.raw && state.raw.prefectures.find((p) => p.code === code);
  return pref ? pref.name : tr('県', 'Prefecture');
}

// Same wording as the breadcrumb, but a place is named by where it is
// (municipality, plus its detail name once fetched) rather than just
// 「滞在地点」, so entries in the list can be told apart.
export function historyEntryLabel(entry) {
  if (entry.view === 'national') return tr('日本地図', 'Japan');
  const pref = prefName(entry.params.code);
  if (entry.view === 'prefecture') return pref;
  const { clusterId, muniCode } = entry.params;
  let place;
  if (clusterId != null) {
    const visit = state.raw.visits.find((v) => v.clusterId === clusterId);
    const muni = municipalityName(state.municipalityByCode, visit ? visit.muniCode : null);
    const cached = state.placeLabelCache.get(clusterId);
    place = cached && cached.status === 'done' ? formatPlaceLabel(muni, cached) : muni;
  } else {
    place = municipalityName(state.municipalityByCode, muniCode);
  }
  return `${pref} › ${place}`;
}

function isOpen() {
  return !el.historyMenu.hidden;
}

function close({ restoreFocus = false } = {}) {
  if (!isOpen()) return;
  el.historyMenu.hidden = true;
  el.btnHistory.setAttribute('aria-expanded', 'false');
  if (restoreFocus) el.btnHistory.focus();
}

function open() {
  if (!state.raw || state.history.length <= 1) return;
  const items = state.history
    .map((entry, i) => ({ entry, i }))
    .reverse()
    .map(({ entry, i }) => {
      const current = i === state.historyIndex;
      const label = historyEntryLabel(entry);
      return (
        `<li role="none"><button type="button" role="menuitem" class="history-item${current ? ' current' : ''}" data-index="${i}"` +
        `${current ? ' aria-current="true"' : ''}>${escapeHtml(label)}</button></li>`
      );
    })
    .join('');
  el.historyMenu.innerHTML = items;
  el.historyMenu.hidden = false;
  el.btnHistory.setAttribute('aria-expanded', 'true');
  el.historyMenu.querySelectorAll('.history-item').forEach((btn) => {
    btn.addEventListener('click', () => jumpTo(Number(btn.dataset.index)));
  });
  const current = el.historyMenu.querySelector('.history-item.current') || el.historyMenu.querySelector('.history-item');
  if (current) current.focus();
}

function jumpTo(index) {
  close();
  if (index === state.historyIndex) return;
  stopTimelapse();
  state.historyIndex = index;
  state.tab = 'map';
  render();
  el.btnHistory.focus();
}

export function updateHistoryButton() {
  el.btnHistory.disabled = !state.raw || state.history.length <= 1;
  if (el.btnHistory.disabled) close();
}

export function wireHistoryMenu() {
  el.btnHistory.addEventListener('click', () => (isOpen() ? close() : open()));
  for (const btn of [el.btnBack, el.btnForward]) {
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      open();
    });
  }
  el.historyMenu.addEventListener('keydown', (e) => {
    const buttons = [...el.historyMenu.querySelectorAll('.history-item')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close({ restoreFocus: true });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    } else if (e.key === 'Tab') {
      close();
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (isOpen() && !el.historyMenu.contains(e.target) && e.target !== el.btnHistory && !el.btnHistory.contains(e.target)) close();
  });
}
