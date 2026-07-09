'use strict';

// Recursively scans a user-selected folder for photos, extracting GPS
// coordinates + taken-at timestamps from Exif and/or a Google Takeout
// sidecar JSON (Takeout exports each photo alongside a
// "<name>.<ext>.json" / "<name>.<ext>.supplemental-metadata.json" file
// carrying geoData + photoTakenTime). See docs handed off for the full
// spec — summary of the rules implemented here:
//
// - Location priority: Exif GPS > Takeout geoData. A (0,0) coordinate from
//   Takeout is treated as "no location" (a known placeholder Google uses
//   for photos it couldn't geotag — plotting it literally lands in the
//   Gulf of Guinea).
// - Taken-at priority: Exif DateTimeOriginal > Takeout photoTakenTime >
//   file mtime (flagged as a fallback, since it reflects when the file was
//   copied/downloaded, not when the photo was taken).
// - Unsupported/corrupt files, and unparsable sidecar JSON, are skipped
//   individually rather than aborting the whole scan.
// - Results are cached (lib/photoCache.js) keyed by file mtime, so a
//   re-scan only re-reads files that changed since last time.

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const exifr = require('exifr');
const photoCache = require('../lib/photoCache');

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic']);
const PROGRESS_INTERVAL = 25; // report every N files, not every single one

function report(current, total) {
  parentPort.postMessage({ type: 'progress', phase: 'scanning', current, total });
}

// Recursively collects every photo file path under `dir`. Symlinks are not
// followed (readdirSync default), which also sidesteps any risk of an
// accidental symlink loop.
function collectPhotoFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // Unreadable directory (permissions, etc.) — skip it, don't abort the whole scan.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectPhotoFiles(full, out);
    } else if (entry.isFile() && PHOTO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

// Finds a Google Takeout sidecar JSON for `fileName` among `dirFiles` (the
// already-listed contents of that photo's directory). Takeout's naming has
// a few variants (see module comment above); this looks for the most exact
// match first, then falls back to any "starts with the photo name, ends
// with .json" candidate.
function findSidecarName(dirFiles, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  const exact1 = fileName + '.json'; // "IMG_001.jpg.json"
  const exact2 = base + '.json'; // "IMG_001.json"
  if (dirFiles.has(exact1)) return exact1;
  if (dirFiles.has(exact2)) return exact2;
  let best = null;
  for (const f of dirFiles) {
    if (f === fileName) continue;
    if (f.endsWith('.json') && (f.startsWith(fileName) || f.startsWith(base))) {
      if (!best || f.length < best.length) best = f;
    }
  }
  return best;
}

function readTakeoutSidecar(sidecarPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    const geo = parsed.geoData;
    const hasZeroZero = geo && geo.latitude === 0 && geo.longitude === 0;
    const location = geo && !hasZeroZero && (geo.latitude !== 0 || geo.longitude !== 0) ? { lat: geo.latitude, lng: geo.longitude } : null;
    const takenAtSec = parsed.photoTakenTime && parsed.photoTakenTime.timestamp != null ? Number(parsed.photoTakenTime.timestamp) : null;
    return {
      location,
      takenAtMs: takenAtSec != null && !Number.isNaN(takenAtSec) ? takenAtSec * 1000 : null,
    };
  } catch {
    return { location: null, takenAtMs: null }; // Malformed/missing sidecar — continue with Exif-only data.
  }
}

// A single `exifr.parse(filePath)` call with default options returns a
// merged object containing both the translated GPS decimal coordinates
// (`latitude`/`longitude`, when a GPS block is present) and `DateTimeOriginal`
// (when present) from one read of the file — verified empirically against a
// real Exif-tagged JPEG. Previously this made two separate exifr calls
// (`exifr.gps()` + `exifr.parse(file, ['DateTimeOriginal'])`), each opening
// the file independently; with libraries in the tens-of-thousands-of-photos
// range that doubled the I/O cost of the scan for no benefit, so this was
// consolidated into one call.
async function readExif(filePath) {
  try {
    const tags = await exifr.parse(filePath);
    if (!tags) return { gps: null, dateTimeOriginal: null }; // No Exif segment at all (exifr returns undefined, not an error).
    const gps =
      typeof tags.latitude === 'number' && typeof tags.longitude === 'number' ? { latitude: tags.latitude, longitude: tags.longitude } : null;
    const dateTimeOriginal = tags.DateTimeOriginal instanceof Date ? tags.DateTimeOriginal.getTime() : null;
    return { gps, dateTimeOriginal };
  } catch {
    // Not a format exifr recognizes, corrupt file, etc. — both fields fall
    // back to Takeout/mtime in scanOne below.
    return { gps: null, dateTimeOriginal: null };
  }
}

async function scanOne(filePath, dirFilesCache) {
  const dir = path.dirname(filePath);
  const fileName = path.basename(filePath);
  if (!dirFilesCache.has(dir)) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    dirFilesCache.set(dir, new Set(names));
  }
  const dirFiles = dirFilesCache.get(dir);

  const { gps, dateTimeOriginal } = await readExif(filePath);

  let takeout = { location: null, takenAtMs: null };
  const sidecarName = findSidecarName(dirFiles, fileName);
  if (sidecarName) {
    takeout = readTakeoutSidecar(path.join(dir, sidecarName));
  }

  let lat = null;
  let lng = null;
  let source = null;
  if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number' && !(gps.latitude === 0 && gps.longitude === 0)) {
    lat = gps.latitude;
    lng = gps.longitude;
    source = 'exif';
  } else if (takeout.location) {
    lat = takeout.location.lat;
    lng = takeout.location.lng;
    source = 'takeout';
  }

  let takenAtMs = null;
  let takenAtIsFallback = false;
  if (dateTimeOriginal != null) {
    takenAtMs = dateTimeOriginal;
  } else if (takeout.takenAtMs != null) {
    takenAtMs = takeout.takenAtMs;
  } else {
    try {
      takenAtMs = fs.statSync(filePath).birthtimeMs;
    } catch {
      takenAtMs = null;
    }
    takenAtIsFallback = true;
  }

  return {
    lat,
    lng,
    hasLocation: lat != null,
    source,
    takenAtMs,
    takenAtIsFallback,
  };
}

async function run() {
  const { folder, userDataPath } = workerData;

  const files = [];
  collectPhotoFiles(folder, files);

  const existingEntries = photoCache.getEntries(userDataPath);
  const dirFilesCache = new Map();
  const entries = {};
  let withLocationExif = 0;
  let withLocationTakeout = 0;

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    if (i % PROGRESS_INTERVAL === 0) report(i, files.length);

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue; // File vanished mid-scan — skip it.
    }

    const existing = existingEntries[filePath];
    let entry;
    if (existing && existing.mtime === stat.mtimeMs) {
      entry = existing; // Unchanged since last scan — reuse cached result, no re-read.
    } else {
      const scanned = await scanOne(filePath, dirFilesCache);
      entry = { mtime: stat.mtimeMs, ...scanned };
    }

    entries[filePath] = entry;
    if (entry.source === 'exif') withLocationExif++;
    else if (entry.source === 'takeout') withLocationTakeout++;
  }

  report(files.length, files.length);

  photoCache.saveEntries(userDataPath, entries);
  photoCache.setLinkedFolder(userDataPath, folder);

  const photos = Object.entries(entries).map(([filePath, e]) => ({ filePath, ...e }));

  parentPort.postMessage({
    type: 'done',
    result: {
      photos,
      summary: {
        total: files.length,
        withLocation: withLocationExif + withLocationTakeout,
        withLocationExif,
        withLocationTakeout,
      },
    },
  });
}

run().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
});
