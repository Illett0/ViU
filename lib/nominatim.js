'use strict';

// On-demand reverse geocoding via Nominatim (OpenStreetMap), used only when the
// user opens a place/cluster detail panel (or, for ranking rows, scrolls one
// into view) with privacy mode off. Requests are serialized with a >=1.1s gap
// (Nominatim's usage policy caps at 1 req/sec) and a descriptive User-Agent is
// sent as required by that policy. Results are cached to disk indefinitely,
// keyed by placeId (preferred) or rounded coords.

const fs = require('fs');
const path = require('path');

const USER_AGENT = 'PathBrowser/1.0 (local desktop app, non-commercial; https://github.com/Illett0/PathBrowser)';
const MIN_INTERVAL_MS = 1100;

// Bump whenever a change alters what coordinate/placeId gets queried for the
// same cache key (e.g. switching from cluster centroid to the modal visit
// location), OR whenever extractLabel()'s logic changes — either way, old
// entries would otherwise silently keep serving a label computed the old
// way. Bumped 2 -> 3 for the shop/mall enclosing-name heuristic below, so
// re-testing it isn't confounded by already-cached (old-logic) labels.
const CACHE_VERSION = 3;

let cacheFilePath = null;
let cache = null; // Map<string, { label: string|null, error: string|null }>
let lastRequestAt = 0;
let queue = Promise.resolve();

function keyFor(placeId, lat, lng) {
  if (placeId) return 'place:' + placeId;
  return 'coord:' + lat.toFixed(5) + ',' + lng.toFixed(5);
}

function loadCache(userDataPath) {
  if (cache) return cache;
  cacheFilePath = path.join(userDataPath, 'nominatim-cache.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
    cache = parsed.version === CACHE_VERSION ? new Map(Object.entries(parsed.entries)) : new Map();
  } catch {
    cache = new Map();
  }
  return cache;
}

function persistCache() {
  if (!cacheFilePath) return;
  try {
    fs.writeFileSync(cacheFilePath, JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(cache) }));
  } catch {
    // Best-effort; a failed persist just means we'll re-fetch next launch.
  }
}

// Nominatim reverse (zoom=18) returns the single smallest OSM feature that
// contains the query point. That's usually right (a named POI like "大阪駅"
// sitting on its own way/node comes back as data.name directly), but for a
// point inside a large facility mapped as many small sub-features — a shop
// unit inside a shopping mall, a kiosk inside a station concourse — the
// *found* feature is that small unit, while the enclosing mall/station is
// only present in the address breakdown (address.mall / address.building /
// etc., whichever tag the enclosing polygon happens to use).
//
// So: for a small handful of "this is probably a sub-unit of something
// bigger" categories (shop / office / other retail-tenant-like classes), we
// prefer the enclosing named area over the specific unit's own name. For
// everything else (railway stations included) data.name stays first, since
// that's normally already the right, most specific answer.
//
// NOTE: this was tuned from a static read of Nominatim's documented
// zoom/address-layer behaviour, not from live queries — the sandbox this was
// developed in cannot reach nominatim.openstreetmap.org (network policy), so
// this could not be verified against real coordinates (e.g. 大阪駅 /
// 三宮駅) or real ambiguous-mall cases. Please sanity-check this against a
// few real points once the app is running, and report back anything that
// still looks wrong (the raw Nominatim JSON for a bad case is the fastest
// way to retune this).
const SUBUNIT_CATEGORIES = new Set(['shop', 'office']);

// Enclosing-area address keys, most useful for "what's the building/complex
// called" first: a shopping mall is sometimes tagged as its own category
// (mall/retail/commercial) rather than a generic "building".
const ENCLOSING_AREA_KEYS = ['mall', 'building', 'retail', 'commercial', 'department_store'];

function enclosingAreaName(addr) {
  for (const key of ENCLOSING_AREA_KEYS) {
    if (addr[key]) return addr[key];
  }
  return null;
}

// Priority: a named POI > a building name > the neighbourhood/town-level
// name, in descending order of "how specific and human-recognizable is this"
// — except when the found feature looks like a sub-unit of something bigger
// (see SUBUNIT_CATEGORIES above), in which case the enclosing area's name is
// preferred over the specific unit's own name.
function extractLabel(data) {
  const addr = data.address || {};
  const isSubunit = SUBUNIT_CATEGORIES.has(data.category);

  if (isSubunit) {
    const enclosing = enclosingAreaName(addr);
    if (enclosing) return enclosing;
  }

  if (data.name) return data.name;
  const enclosing = enclosingAreaName(addr);
  if (enclosing) return enclosing;
  const areaName = addr.neighbourhood || addr.suburb || addr.quarter;
  if (areaName) return areaName;
  if (addr.road) return addr.road;
  if (data.display_name) return data.display_name.split(',')[0];
  return null;
}

async function doFetch(lat, lng) {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=ja&zoom=18`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return { label: null, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { label: extractLabel(data), error: null };
  } catch (err) {
    return { label: null, error: err.message || String(err) };
  }
}

// Returns { label: string|null, error: string|null, fromCache: boolean }
async function reverseGeocode(userDataPath, { placeId, lat, lng }) {
  loadCache(userDataPath);
  const key = keyFor(placeId, lat, lng);
  if (cache.has(key)) return { ...cache.get(key), fromCache: true };

  const result = await (queue = queue.then(() => doFetch(lat, lng)));
  if (!result.error) {
    cache.set(key, result);
    persistCache();
  }
  return { ...result, fromCache: false };
}

// Drops both the in-memory and on-disk reverse-geocode cache. After this,
// every place detail panel re-queries Nominatim from scratch (subject to the
// usual 1req/sec pacing) instead of reusing previously-fetched labels.
// Returns the number of cached entries removed, for user-facing feedback.
function clearCache(userDataPath) {
  loadCache(userDataPath);
  const count = cache.size;
  cache = new Map();
  try {
    if (cacheFilePath && fs.existsSync(cacheFilePath)) fs.unlinkSync(cacheFilePath);
  } catch {
    // Best-effort; an in-use/locked file shouldn't abort the rest of the clear.
  }
  return count;
}

module.exports = { reverseGeocode, clearCache };
