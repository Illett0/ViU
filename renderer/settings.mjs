// Settings screen: exclusion zones (+ suggestions), caches/data deletion, version.

import { findMunicipalityCodeForPoint } from './mapView.mjs';
import { initZoneMap, renderZoneCircles, renderPendingCircle, renderZoneList, renderSuggestions } from './settingsView.mjs';
import { applyPrivacy, applyExclusionZones, isInAnyZone, distanceMeters, municipalityName, computeClusterRanking } from './aggregate.mjs';
import { el, state, ui, zoneLayerRef, zonePendingLayerRef } from './context.mjs';
import { stopTimelapse } from './timelapse.mjs';
import { render } from './app.mjs';

// Exact point-in-polygon lookup, falling back to nearest-centroid only for
// the rare point that misses every polygon (e.g. a coastline simplification gap).
export function nearestMunicipalityCode(lat, lng) {
  const exact = state.muniGeoJSON && findMunicipalityCodeForPoint(state.muniGeoJSON, lat, lng);
  if (exact) return exact;

  let best = null;
  let bestDist = Infinity;
  for (const m of state.raw.municipalities) {
    const d = distanceMeters(lat, lng, m.centroid.lat, m.centroid.lng);
    if (d < bestDist) {
      bestDist = d;
      best = m.code;
    }
  }
  return best;
}

// Google純正のHOME/WORKラベル（state.raw.frequentPlaces）は、Googleのタイムライン
// エクスポート自体が通常1件ずつしか付与しないため、それ以外にも自宅・職場・その他
// 人に見られたくない場所である可能性がある地点を候補として出せるよう、訪問回数
// 上位N件をそれぞれ個別に提案する（issue #14）。
export const NUM_TOP_PLACE_SUGGESTIONS = 10;

export function computeSuggestions() {
  if (!state.raw) return [];
  const suggestions = [];
  const homeWorkPoints = []; // 上位N件の候補から、既にHOME/WORKとして提案済みの地点を除外するための重複判定用
  for (const p of state.raw.frequentPlaces || []) {
    if (p.label !== 'HOME' && p.label !== 'WORK') continue;
    if (isInAnyZone(p.lat, p.lng, state.zones)) continue;
    homeWorkPoints.push({ lat: p.lat, lng: p.lng, radiusMeters: 300 });
    const key = 'freq:' + (p.placeId || `${p.lat},${p.lng}`);
    if (state.dismissedSuggestions.has(key)) continue;
    const name = municipalityName(state.municipalityByCode, nearestMunicipalityCode(p.lat, p.lng));
    suggestions.push({
      key,
      text: `${p.label === 'HOME' ? '自宅' : '職場'}と推定される地点（${name}）を除外ゾーンに登録しますか？（半径300m）`,
      lat: p.lat,
      lng: p.lng,
      radiusMeters: 300,
    });
  }

  const allRanking = computeClusterRanking(applyPrivacy(state.raw, false), {
    privacy: false,
    municipalityByCode: state.municipalityByCode,
    limit: NUM_TOP_PLACE_SUGGESTIONS,
  });
  allRanking.forEach((row, i) => {
    if (isInAnyZone(row.lat, row.lng, state.zones)) return;
    if (isInAnyZone(row.lat, row.lng, homeWorkPoints)) return; // 上のHOME/WORK提案と同一地点なら重複表示しない
    const key = 'top:' + row.clusterId;
    if (state.dismissedSuggestions.has(key)) return;
    suggestions.push({
      key,
      text: `よく訪れる地点（訪問回数 ${i + 1}位、${row.muniName}、${row.count}回）を除外ゾーンに登録しますか？自宅・職場など人に見られたくない場所の可能性がある場合にご利用ください（半径300m）`,
      lat: row.lat,
      lng: row.lng,
      radiusMeters: 300,
    });
  });
  return suggestions;
}

export async function persistZones() {
  await window.pathBrowser.saveZones(state.zones);
}

export function renderSettingsScreen() {
  if (!ui.zoneMap) {
    ui.zoneMap = initZoneMap(el.zoneMapDiv);
    ui.zoneMap.on('click', (e) => {
      ui.pendingZoneCenter = e.latlng;
      el.zonePending.hidden = false;
      renderPendingCircle(ui.zoneMap, zonePendingLayerRef, ui.pendingZoneCenter, Number(el.zoneRadiusInput.value));
    });
  }
  ui.zoneMap.invalidateSize();
  renderZoneCircles(ui.zoneMap, zoneLayerRef, state.zones);

  const suggestions = computeSuggestions();
  renderSuggestions(el.zoneSuggestions, suggestions, {
    onAccept: async (i) => {
      const s = suggestions[i];
      state.zones.push({ lat: s.lat, lng: s.lng, radiusMeters: s.radiusMeters });
      await persistZones();
      renderSettingsScreen();
    },
    onDismiss: (i) => {
      state.dismissedSuggestions.add(suggestions[i].key);
      renderSettingsScreen();
    },
  });

  renderZoneList(el.zoneList, state.zones, {
    labelFor: (z) => municipalityName(state.municipalityByCode, nearestMunicipalityCode(z.lat, z.lng)),
    onDelete: async (i) => {
      state.zones.splice(i, 1);
      await persistZones();
      renderSettingsScreen();
    },
  });

  if (state.raw) {
    const withZones = applyExclusionZones(applyPrivacy(state.raw, state.privacy), state.zones);
    el.zoneHiddenCount.textContent = `非表示: ${withZones.excludedVisitCount} 件`;
  } else {
    el.zoneHiddenCount.textContent = '';
  }
}

export function openSettings({ fromImport = false } = {}) {
  stopTimelapse();
  el.settingsScreen.hidden = false;
  el.mapScreen.hidden = true;
  el.routeScreen.hidden = true;
  el.chronologyScreen.hidden = true;
  el.statsScreen.hidden = true;
  el.tabs.hidden = true;
  // Shown only on the auto-open-after-import path (see openFile), not when
  // the user opens settings manually via the toolbar button — it's a
  // one-time "check this before you browse" nudge, not a permanent notice.
  el.settingsImportBanner.hidden = !fromImport;
  renderSettingsScreen();
}

export function closeSettings() {
  el.settingsScreen.hidden = true;
  el.tabs.hidden = false;
  render(); // re-shows whichever screen matches state.tab (mapScreen included)
  // The main Leaflet map's container was hidden (display:none) for the
  // whole privacy-notice + settings detour — Leaflet caches its container
  // size and doesn't notice a display:none→visible flip on its own, so
  // without this the map can render cut off/misaligned until the window is
  // resized or the map is panned. Must run *after* render() has actually
  // un-hidden #map-screen, otherwise it measures a still-hidden (0-size) container.
  if (ui.map && state.tab === 'map') ui.map.invalidateSize();
}

export function wireSettings() {
  window.pathBrowser.getAppVersion().then((version) => {
    el.settingsVersion.textContent = `ViU v${version}`;
  });

  // Wrapped for the same reason as openFile's listeners (loading.mjs wireLoading) — openSettings
  // destructures its argument (`{ fromImport = false } = {}`), so a MouseEvent
  // passed straight through wouldn't crash (it just has no `.fromImport`
  // property, silently yielding the correct `false` by luck) but that's
  // fragile; wrapping makes the omission explicit rather than accidental.
  el.btnSettings.addEventListener('click', () => openSettings());
  el.btnSettingsClose.addEventListener('click', closeSettings);
  el.btnSettingsGotoMap.addEventListener('click', closeSettings);

  el.btnClearCache.addEventListener('click', async () => {
    const proceed = confirm('市区町村判定・クラスタリング結果、地名取得結果、写真のサムネイルのキャッシュを削除します。次回ファイルを開いたときに再計算されます（除外ゾーンや最近使ったファイルの履歴は削除されません）。続けますか？');
    if (!proceed) return;
    el.btnClearCache.disabled = true;
    try {
      const { geoCount, nominatimCount, thumbnailCount } = await window.pathBrowser.clearCache();
      el.cacheClearResult.hidden = false;
      el.cacheClearResult.textContent = `キャッシュをクリアしました（判定結果 ${geoCount}件、地名 ${nominatimCount}件、サムネイル ${thumbnailCount}件）。`;
    } finally {
      el.btnClearCache.disabled = false;
    }
  });

  // Confirmation happens in the main process (native dialog — see main.js
  // data:delete-all). On success the page is reloaded so no in-memory copy of
  // the timeline, photos, or zones survives in this window either.
  async function deleteAllData(btn) {
    btn.disabled = true;
    try {
      const { deleted } = await window.pathBrowser.deleteAllData();
      if (deleted) location.reload();
    } finally {
      btn.disabled = false;
    }
  }
  el.btnDeleteAllData.addEventListener('click', () => deleteAllData(el.btnDeleteAllData));
  el.btnDeleteAllDataWelcome.addEventListener('click', () => deleteAllData(el.btnDeleteAllDataWelcome));

  el.btnPrivacyNoticeContinue.addEventListener('click', () => {
    el.privacyNoticeScreen.hidden = true;
    openSettings({ fromImport: true });
  });

  el.zoneRadiusInput.addEventListener('input', () => {
    el.zoneRadiusLabel.textContent = el.zoneRadiusInput.value + 'm';
    if (ui.pendingZoneCenter) renderPendingCircle(ui.zoneMap, zonePendingLayerRef, ui.pendingZoneCenter, Number(el.zoneRadiusInput.value));
  });
  el.btnZoneConfirm.addEventListener('click', async () => {
    if (!ui.pendingZoneCenter) return;
    state.zones.push({ lat: ui.pendingZoneCenter.lat, lng: ui.pendingZoneCenter.lng, radiusMeters: Number(el.zoneRadiusInput.value) });
    ui.pendingZoneCenter = null;
    el.zonePending.hidden = true;
    renderPendingCircle(ui.zoneMap, zonePendingLayerRef, null, 0);
    await persistZones();
    renderSettingsScreen();
  });
  el.btnZoneCancel.addEventListener('click', () => {
    ui.pendingZoneCenter = null;
    el.zonePending.hidden = true;
    renderPendingCircle(ui.zoneMap, zonePendingLayerRef, null, 0);
  });
}
