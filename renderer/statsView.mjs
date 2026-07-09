import { colorForMode } from './routeView.mjs';

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
  return MODE_LABELS[mode] || mode;
}

function km(meters) {
  return (meters / 1000).toLocaleString('ja-JP', { maximumFractionDigits: 1 });
}

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}分`;
  return `${h}時間${m}分`;
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
  ctx.fillText('データがありません', 12, 20);
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
  }
) {
  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'stats-grid';

  const totalCard = document.createElement('div');
  totalCard.className = 'stat-card';
  totalCard.innerHTML = `<div class="big-number">${km(stats.totalDistance)} km</div><div class="caption">総移動距離</div>`;
  grid.appendChild(totalCard);

  const totalTrips = stats.byMode.reduce((s, m) => s + m.count, 0);
  const modeCountCard = document.createElement('div');
  modeCountCard.className = 'stat-card';
  modeCountCard.innerHTML = `<div class="big-number">${totalTrips}</div><div class="caption">移動回数</div>`;
  grid.appendChild(modeCountCard);

  const walkCard = document.createElement('div');
  walkCard.className = 'stat-card';
  walkCard.innerHTML = `<div class="big-number">${walkingRatio.toFixed(1)} 倍</div><div class="caption">徒歩の累計距離は東海道五十三次（約490km）の何倍か</div>`;
  grid.appendChild(walkCard);

  if (newlyVisited && newlyVisited.length > 0) {
    const newlyCard = document.createElement('div');
    newlyCard.className = 'stat-card';
    newlyCard.innerHTML =
      `<div class="big-number">${newlyVisited.length}</div><div class="caption">この年に初めて訪れた県</div>` +
      `<ul class="newly-visited-list">${newlyVisited.map((p) => `<li>${p.name}</li>`).join('')}</ul>`;
    grid.appendChild(newlyCard);
  }

  container.appendChild(grid);

  // ---- Mode breakdown table ----
  const modeTitle = document.createElement('h3');
  modeTitle.className = 'section-title';
  modeTitle.textContent = '移動手段別の内訳';
  container.appendChild(modeTitle);

  if (stats.byMode.length === 0) {
    container.insertAdjacentHTML('beforeend', '<p class="empty-note">この期間の移動データはありません。</p>');
  } else {
    const table = document.createElement('table');
    table.className = 'mode-table';
    table.innerHTML =
      '<thead><tr><th>手段</th><th>距離</th><th>回数</th><th>合計時間</th><th>平均速度</th></tr></thead><tbody>' +
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
  monthlyTitle.textContent = '月別移動距離 (km) — 手段別内訳';
  container.appendChild(monthlyTitle);

  const monthlyCanvas = document.createElement('canvas');
  monthlyCanvas.className = 'stats-chart';
  container.appendChild(monthlyCanvas);
  container.insertAdjacentHTML('beforeend', modeLegend(stats.monthly));
  requestAnimationFrame(() => drawMonthlyStackedChart(monthlyCanvas, stats.monthly));

  // ---- Longest trips ----
  const longestTitle = document.createElement('h3');
  longestTitle.className = 'section-title';
  longestTitle.textContent = '最長移動ランキング';
  container.appendChild(longestTitle);

  if (!longestTrips || longestTrips.length === 0) {
    container.insertAdjacentHTML('beforeend', '<p class="empty-note">この期間の移動データはありません。</p>');
  } else {
    const table = document.createElement('table');
    table.className = 'mode-table';
    table.innerHTML =
      '<thead><tr><th>#</th><th>日付</th><th>手段</th><th>距離</th><th>始点</th><th>終点</th></tr></thead><tbody>' +
      longestTrips
        .map(
          (t, i) =>
            `<tr><td>${i + 1}</td><td>${t.dateStr || '-'}</td><td>${modeLabel(t.mode)}</td><td>${km(t.distanceMeters)} km</td><td>${t.startMuniName}</td><td>${t.endMuniName}</td></tr>`
        )
        .join('') +
      '</tbody>';
    container.appendChild(table);
  }

  // ---- Behavior patterns ----
  const patternTitle = document.createElement('h3');
  patternTitle.className = 'section-title';
  patternTitle.textContent = '行動パターン';
  container.appendChild(patternTitle);

  const patternGrid = document.createElement('div');
  patternGrid.className = 'pattern-grid';

  const dowBlock = document.createElement('div');
  dowBlock.innerHTML = '<h4>曜日別 平均移動距離 (km)</h4>';
  const dowCanvas = document.createElement('canvas');
  dowCanvas.className = 'stats-chart stats-chart-small';
  dowBlock.appendChild(dowCanvas);
  patternGrid.appendChild(dowBlock);

  const hourBlock = document.createElement('div');
  hourBlock.innerHTML = '<h4>時間帯別 移動開始回数</h4>';
  const hourCanvas = document.createElement('canvas');
  hourCanvas.className = 'stats-chart stats-chart-small';
  hourBlock.appendChild(hourCanvas);
  patternGrid.appendChild(hourBlock);

  container.appendChild(patternGrid);

  requestAnimationFrame(() => {
    drawSimpleBarChart(dowCanvas, dayOfWeek, { value: (d) => d.avgDistance, label: (d) => d.label, formatValue: km });
    drawSimpleBarChart(hourCanvas, hourly, {
      value: (h) => h.count,
      label: (h) => (h.hour % 3 === 0 ? h.hour + '時' : ''),
      color: '#ffb454',
    });
  });

  const topDaysTitle = document.createElement('h4');
  topDaysTitle.textContent = '最も移動した日 トップ5';
  container.appendChild(topDaysTitle);

  if (!topDays || topDays.length === 0) {
    container.insertAdjacentHTML('beforeend', '<p class="empty-note">この期間の移動データはありません。</p>');
  } else {
    const list = document.createElement('ul');
    list.className = 'rank-list';
    list.innerHTML = topDays.map((d, i) => `<li><span>${i + 1}. ${d.dateStr}</span><span class="rank-count">${km(d.distance)} km</span></li>`).join('');
    container.appendChild(list);
  }

  // ---- Municipality conquest ranking ----
  const conquestTitle = document.createElement('h3');
  conquestTitle.className = 'section-title';
  conquestTitle.textContent = '市区町村制覇率ランキング（都道府県別）';
  container.appendChild(conquestTitle);

  if (!conquestRates || conquestRates.length === 0) {
    container.insertAdjacentHTML('beforeend', '<p class="empty-note">データがありません。</p>');
  } else {
    const list = document.createElement('ul');
    list.className = 'rank-list';
    list.innerHTML = conquestRates
      .map(
        (r, i) =>
          `<li class="place-item" data-code="${r.code}"><span>${i + 1}. ${r.name}</span><span class="rank-count">${r.visited} / ${r.total}（${(r.rate * 100).toFixed(0)}%）</span></li>`
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
    `<span>${privacy ? 'よく行く場所ランキング（市区町村単位）' : 'よく行く場所ランキング'}</span>` +
    '<span class="sort-toggle">' +
    `<button data-sort="count" class="${sortBy !== 'dwellMs' ? 'active' : ''}">回数順</button>` +
    `<button data-sort="dwellMs" class="${sortBy === 'dwellMs' ? 'active' : ''}">滞在時間順</button>` +
    '</span>';
  container.appendChild(rankHeader);
  if (onSortByChange) {
    rankHeader.querySelectorAll('[data-sort]').forEach((btn) => btn.addEventListener('click', () => onSortByChange(btn.dataset.sort)));
  }

  if (clusterRanking.length === 0) {
    container.insertAdjacentHTML('beforeend', '<p class="empty-note">この期間の滞在データはありません。</p>');
  } else {
    const list = document.createElement('ul');
    list.className = 'rank-list';
    list.innerHTML = clusterRanking
      .slice(0, 20)
      .map(
        (p, i) =>
          `<li><span>${i + 1}. ${p.muniName}</span><span class="rank-count">${p.count} 回 / ${formatDuration(p.dwellMs)}</span></li>`
      )
      .join('');
    container.appendChild(list);
  }

  if (dwellCapNote && dwellCapNote.cappedCount > 0) {
    container.insertAdjacentHTML(
      'beforeend',
      `<p class="empty-note">※ ${dwellCapNote.cappedCount}件の滞在（全${dwellCapNote.totalVisits}件中）は24時間を超えていたため、集計上は24時間として計算しています。</p>`
    );
  }
}

export { modeLabel, km, formatDuration };
