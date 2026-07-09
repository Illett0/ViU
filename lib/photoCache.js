'use strict';

// Disk cache for scanned photo metadata (GPS coords + taken-at timestamp,
// read from Exif and/or a Google Takeout sidecar JSON — see
// worker/photoScanWorker.js for the actual extraction logic). Mirrors the
// path+mtime fingerprint approach used by lib/geoCache.js for the timeline
// cache, but keyed per-file in a single manifest (there can be thousands of
// photos, so one file per photo like geoCache would be wasteful) rather than
// one cache file per source file.
//
// Also persists which folder is currently "linked" (the last folder the user
// selected via 写真フォルダを連携), so re-opening the app can offer to
// re-scan it automatically without the user having to re-pick it every time.

const fs = require('fs');
const path = require('path');

const CACHE_FILE_NAME = 'photo-cache.json';
// Bump whenever the *shape* of a cached entry changes (new/renamed fields) or
// extraction logic changes in a way that should invalidate old entries —
// otherwise stale entries would silently keep being served as "unchanged".
const CACHE_VERSION = 1;

function cacheFilePath(userDataPath) {
  return path.join(userDataPath, CACHE_FILE_NAME);
}

function emptyState() {
  return { version: CACHE_VERSION, folder: null, entries: {} };
}

function readState(userDataPath) {
  try {
    const raw = fs.readFileSync(cacheFilePath(userDataPath), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== CACHE_VERSION || typeof parsed.entries !== 'object') return emptyState();
    return parsed;
  } catch {
    return emptyState();
  }
}

function writeState(userDataPath, state) {
  try {
    fs.writeFileSync(cacheFilePath(userDataPath), JSON.stringify(state));
  } catch {
    // Best-effort; a failed write just means the next scan starts cold.
  }
}

function getLinkedFolder(userDataPath) {
  return readState(userDataPath).folder;
}

function setLinkedFolder(userDataPath, folder) {
  const state = readState(userDataPath);
  state.folder = folder;
  writeState(userDataPath, state);
}

// Returns { [absoluteFilePath]: entry } for the currently-linked folder's
// previously-scanned files. The scan worker uses this to skip re-reading
// Exif/Takeout data for files whose mtime hasn't changed since last scan.
function getEntries(userDataPath) {
  return readState(userDataPath).entries;
}

// Replaces the entire entries map (the scan worker builds the full set —
// unchanged files copied from the old cache, changed/new files freshly read,
// deleted files simply omitted — and hands it back here in one write rather
// than many incremental ones).
function saveEntries(userDataPath, entries) {
  const state = readState(userDataPath);
  state.entries = entries;
  writeState(userDataPath, state);
}

function clearAll(userDataPath) {
  writeState(userDataPath, emptyState());
}

// Used by the settings-screen "キャッシュをクリア" button: drops the
// per-file scan results (so the next scan re-reads everything from scratch)
// but keeps the linked folder itself, since that's a setting, not a cache.
function clearEntries(userDataPath) {
  const state = readState(userDataPath);
  const count = Object.keys(state.entries).length;
  state.entries = {};
  writeState(userDataPath, state);
  return count;
}

module.exports = { getLinkedFolder, setLinkedFolder, getEntries, saveEntries, clearAll, clearEntries };
