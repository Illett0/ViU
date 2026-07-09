// Renders the "年表" (chronology) view: first-visit events for prefectures
// (and optionally municipalities), grouped under year/month headings.

function dateStrFromEpoch(epoch) {
  return new Date(epoch).toISOString().slice(0, 10);
}

export function renderChronology(container, events, onClickEvent) {
  container.innerHTML = '';
  if (!events || events.length === 0) {
    container.innerHTML = '<p class="empty-note">データがありません。</p>';
    return;
  }

  let lastYear = null;
  let lastMonth = null;

  for (const ev of events) {
    const dateStr = dateStrFromEpoch(ev.epoch);
    const [y, m] = dateStr.split('-');

    if (y !== lastYear) {
      const heading = document.createElement('div');
      heading.className = 'chronology-year-heading';
      heading.textContent = y + '年';
      container.appendChild(heading);
      lastYear = y;
      lastMonth = null;
    }
    if (m !== lastMonth) {
      const heading = document.createElement('div');
      heading.className = 'chronology-month-heading';
      heading.textContent = Number(m) + '月';
      container.appendChild(heading);
      lastMonth = m;
    }

    const item = document.createElement('div');
    item.className = 'chronology-item';
    const isPref = ev.type === 'prefecture';
    const label = isPref ? `${ev.name} 初訪問${ev.muniHintName ? `（${ev.muniHintName}）` : ''}` : `${ev.name} 初訪問`;
    item.innerHTML =
      `<span class="chronology-date">${dateStr}</span>` +
      `<span class="chronology-tag ${isPref ? 'pref' : ''}">${isPref ? '県' : '市区町村'}</span>` +
      `<span>${label}</span>`;
    item.addEventListener('click', () => onClickEvent(ev));
    container.appendChild(item);
  }
}
