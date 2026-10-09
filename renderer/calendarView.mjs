// Calendar (issue #37, browsing UI): a time-axis way into the data —
// one GitHub-style heatmap per year (weeks as columns, Sunday on top), each
// recorded day shaded by how much was recorded and clickable into that day's
// route view, plus 「去年の今日」 and 「ランダムな1日」 shortcuts.

import { tr } from './i18n.mjs';

// A recorded day within this many days of "one year ago today" still counts
// (a nearby day beats a disabled button).
const ANNIVERSARY_WINDOW_DAYS = 7;
const MONTH_LABELS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

function dateStr(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// 0 (nothing) to 4, spread over 1..max records.
function level(count, max) {
  if (count <= 0) return 0;
  if (max <= 1) return 4;
  return Math.min(4, 1 + Math.floor(((count - 1) / (max - 1)) * 4));
}

// The recorded day closest to one year before `todayStr`, within the window.
export function anniversaryDate(counts, todayStr) {
  const [y, m, d] = todayStr.split('-').map(Number);
  const target = Date.UTC(y - 1, m - 1, d);
  for (let distance = 0; distance <= ANNIVERSARY_WINDOW_DAYS; distance++) {
    for (const sign of [-1, 1]) {
      const candidate = dateStr(new Date(target + sign * distance * DAY_MS));
      if (counts.has(candidate)) return candidate;
    }
  }
  return null;
}

function yearGrid(year, counts, max, clickable) {
  const jan1 = Date.UTC(year, 0, 1);
  const startDow = new Date(jan1).getUTCDay();
  const days = (Date.UTC(year + 1, 0, 1) - jan1) / DAY_MS;
  const cells = [];
  const months = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(jan1 + i * DAY_MS);
    const ds = dateStr(d);
    const col = Math.floor((i + startDow) / 7) + 1;
    const style = `grid-column:${col};grid-row:${d.getUTCDay() + 1}`;
    if (d.getUTCDate() === 1) {
      const m = d.getUTCMonth();
      months.push(`<span class="cal-month" style="grid-column:${col}">${tr('{m}月', '{name}', { m: m + 1, name: MONTH_LABELS_EN[m] })}</span>`);
    }
    const count = counts.get(ds) || 0;
    const lv = level(count, max);
    if (count > 0 && clickable) {
      cells.push(
        `<button type="button" class="cal-day lv${lv}" style="${style}" data-day="${ds}" title="${ds}"` +
          ` aria-label="${tr('{d}（記録 {n} 件）の経路を表示', 'Show the route for {d} ({n} records)', { d: ds, n: count })}"></button>`
      );
    } else {
      cells.push(`<span class="cal-day lv${lv}" style="${style}"${count > 0 ? ` title="${ds}"` : ''}></span>`);
    }
  }
  return (
    `<div class="cal-year"><h4>${tr('{y}年', '{y}', { y: year })}</h4>` +
    `<div class="cal-months">${months.join('')}</div>` +
    `<div class="cal-grid" role="group" aria-label="${tr('{y}年のカレンダー', 'Calendar for {y}', { y: year })}">${cells.join('')}</div></div>`
  );
}

// counts: Map<'YYYY-MM-DD', number of records>. clickable: whether days lead
// to the day view (off under privacy mode, where route views are disabled).
export function renderCalendar(container, { counts, clickable, todayStr, onDay }) {
  const years = [...new Set([...counts.keys()].map((d) => Number(d.slice(0, 4))))].sort((a, b) => b - a);
  if (years.length === 0) {
    container.innerHTML = '';
    return;
  }
  const max = Math.max(...counts.values());
  const dates = [...counts.keys()];
  const anniversary = anniversaryDate(counts, todayStr);
  const anniversaryTitle = anniversary
    ? anniversary
    : tr('1年前の今日の前後{n}日に記録がありません', 'No records within {n} days of this day last year', { n: ANNIVERSARY_WINDOW_DAYS });
  container.innerHTML =
    `<div class="cal-toolbar"><h3>${tr('カレンダー', 'Calendar')}</h3>` +
    `<button type="button" class="btn btn-small" id="btn-cal-anniversary" title="${anniversaryTitle}"${clickable && anniversary ? '' : ' disabled'}>` +
    `${tr('去年の今日', 'A year ago today')}${anniversary ? ` (${anniversary})` : ''}</button>` +
    `<button type="button" class="btn btn-small" id="btn-cal-random"${clickable ? '' : ' disabled'}>${tr('ランダムな1日へ', 'Random day')}</button>` +
    (clickable ? '' : `<span class="empty-note">${tr('プライバシーモード中は日ごとの経路を開けません。', 'Daily routes cannot be opened while privacy mode is on.')}</span>`) +
    `</div>` +
    years.map((y) => yearGrid(y, counts, max, clickable)).join('');

  if (!clickable) return;
  container.querySelectorAll('.cal-day[data-day]').forEach((btn) => btn.addEventListener('click', () => onDay(btn.dataset.day)));
  if (anniversary) container.querySelector('#btn-cal-anniversary').addEventListener('click', () => onDay(anniversary));
  container.querySelector('#btn-cal-random').addEventListener('click', () => onDay(dates[Math.floor(Math.random() * dates.length)]));
}
