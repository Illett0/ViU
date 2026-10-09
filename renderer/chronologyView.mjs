// Renders the "年表" (chronology) view: first-visit events for prefectures
// (and optionally municipalities), grouped under year/month headings.

import { localDateStr } from './aggregate.mjs';
import { tr } from './i18n.mjs';

const MONTH_NAMES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function renderChronology(container, events, onClickEvent) {
  container.innerHTML = '';
  if (!events || events.length === 0) {
    container.innerHTML = `<p class="empty-note">${tr('データがありません。', 'No data.')}</p>`;
    return;
  }

  let lastYear = null;
  let lastMonth = null;

  for (const ev of events) {
    const dateStr = localDateStr(ev.epoch);
    const [y, m] = dateStr.split('-');

    if (y !== lastYear) {
      const heading = document.createElement('div');
      heading.className = 'chronology-year-heading';
      heading.textContent = tr('{y}年', '{y}', { y });
      container.appendChild(heading);
      lastYear = y;
      lastMonth = null;
    }
    if (m !== lastMonth) {
      const heading = document.createElement('div');
      heading.className = 'chronology-month-heading';
      heading.textContent = tr('{m}月', '{name}', { m: Number(m), name: MONTH_NAMES_EN[Number(m) - 1] });
      container.appendChild(heading);
      lastMonth = m;
    }

    const item = document.createElement('div');
    item.className = 'chronology-item';
    const isPref = ev.type === 'prefecture';
    const firstVisit = tr('{name} 初訪問', 'First visit to {name}', { name: ev.name });
    const label = isPref && ev.muniHintName ? firstVisit + tr('（{m}）', ' ({m})', { m: ev.muniHintName }) : firstVisit;
    item.innerHTML =
      `<span class="chronology-date">${dateStr}</span>` +
      `<span class="chronology-tag ${isPref ? 'pref' : ''}">${isPref ? tr('県', 'Pref.') : tr('市区町村', 'Muni.')}</span>` +
      `<span>${label}</span>`;
    item.addEventListener('click', () => onClickEvent(ev));
    container.appendChild(item);
  }
}
