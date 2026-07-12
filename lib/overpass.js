'use strict';

// Fallback landmark lookup via the Overpass API (OpenStreetMap), used only
// when Nominatim's reverse-geocode result (lib/nominatim.js) looks
// unreliable — a shop/kiosk/vending-machine tenant name with no enclosing
// building tag, a wayfinding path label, or no name at all. Verified live
// (2026-07-12) that Nominatim's `address` breakdown essentially never
// carries the enclosing building/mall name for these Japan indoor-POI
// cases even when a named building polygon genuinely contains the point
// (e.g. a "サブウェイ" node inside the TFTビル building relation had no
// `address.building` key at all) — so a geometry-aware lookup is the only
// way to recover the actual landmark name.
//
// Two lookups, tried in order:
//   1. is_in() containment — is this point literally inside a named
//      building/mall/retail-landuse polygon? (fixes the "テナント名しか
//      出ない" case, e.g. TFTビル)
//   2. Nearest named train station within a short radius (fixes the
//      "改札口"/station-concourse-kiosk case, e.g. 東京ビッグサイト駅,
//      品川駅)
// Falls back to null (caller keeps its own Nominatim-derived label) if
// neither finds anything, or on any network/API error — this is always a
// secondary enhancement, never a hard dependency.
//
// Overpass's public instance has no single documented rate limit like
// Nominatim's 1 req/sec, but it does actively rate-limit bursty clients (hit
// this live while developing the feature), so requests here are paced even
// more conservatively than the Nominatim client, and every result — success
// or genuine "nothing found" — is cached to disk indefinitely so a given
// coordinate is only ever queried once.

const fs = require('fs');
const path = require('path');

const USER_AGENT = 'PathBrowser/1.0 (local desktop app, non-commercial; https://github.com/Illett0/PathBrowser)';
const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const MIN_INTERVAL_MS = 2000;
const STATION_SEARCH_RADIUS_M = 250;

const CACHE_VERSION = 1;
let cacheFilePath = null;
let cache = null; // Map<string, string|null>
let lastRequestAt = 0;
let queue = Promise.resolve();

function keyFor(lat, lng) {
  return lat.toFixed(5) + ',' + lng.toFixed(5);
}

function loadCache(userDataPath) {
  if (cache) return cache;
  cacheFilePath = path.join(userDataPath, 'overpass-cache.json');
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

// Returns the parsed Overpass response, or null on any HTTP/network failure
// (distinct from "queried fine, found nothing" — callers must not cache a
// null from here as a real answer).
async function runQuery(ql) {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(ql),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Area tag keys that mark a named area as a real physical landmark rather
// than an administrative boundary — is_in() also returns country/prefecture
// /ward/neighbourhood areas for any point, which Nominatim's own address
// breakdown already covers, so those are explicitly excluded.
const LANDMARK_AREA_KEYS = ['building', 'shop', 'landuse', 'leisure', 'tourism', 'amenity'];

function isNamedLandmarkArea(tags) {
  if (!tags || !tags.name) return false;
  if (tags.boundary || tags.place) return false;
  return LANDMARK_AREA_KEYS.some((k) => !!tags[k]);
}

// Is this point literally inside a named building/mall/retail-landuse
// polygon? Returns { name, ok }: ok=false means the query itself failed
// (caller should not cache), ok=true + name=null means it succeeded and
// genuinely found nothing.
async function findContainingLandmark(lat, lng) {
  const data = await runQuery(`[out:json][timeout:15];is_in(${lat},${lng});out tags;`);
  if (!data) return { name: null, ok: false };

  const areas = (data.elements || []).filter((e) => e.type === 'area' && isNamedLandmarkArea(e.tags));
  if (areas.length === 0) return { name: null, ok: true };
  // A building tag is the most direct "this is the place" signal; prefer it
  // over a broader retail/commercial landuse zone if both happen to match.
  const building = areas.find((a) => a.tags.building);
  return { name: (building || areas[0]).tags.name, ok: true };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Nearest named train station within STATION_SEARCH_RADIUS_M. Same
// { name, ok } shape as findContainingLandmark.
async function findNearestStation(lat, lng) {
  const ql =
    `[out:json][timeout:15];` +
    `node(around:${STATION_SEARCH_RADIUS_M},${lat},${lng})["railway"~"^(station|halt)$"]["name"];out;`;
  const data = await runQuery(ql);
  if (!data) return { name: null, ok: false };

  const elements = data.elements || [];
  if (elements.length === 0) return { name: null, ok: true };

  let nearest = null;
  let nearestDist = Infinity;
  for (const el of elements) {
    const d = haversineMeters(lat, lng, el.lat, el.lon);
    if (d < nearestDist) {
      nearestDist = d;
      nearest = el;
    }
  }
  return { name: nearest.tags.name, ok: true };
}

// Returns the name of a notable nearby landmark, or null if none was found
// or the lookup failed. Results (including genuine "nothing found") are
// cached indefinitely per coordinate; failed lookups are not cached, so
// they're retried on next request.
async function findNearbyLandmark(userDataPath, lat, lng) {
  loadCache(userDataPath);
  const key = keyFor(lat, lng);
  if (cache.has(key)) return cache.get(key);

  return queue = queue.then(async () => {
    const contained = await findContainingLandmark(lat, lng);
    if (!contained.ok) return null;
    if (contained.name) {
      cache.set(key, contained.name);
      persistCache();
      return contained.name;
    }

    const nearStation = await findNearestStation(lat, lng);
    if (!nearStation.ok) return null;
    cache.set(key, nearStation.name);
    persistCache();
    return nearStation.name;
  });
}

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

module.exports = { findNearbyLandmark, clearCache };
