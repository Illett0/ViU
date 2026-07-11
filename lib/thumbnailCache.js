'use strict';

// Disk cache for generated photo thumbnails (the resized JPEG that
// photos:get-thumbnail in main.js produces from a full-size photo). One
// .jpg file per source photo under userData/thumbnail-cache/, named by a
// fingerprint of the source's path+size+mtime plus the generation
// parameters — so an edited/replaced photo, or a change to the thumbnail
// dimensions/quality, naturally misses the cache instead of serving a stale
// thumbnail. Re-opening a popup for the same photo then costs one small
// file read instead of a full decode+resize+re-encode of a 5-15MB original
// (issue #9); for HEIC the saving is much larger still, since its decode
// goes through wasm (see worker/thumbnailWorker.js).
//
// This is a performance cache in the same sense as geoCache/nominatim:
// cache:clear wipes it, and losing it costs nothing but regeneration time.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR_NAME = 'thumbnail-cache';

function cacheDir(userDataPath) {
  return path.join(userDataPath, CACHE_DIR_NAME);
}

// `params` is an opaque string of whatever generation settings should
// invalidate the cache when they change (max dimension, JPEG quality, ...);
// the caller owns its format.
function cacheFilePath(userDataPath, filePath, params) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null; // Source photo unreadable/vanished — treat as uncacheable.
  }
  const hash = crypto.createHash('sha1').update(`${filePath}|${stat.size}|${stat.mtimeMs}|${params}`).digest('hex');
  return path.join(cacheDir(userDataPath), `${hash}.jpg`);
}

// Returns the cached JPEG Buffer, or null on any miss/error.
function read(userDataPath, filePath, params) {
  const target = cacheFilePath(userDataPath, filePath, params);
  if (!target) return null;
  try {
    return fs.readFileSync(target);
  } catch {
    return null;
  }
}

function write(userDataPath, filePath, params, jpegBuffer) {
  const target = cacheFilePath(userDataPath, filePath, params);
  if (!target) return;
  try {
    fs.mkdirSync(cacheDir(userDataPath), { recursive: true });
    fs.writeFileSync(target, jpegBuffer);
  } catch {
    // Best-effort; a failed write just means this thumbnail is regenerated next time.
  }
}

function clearCache(userDataPath) {
  let count = 0;
  let names;
  try {
    names = fs.readdirSync(cacheDir(userDataPath));
  } catch {
    return 0; // Cache dir doesn't exist yet.
  }
  for (const name of names) {
    try {
      fs.unlinkSync(path.join(cacheDir(userDataPath), name));
      count++;
    } catch {
      // Locked/vanished file — skip it, keep clearing the rest.
    }
  }
  return count;
}

module.exports = { read, write, clearCache };
