'use strict';

// On-demand reverse geocoding via Nominatim (OpenStreetMap), used only when the
// user opens a place/cluster detail panel (or, for ranking rows, scrolls one
// into view) with privacy mode off. Requests are serialized with a >=1.1s gap
// (Nominatim's usage policy caps at 1 req/sec) and a descriptive User-Agent is
// sent as required by that policy. Results are cached to disk indefinitely,
// keyed by placeId (preferred) or rounded coords.
//
// When the Nominatim result looks unreliable (see extractLabel()'s
// `confident` flag), doFetch() falls through to a secondary Overpass API
// lookup (lib/overpass.js) that can find a landmark Nominatim's address
// data doesn't surface — see that file for why this is necessary.

const fs = require('fs');
const path = require('path');
const overpass = require('./overpass');

const USER_AGENT = 'PathBrowser/1.0 (local desktop app, non-commercial; https://github.com/Illett0/PathBrowser)';
const MIN_INTERVAL_MS = 1100;

// Bump whenever a change alters what coordinate/placeId gets queried for the
// same cache key (e.g. switching from cluster centroid to the modal visit
// location), OR whenever extractLabel()'s logic changes — either way, old
// entries would otherwise silently keep serving a label computed the old
// way. Bumped 3 -> 4 for the amenity-tenant heuristic and the wayfinding-path
// name filter, 4 -> 5 for widening the wayfinding filter beyond
// category=highway and adding vending_machine as a subunit type, 5 -> 6 for
// the Overpass landmark-lookup fallback (see doFetch) — all verified live
// against real Nominatim/Overpass responses — see comments below.
const CACHE_VERSION = 6;

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
const SUBUNIT_CATEGORIES = new Set(['shop', 'office']);

// A cafe/restaurant inside a large facility (e.g. a chain cafe inside an
// exhibition hall) is tagged category=amenity, not shop/office, so it fell
// through the check above and kept its own tenant name instead of the
// enclosing facility's. amenity is too broad a category to treat wholesale
// as a sub-unit though (it also covers standalone destinations like
// hospitals/schools/townhalls, which should keep their own name even on the
// rare chance they sit inside a tagged "building"/"mall" area) — so for
// amenity, only these specific small-tenant types get the enclosing-area
// treatment. This extends the SUBUNIT_CATEGORIES heuristic above by
// reasoning, not a live-verified repro (no concrete amenity-in-facility
// example was found while testing live against nominatim.openstreetmap.org
// — see WAYFINDING_NAME_RE below for what *was* live-verified).
const AMENITY_SUBUNIT_TYPES = new Set([
  'cafe', 'restaurant', 'fast_food', 'bar', 'pub', 'ice_cream',
  'bank', 'atm', 'pharmacy', 'clinic', 'dentist', 'food_court', 'vending_machine',
]);

// A second, distinct failure mode found live: paths/platforms/entrances
// inside or around stations are frequently name-tagged in Japan OSM data
// with a wayfinding label (改札口 "ticket gate", 連絡通路 "connecting
// passage", etc.) rather than an actual place name. Confirmed live: the
// footway through 東京ビッグサイト駅's gate carries
// name="東京ビッグサイト駅改札口" — Nominatim returns that name directly,
// so without this filter the app would show "改札口" as the visited place
// instead of falling back to the surrounding area name.
//
// Deliberately NOT restricted to a specific category/type (an earlier
// version only matched category=highway, which missed the same labelling
// pattern showing up on other feature types e.g. railway platforms) —
// a real destination name essentially never ends in one of these
// functional/navigational suffixes, so the name pattern alone is a safe,
// low-false-positive signal on its own.
const WAYFINDING_NAME_RE = /(改札口?|出口|入口|連絡通路|地下通路|連絡橋|コンコース)$/;

function isWayfindingPathName(data) {
  return !!data.name && WAYFINDING_NAME_RE.test(data.name);
}

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
//
// `confident: false` marks results where a live-verified gap in Nominatim's
// Japan data means the label is likely wrong or just an area-level
// approximation (a bare tenant name with no enclosing building/mall tag, or
// any of the neighbourhood/road/display_name fallbacks) — doFetch() uses
// this to decide whether it's worth spending an Overpass round-trip trying
// to do better (see lib/overpass.js).
function extractLabel(data) {
  const addr = data.address || {};
  const isSubunit = SUBUNIT_CATEGORIES.has(data.category) || (data.category === 'amenity' && AMENITY_SUBUNIT_TYPES.has(data.type));
  const skipOwnName = isWayfindingPathName(data);

  if (isSubunit || skipOwnName) {
    const enclosing = enclosingAreaName(addr);
    if (enclosing) return { label: enclosing, confident: true };
  }

  if (data.name && !skipOwnName) return { label: data.name, confident: !isSubunit };
  const enclosing = enclosingAreaName(addr);
  if (enclosing) return { label: enclosing, confident: true };
  const areaName = addr.neighbourhood || addr.suburb || addr.quarter;
  if (areaName) return { label: areaName, confident: false };
  if (addr.road && !WAYFINDING_NAME_RE.test(addr.road)) return { label: addr.road, confident: false };
  if (data.display_name) return { label: data.display_name.split(',')[0], confident: false };
  return { label: null, confident: false };
}

async function doFetch(userDataPath, lat, lng) {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=ja&zoom=18`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return { label: null, error: `HTTP ${res.status}` };
    const data = await res.json();
    const primary = extractLabel(data);
    if (!primary.confident) {
      const landmark = await overpass.findNearbyLandmark(userDataPath, lat, lng);
      if (landmark) return { label: landmark, error: null };
    }
    return { label: primary.label, error: null };
  } catch (err) {
    return { label: null, error: err.message || String(err) };
  }
}

// Returns { label: string|null, error: string|null, fromCache: boolean }
async function reverseGeocode(userDataPath, { placeId, lat, lng }) {
  loadCache(userDataPath);
  const key = keyFor(placeId, lat, lng);
  if (cache.has(key)) return { ...cache.get(key), fromCache: true };

  const result = await (queue = queue.then(() => doFetch(userDataPath, lat, lng)));
  if (!result.error) {
    cache.set(key, result);
    persistCache();
  }
  return { ...result, fromCache: false };
}

// Drops both the in-memory and on-disk reverse-geocode cache (Nominatim and
// the Overpass landmark-lookup fallback together — from the settings screen
// these are presented as one "地名取得結果" cache). After this, every place
// detail panel re-queries from scratch (subject to the usual rate pacing)
// instead of reusing previously-fetched labels. Returns the number of
// cached entries removed, for user-facing feedback.
function clearCache(userDataPath) {
  loadCache(userDataPath);
  const count = cache.size;
  cache = new Map();
  try {
    if (cacheFilePath && fs.existsSync(cacheFilePath)) fs.unlinkSync(cacheFilePath);
  } catch {
    // Best-effort; an in-use/locked file shouldn't abort the rest of the clear.
  }
  return count + overpass.clearCache(userDataPath);
}

module.exports = { reverseGeocode, clearCache };
