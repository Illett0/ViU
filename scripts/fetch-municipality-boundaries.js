'use strict';

// Regenerates data/municipalities.geojson from a *less* simplified source
// than what's currently bundled.
//
// BACKGROUND: the currently-committed data/municipalities.geojson is the
// smartnews-smri/japan-topography "簡素化0.1%版" (see README.md's 境界データ
// について section) — averaging only ~17.6 vertices per municipality, which
// is the direct cause of the "境界がめっちゃ雑" complaint. The same repo also
// publishes a "簡素化1%版" (data/municipality/geojson/s0010/), only available
// as 47 separate per-prefecture files (not one national file), using the
// *raw* MLIT 国土数値情報 N03 property schema (N03_001=都道府県名,
// N03_003=郡・政令市名, N03_004=市区町村名, N03_007=行政区域コード) rather
// than the already-transformed {code, name, prefCode} schema this app reads
// (see lib/municipalities.js). This script fetches all 47 files and performs
// that same transformation, plus groups any exclave/island polygons that
// share a code into one MultiPolygon feature (defensive — safe whether or
// not the source already groups them).
//
// WHY THIS IS A SCRIPT, NOT ALREADY-FETCHED DATA: this was written from
// inside a sandboxed Claude session whose web-fetch tool silently truncates
// large responses (confirmed empirically: both a "national" URL and a
// Tokyo-only URL under s0010 came back truncated to ~73KB / ~27 features,
// nowhere near a complete file) and has no general internet access outside
// that one fetch tool. Materializing ~47 files (a few hundred KB to a few MB
// each) safely isn't possible under that constraint — silently shipping a
// truncated municipalities.geojson (most of Japan missing) would be far
// worse than not shipping the upgrade at all. Run this script yourself
// (`node scripts/fetch-municipality-boundaries.js`) on a machine with normal
// internet access instead; Node 18+ (for global fetch) is required.
//
// After running, spot-check a few known borders in the app (the README's
// "確認済み" note about Tokyo's mainland bbox excluding Ogasawara is a good
// regression check) before committing the regenerated file.

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://raw.githubusercontent.com/smartnews-smri/japan-topography/main/data/municipality/geojson/s0010';
const OUT_PATH = path.join(__dirname, '..', 'data', 'municipalities.geojson');
const PREF_GEOJSON_PATH = path.join(__dirname, '..', 'data', 'prefectures.geojson');

// Prefecture-name -> code lookup, from the already-bundled prefectures.geojson
// (same {code, name} shape used everywhere else in this app) rather than a
// hardcoded table, so it can't drift out of sync with that file.
function loadPrefNameToCode() {
  const geojson = JSON.parse(fs.readFileSync(PREF_GEOJSON_PATH, 'utf-8'));
  const map = new Map();
  for (const f of geojson.features) {
    map.set(f.properties.name, f.properties.code);
  }
  return map;
}

function prefFileSuffix(code) {
  return String(code).padStart(2, '0');
}

async function fetchPrefFile(code) {
  const url = `${BASE_URL}/N03-21_${prefFileSuffix(code)}_210101.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Merges any features that share the same `code` into a single feature with
// MultiPolygon geometry (covers the exclave/island case regardless of
// whether the source file already did this grouping).
function groupByCode(rawFeatures, prefNameToCode) {
  const byCode = new Map();
  for (const f of rawFeatures) {
    const p = f.properties;
    const code = p.N03_007;
    if (!code) continue; // a few rows in the source data are legitimately code-less (unresolved/水面下 parcels) — skip, matching current lib/municipalities.js behaviour of returning null for those.
    const name = p.N03_003 ? p.N03_003 + p.N03_004 : p.N03_004;
    const prefCode = prefNameToCode.get(p.N03_001);

    const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];

    let entry = byCode.get(code);
    if (!entry) {
      entry = { code, name, prefCode, polys: [] };
      byCode.set(code, entry);
    }
    entry.polys.push(...polys);
  }

  return [...byCode.values()].map((e) => ({
    type: 'Feature',
    properties: { code: e.code, name: e.name, prefCode: e.prefCode },
    geometry: e.polys.length === 1 ? { type: 'Polygon', coordinates: e.polys[0] } : { type: 'MultiPolygon', coordinates: e.polys },
  }));
}

async function main() {
  const prefNameToCode = loadPrefNameToCode();
  const allFeatures = [];

  for (let code = 1; code <= 47; code++) {
    process.stdout.write(`fetching prefecture ${code}/47...\n`);
    const geojson = await fetchPrefFile(code);
    const grouped = groupByCode(geojson.features, prefNameToCode);
    allFeatures.push(...grouped);
    // Be polite to GitHub's raw content host — no documented rate limit, but
    // there's no reason to hammer it either.
    await new Promise((r) => setTimeout(r, 200));
  }

  const out = { type: 'FeatureCollection', features: allFeatures };

  if (fs.existsSync(OUT_PATH)) {
    fs.copyFileSync(OUT_PATH, OUT_PATH + '.bak');
    console.log(`Backed up existing file to ${OUT_PATH}.bak`);
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));

  const totalCoords = allFeatures.reduce((sum, f) => {
    const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
    return sum + polys.reduce((s, poly) => s + poly[0].length, 0);
  }, 0);

  console.log(`Wrote ${allFeatures.length} municipality features (expected ~1894) to ${OUT_PATH}`);
  console.log(`Total exterior-ring coordinate points: ${totalCoords} (was ~33,394 in the 0.1% version — should be noticeably higher)`);
  console.log('Next: run the app, toggle to 市区町村 granularity, and spot-check a few borders (e.g. a coastline near you) before committing.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
