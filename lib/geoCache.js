'use strict';

// Disk cache for expensive per-file geo computations (municipality lookup,
// visit clustering). Keyed by a fingerprint of the source file's path + size +
// mtime, so re-opening the same, unchanged file skips recomputation entirely.
// Not a content hash: the timeline JSON can be 50MB+, so hashing its bytes on
// every open would itself be slow. Path+size+mtime is a good-enough proxy.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function computeFingerprint(filePath) {
  const stat = fs.statSync(filePath);
  const raw = `${filePath}|${stat.size}|${stat.mtimeMs}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

function getCacheDir(userDataPath) {
  const dir = path.join(userDataPath, 'geo-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCachePath(userDataPath, fingerprint) {
  return path.join(getCacheDir(userDataPath), `${fingerprint}.json`);
}

function readCache(userDataPath, fingerprint) {
  try {
    const p = getCachePath(userDataPath, fingerprint);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCache(userDataPath, fingerprint, data) {
  try {
    fs.writeFileSync(getCachePath(userDataPath, fingerprint), JSON.stringify(data));
  } catch {
    // Cache is a pure optimization; a failed write (e.g. disk full) shouldn't crash parsing.
  }
}

module.exports = { computeFingerprint, getCacheDir, getCachePath, readCache, writeCache };
