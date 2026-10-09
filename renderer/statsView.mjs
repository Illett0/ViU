import { colorForMode } from './routeView.mjs';
import { numberLocale, tr } from './i18n.mjs';

const MODE_LABELS_EN = {
  WALKING: 'Walking',
  CYCLING: 'Cycling',
  RUNNING: 'Running',
  IN_PASSENGER_VEHICLE: 'Car',
  IN_TAXI: 'Taxi',
  IN_BUS: 'Bus',
  IN_TRAIN: 'Train',
  IN_SUBWAY: 'Subway',
  IN_TRAM: 'Tram',
  IN_FERRY: 'Ferry',
  FLYING: 'Flight',
  IN_GONDOLA_LIFT: 'Ropeway',
  UNKNOWN: 'Unknown',
};

const MODE_LABELS = {
  WALKING: '徒歩',
  CYCLING: '自転車',
  RUNNING: 'ランニング',
  // "同乗" (being a passenger) vs. driving oneself can't be distinguished from
  // the source data (Google's IN_PASSENGER_VEHICLE covers both), so this is
  // kept as a plain "車" rather than implying a specific one of the two.
  IN_PASSENGER_VEHICLE: '車',
  IN_TAXI: 'タクシー',
  IN_BUS: 'バス',
  IN_TRAIN: '電車',
  IN_SUBWAY: '地下鉄',
  IN_TRAM: '路面電車',
  IN_FERRY: 'フェリー',
  FLYING: '飛行機',
  IN_GONDOLA_LIFT: 'ロープウェイ',
  UNKNOWN: '不明',
};

function modeLabel(mode) {
  return tr(MODE_LABELS[mode], MODE_LABELS_EN[mode]) || mode;
}

function km(meters) {
  return (meters / 1000).toLocaleString(numberLocale(), { maximumFractionDigits: 1 });
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return tr('{m}分', '{m} min', { m });
  return tr('{h}時間{m}分', '{h} h {m} min', { h, m });
}

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, width: rect.width, height: rect.height };
}

function emptyMessage(ctx) {
  ctx.fillStyle = '#9aa3b2';
  ctx.font = '13px sans-serif';
  ctx.fillText(tr('データがありません', 'No data'), 12, 20);
}

function drawAxesAndGrid(ctx, padding, w, h, maxVal, formatValue) {
  ctx.strokeStyle = '#3a4050';
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + h);
  ctx.lineTo(padding.left + w, padding.top + h);
  ctx.stroke();

  ctx.fillStyle = '#9aa3b2';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const val = (maxVal / 4) * i;
    const y = padding.top + h - (h / 4) * i;
    ctx.fillText(formatValue(val), padding.left - 6, y + 4);
  }
}

function drawBarLabels(ctx, items, padding, h, barWidth, barGap, labelOf) {
  ctx.textAlign = 'center';
  ctx.fillStyle = '#9aa3b2';
  const every = items.length <= 24 ? 1 : Math.ceil(items.length / 24);
  items.forEach((item, i) => {
    if (i % every !== 0) return;
    const x = padding.left + i * (barWidth + barGap) + barWidth / 2;
    ctx.save();
    ctx.translate(x, padding.top + h + 12);
    if (items.length > 12) ctx.rotate(-Math.PI / 4);
    ctx.fillText(labelOf(item), 0, 0);
    ctx.restore();
  });
}

function drawMonthlyStackedChart(canvas, monthly) {
  const { ctx, width, height } = setupCanvas(canvas);
  if (monthly.length === 0) return emptyMessage(ctx);

  const padding = { top: 16, right: 16, bottom: 28, left: 48 };
  const w = width - padding.left - padding.right;
  const h = height - padding.top - padding.bottom;
  const maxDist = Math.max(...monthly.map((m) => m.total), 1);
  const barGap = 4;
  const barWidth = Math.max(2, w / monthly.length - barGap);

  drawAxesAndGrid(ctx, padding, w, h, maxDist, km);

  monthly.forEach((m, i) => {
    let yOffset = 0;
    const x = padding.left + i * (barWidth + barGap);
    for (const [mode, val] of Object.entries(m.byMode)) {
      if (val <= 0) continue;
      const segH = (val / maxDist) * h;
      const y = padding.top + h - yOffset - segH;
      ctx.fillStyle = colorForMode(mode);
      ctx.fillRect(x, y, barWidth, segH);
      yOffset += segH;
    }
  });

  drawBarLabels(ctx, monthly, padding, h, barWidth, barGap, (m) => m.key.slice(2));
}

function drawSimpleBarChart(canvas, items, { value, label, color = '#4da3ff', formatValue = (v) => String(Math.round(v)) }) {
  const { ctx, width, height } = setupCanvas(canvas);
  if (items.length === 0) return emptyMessage(ctx);

  const padding = { top: 16, right: 16, bottom: 24, left: 44 };
  const w = width - padding.left - padding.right;
  const h = height - padding.top - padding.bottom;
  const maxVal = Math.max(...items.map(value), 1);
  const barGap = 4;
  const barWidth = Math.max(2, w / items.length - barGap);

  drawAxesAndGrid(ctx, padding, w, h, maxVal, formatValue);

  items.forEach((item, i) => {
    const val = value(item);
    const barH = (val / maxVal) * h;
    const x = padding.left + i * (barWidth + barGap);
    const y = padding.top + h - barH;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, barWidth, barH);
  });

  drawBarLabels(ctx, items, padding, h, barWidth, barGap, label);
}

function modeLegend(monthly) {
  const modes = [...new Set(monthly.flatMap((m) => Object.keys(m.byMode)))];
  if (modes.length === 0) return '';
  return (
    '<div class="mode-legend">' +
    modes
      .map((mode) => `<span class="legend-item"><span class="legend-swatch" style="background:${colorForMode(mode)}"></span>${modeLabel(mode)}</span>`)
      .join('') +
    '</div>'
  );
}

export function renderStats(
  container,
  {
    stats,
    clusterRanking,
    sortBy,
    onSortByChange,
    privacy,
    newlyVisited,
    walkingRatio,
    longestTrips,
    dayOfWeek,
    hourly,
    topDays,
    dwellCapNote,
    conquestRates,
    onConquestClick,
    onDayClick,
  }
) {
  container.innerHTML = '';
  // Dates become links to that day's route view when the caller allows it
  // (not under privacy mode, where the route views are off).
  const dayLink = (dateStr) =>
    onDayClick && dateStr
      ? `<button type="button" class="link-btn" data-day="${dateStr}" aria-label="${tr('{d} の経路を表示', 'Show the route for {d}', { d: dateStr })}">${dateStr}</button>`
      : dateStr || '-';

  const grid = document.createElement('div');
  grid.className = 'stats-grid';

  const totalCard = document.createElement('div');
  totalCard.className = 'stat-card';
  totalCard.innerHTML = `<div class="big-number">${km(stats.totalDistance)} km</div><div class="caption">${tr('総移動距離', 'Total distance')}</div>`;
  grid.appendChild(totalCard);

  const totalTrips = stats.byMode.reduce((s, m) => s + m.count, 0);
  const modeCountCard = document.createElement('div');
  modeCountCard.className = 'stat-card';
  modeCountCard.innerHTML = `<div class="big-number">${totalTrips}</div><div class="caption">${tr('移動回数', 'Trips')}</div>`;
  grid.appendChild(modeCountCard);

  const walkCard = document.createElement('div');
  walkCard.className = 'stat-card';
  walkCard.innerHTML = `<div class="big-number">${walkingRatio.toFixed(1)}${tr(' 倍', '×')}</div><div class="caption">${tr('徒歩の累計距離は東海道五十三次（約490km）の何倍か', 'Total walking distance as a multiple of the Tokaido 53 Stations route (about 490 km)')}</div>`;
  grid.appendChild(walkCard);

  if (newlyVisited && newlyVisited.length > 0) {
    const newlyCard = document.createElement('div');
    newlyCard.className = 'stat-card';
    newlyCard.innerHTML =
      `<div class="big-number">${newlyVisited.length}</div><div class="caption">${tr('この年に初めて訪れた県', 'Prefectures first visited this year')}</div>` +
      `<ul class="newly-visited-list">${newlyVisited.map((p) => `<li>${p.name}</li>`).join('')}</ul>`;
    grid.appendChild(newlyCard);
  }

  container.appendChild(grid);

  // ---- Mode breakdown table ----
  const modeTitle = document.createElement('h3');
  modeTitle.className = 'section-title';
  modeTitle.textContent = tr('移動手段別の内訳', 'Breakdown by travel mode');
  container.appendChild(modeTitle);

  if (stats.byMode.length === 0) {
    container.insertAdjacentHTML('beforeend', `<p class="empty-note">${tr('この期間の移動データはありません。', 'No travel data in this period.')}</p>`);
  } else {
    const table = document.createElement('table');
    table.className = 'mode-table';
    table.innerHTML =
      `<thead><tr><th>${tr('手段', 'Mode')}</th><th>${tr('距離', 'Distance')}</th><th>${tr('回数', 'Trips')}</th><th>${tr('合計時間', 'Total time')}</th><th>${tr('平均速度', 'Avg. speed')}</th></tr></thead><tbody>` +
      stats.byMode
        .map(
          (m) =>
            `<tr><td><span class="legend-swatch" style="background:${colorForMode(m.mode)}"></span>${modeLabel(m.mode)}</td>` +
            `<td>${km(m.distance)} km</td><td>${m.count}</td><td>${formatDuration(m.durationMs)}</td>` +
            `<td>${m.avgSpeedKmh != null ? m.avgSpeedKmh.toFixed(1) + ' km/h' : '-'}</td></tr>`
        )
        .join('') +
      '</tbody>';
    container.appendChild(table);
  }

  // ---- Monthly stacked chart ----
  const monthlyTitle = document.createElement('h3');
  monthlyTitle.className = 'section-title';
  monthlyTitle.textContent = tr('月別移動距離 (km) — 手段別内訳', 'Monthly distance (km) by travel mode');
  container.appendChild(monthlyTitle);

  const monthlyCanvas = document.createElement('canvas');
  monthlyCanvas.className = 'stats-chart';
  container.appendChild(monthlyCanvas);
  container.insertAdjacentHTML('beforeend', modeLegend(stats.monthly));
  requestAnimationFrame(() => drawMonthlyStackedChart(monthlyCanvas, stats.monthly));

  // ---- Longest trips ----
  const longestTitle = document.createElement('h3');
  longestTitle.className = 'section-title';
  longestTitle.textContent = tr('最長移動ランキング', 'Longest trips');
  container.appendChild(longestTitle);

  if (!longestTrips || longestTrips.length === 0) {
    container.insertAdjacentHTML('beforeend', `<p class="empty-note">${tr('この期間の移動データはありません。', 'No travel data in this period.')}</p>`);
  } else {
    const table = document.createElement('table');
    table.className = 'mode-table';
    table.innerHTML =
      `<thead><tr><th>#</th><th>${tr('日付', 'Date')}</th><th>${tr('手段', 'Mode')}</th><th>${tr('距離', 'Distance')}</th><th>${tr('始点', 'From')}</th><th>${tr('終点', 'To')}</th></tr></thead><tbody>` +
      longestTrips
        .map(
          (t, i) =>
            `<tr><td>${i + 1}</td><td>${dayLink(t.dateStr)}</td><td>${modeLabel(t.mode)}</td><td>${km(t.distanceMeters)} km</td><td>${t.startMuniName}</td><td>${t.endMuniName}</td></tr>`
        )
        .join('') +
      '</tbody>';
    container.appendChild(table);
  }

  // ---- Behavior patterns ----
  const patternTitle = document.createElement('h3');
  patternTitle.className = 'section-title';
  patternTitle.textContent = tr('行動パターン', 'Activity patterns');
  container.appendChild(patternTitle);

  const patternGrid = document.createElement('div');
  patternGrid.className = 'pattern-grid';

  const dowBlock = document.createElement('div');
  dowBlock.innerHTML = `<h4>${tr('曜日別 平均移動距離 (km)', 'Average distance by weekday (km)')}</h4>`;
  const dowCanvas = document.createElement('canvas');
  dowCanvas.className = 'stats-chart stats-chart-small';
  dowBlock.appendChild(dowCanvas);
  patternGrid.appendChild(dowBlock);

  const hourBlock = document.createElement('div');
  hourBlock.innerHTML = `<h4>${tr('時間帯別 移動開始回数', 'Trips started by hour')}</h4>`;
  const hourCanvas = document.createElement('canvas');
  hourCanvas.className = 'stats-chart stats-chart-small';
  hourBlock.appendChild(hourCanvas);
  patternGrid.appendChild(hourBlock);

  container.appendChild(patternGrid);

  requestAnimationFrame(() => {
    drawSimpleBarChart(dowCanvas, dayOfWeek, { value: (d) => d.avgDistance, label: (d) => d.label, formatValue: km });
    drawSimpleBarChart(hourCanvas, hourly, {
      value: (h) => h.count,
      label: (h) => (h.hour % 3 === 0 ? h.hour + tr('時', 'h') : ''),
      color: '#ffb454',
    });
  });

  const topDaysTitle = document.createElement('h4');
  topDaysTitle.textContent = tr('最も移動した日 トップ5', 'Top 5 travel days');
  container.appendChild(topDaysTitle);

  if (!topDays || topDays.length === 0) {
    container.insertAdjacentHTML('beforeend', `<p class="empty-note">${tr('この期間の移動データはありません。', 'No travel data in this period.')}</p>`);
  } else {
    const list = document.createElement('ul');
    list.className = 'rank-list';
    list.innerHTML = topDays.map((d, i) => `<li><span>${i + 1}. ${dayLink(d.dateStr)}</span><span class="rank-count">${km(d.distance)} km</span></li>`).join('');
    container.appendChild(list);
  }

  // ---- Municipality conquest ranking ----
  const conquestTitle = document.createElement('h3');
  conquestTitle.className = 'section-title';
  conquestTitle.textContent = tr('市区町村制覇率ランキング（都道府県別）', 'Municipality coverage by prefecture');
  container.appendChild(conquestTitle);

  if (!conquestRates || conquestRates.length === 0) {
    container.insertAdjacentHTML('beforeend', `<p class="empty-note">${tr('データがありません。', 'No data.')}</p>`);
  } else {
    const list = document.createElement('ul');
    list.className = 'rank-list';
    list.innerHTML = conquestRates
      .map(
        (r, i) =>
          `<li class="place-item" data-code="${r.code}"><span>${i + 1}. ${r.name}</span><span class="rank-count">${r.visited} / ${r.total}${tr('（{p}%）', ' ({p}%)', { p: (r.rate * 100).toFixed(0) })}${r.passOnly ? `<span class="pass-only-note">${tr(' ＋通過のみ {n}', ' +{n} passed through', { n: r.passOnly })}</span>` : ''}</span></li>`
      )
      .join('');
    container.appendChild(list);
    if (onConquestClick) {
      list.querySelectorAll('li').forEach((li, i) => li.addEventListener('click', () => onConquestClick(conquestRates[i])));
    }
  }

  // ---- Cluster (place) ranking ----
  const rankHeader = document.createElement('div');
  rankHeader.className = 'section-title';
  rankHeader.style.display = 'flex';
  rankHeader.style.alignItems = 'center';
  rankHeader.innerHTML =
    `<span>${privacy ? tr('よく行く場所ランキング（市区町村単位）', 'Most visited places (by municipality)') : tr('よく行く場所ランキング', 'Most visited places')}</span>` +
    '<span class="sort-toggle">' +
    `<button data-sort="count" class="${sortBy !== 'dwellMs' ? 'active' : ''}">${tr('回数順', 'By visits')}</button>` +
    `<button data-sort="dwellMs" class="${sortBy === 'dwellMs' ? 'active' : ''}">${tr('滞在時間順', 'By time spent')}</button>` +
    '</span>';
  container.appendChild(rankHeader);
  if (onSortByChange) {
    rankHeader.querySelectorAll('[data-sort]').forEach((btn) => btn.addEventListener('click', () => onSortByChange(btn.dataset.sort)));
  }

  if (clusterRanking.length === 0) {
    container.insertAdjacentHTML('beforeend', `<p class="empty-note">${tr('この期間の滞在データはありません。', 'No stays in this period.')}</p>`);
  } else {
    const list = document.createElement('ul');
    list.className = 'rank-list';
    list.innerHTML = clusterRanking
      .slice(0, 20)
      .map(
        (p, i) =>
          `<li><span>${i + 1}. ${p.muniName}</span><span class="rank-count">${tr('{n} 回', '{n} visits', { n: p.count })} / ${formatDuration(p.dwellMs)}</span></li>`
      )
      .join('');
    container.appendChild(list);
  }

  if (onDayClick) {
    container.querySelectorAll('[data-day]').forEach((btn) => btn.addEventListener('click', () => onDayClick(btn.dataset.day)));
  }

  if (dwellCapNote && dwellCapNote.cappedCount > 0) {
    container.insertAdjacentHTML(
      'beforeend',
      `<p class="empty-note">${tr('※ {n}件の滞在（全{total}件中）は24時間を超えていたため、集計上は24時間として計算しています。', '* {n} of {total} stays were longer than 24 hours and are counted as 24 hours.', { n: dwellCapNote.cappedCount, total: dwellCapNote.totalVisits })}</p>`
    );
  }
}

export { modeLabel, km, formatDuration };
