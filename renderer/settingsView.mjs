// Settings screen: draws/edits user-defined exclusion zones on their own
// small Leaflet map instance. Pure rendering helpers only — app.mjs owns the
// click/slider/button interaction wiring and persistence.

export function initZoneMap(containerEl) {
  const map = L.map(containerEl, { center: [36.5, 138], zoom: 5, minZoom: 3 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);
  return map;
}

export function renderZoneCircles(map, layerRef, zones) {
  if (layerRef.layer) {
    map.removeLayer(layerRef.layer);
    layerRef.layer = null;
  }
  const group = L.layerGroup();
  for (const z of zones) {
    L.circle([z.lat, z.lng], {
      radius: z.radiusMeters,
      color: '#ff6b6b',
      weight: 2,
      fillColor: '#ff6b6b',
      fillOpacity: 0.2,
    }).addTo(group);
  }
  group.addTo(map);
  layerRef.layer = group;
}

export function renderPendingCircle(map, pendingLayerRef, center, radiusMeters) {
  if (pendingLayerRef.layer) {
    map.removeLayer(pendingLayerRef.layer);
    pendingLayerRef.layer = null;
  }
  if (!center) return;
  const circle = L.circle(center, {
    radius: radiusMeters,
    color: '#4da3ff',
    weight: 2,
    dashArray: '6 4',
    fillColor: '#4da3ff',
    fillOpacity: 0.15,
  }).addTo(map);
  pendingLayerRef.layer = circle;
}

export function renderZoneList(container, zones, { labelFor, onDelete }) {
  if (zones.length === 0) {
    container.innerHTML = '<p class="empty-note">登録されているゾーンはありません。</p>';
    return;
  }
  container.innerHTML = zones
    .map((z, i) => `<li><span>${labelFor(z, i)} — 半径${z.radiusMeters}m</span><button class="zone-delete" data-index="${i}">削除</button></li>`)
    .join('');
  container.querySelectorAll('.zone-delete').forEach((btn) => {
    btn.addEventListener('click', () => onDelete(Number(btn.dataset.index)));
  });
}

export function renderSuggestions(container, suggestions, { onAccept, onDismiss }) {
  if (!suggestions || suggestions.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = suggestions
    .map(
      (s, i) =>
        `<div class="zone-suggestion"><span>${s.text}</span><span>` +
        `<button class="btn btn-primary" data-accept="${i}">除外ゾーンに追加</button> ` +
        `<button class="btn" data-dismiss="${i}">閉じる</button></span></div>`
    )
    .join('');
  container.querySelectorAll('[data-accept]').forEach((btn) => btn.addEventListener('click', () => onAccept(Number(btn.dataset.accept))));
  container.querySelectorAll('[data-dismiss]').forEach((btn) => btn.addEventListener('click', () => onDismiss(Number(btn.dataset.dismiss))));
}
