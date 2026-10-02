'use strict';

// Single source of truth for "which prefecture/municipality is this point in".
//
// The prefecture and municipality boundary files come from different
// datasets (dataofjapan/land vs. MLIT 国土数値情報 N03 — see README 境界データ
// について), so judging the two independently could disagree near borders:
// a visit judged 大阪府 by the prefecture polygon but 紀の川市 (和歌山県) by
// the municipality polygon then showed up under the wrong prefecture and
// didn't count toward that prefecture's own 市区町村制覇率. Measured against
// a random sample over Kansai/Kanto/Fukuoka: ~0.4% of points disagreed
// outright, and another ~0.8% matched in only one of the two datasets
// (mostly coastline/reclaimed land, where the simplified polygons are cut
// short).
//
// So the municipality is resolved first and the prefecture is *derived*
// from it (the N03 code's own prefecture), guaranteeing the two always
// agree. Points just outside every municipality polygon (harbors, piers,
// reclaimed land the simplified coastline cuts off) snap to the nearest
// municipality within NEAREST_MAX_METERS; the prefecture polygon is only a
// last resort for points that are still unresolved after that.

const { findMunicipality, findNearestMunicipality } = require('./municipalities');
const { findPrefecture } = require('./prefectures');

const NEAREST_MAX_METERS = 3000;

// Returns { muniCode: string|null, prefCode: number } — prefCode 0 means
// "outside Japan / unresolvable", matching the existing convention in
// worker/parseWorker.js.
function locate(lat, lng) {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return { muniCode: null, prefCode: 0 };
  const m = findMunicipality(lat, lng) || findNearestMunicipality(lat, lng, NEAREST_MAX_METERS);
  if (m) return { muniCode: m.code, prefCode: m.prefCode };
  const p = findPrefecture(lat, lng);
  return { muniCode: null, prefCode: p ? p.code : 0 };
}

module.exports = { locate, NEAREST_MAX_METERS };
