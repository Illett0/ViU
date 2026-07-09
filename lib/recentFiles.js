'use strict';

// Tracks recently-imported Google Timeline export files so the welcome
// screen can offer to reopen one without a file dialog, even if the
// original file has since been moved, renamed, or deleted — each imported
// file is also copied into userData (a "backup"), and the list/backups are
// hash-keyed so re-importing byte-identical content (e.g. the same Takeout
// export downloaded twice, or re-opened from a different path) never
// produces a second backup copy. Capped at MAX_ENTRIES; anything that falls
// off the list has its backup deleted too, since unbounded retention of
// copies of someone's location history directly works against the "avoid
// leaking personal data" goal this whole feature exists alongside.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LIST_FILE = 'recent-files.json';
const BACKUP_DIR = 'timeline-backups';
const MAX_ENTRIES = 10;

function backupDir(userDataPath) {
  return path.join(userDataPath, BACKUP_DIR);
}

function listPath(userDataPath) {
  return path.join(userDataPath, LIST_FILE);
}

function readList(userDataPath) {
  try {
    const raw = fs.readFileSync(listPath(userDataPath), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeList(userDataPath, list) {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(listPath(userDataPath), JSON.stringify(list));
}

// Streaming SHA-256 so a 50MB+ export doesn't have to be held in memory a
// second time just to fingerprint it (the parse worker already reads it
// separately) — content hash, not path/size/mtime, because the whole point
// is recognizing "this is the same export" even under a different filename
// or path (e.g. re-downloaded from Takeout).
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function registerImportedFile(userDataPath, filePath) {
  const hash = await hashFile(filePath);
  const stat = fs.statSync(filePath);
  const list = readList(userDataPath);
  const existingIndex = list.findIndex((e) => e.hash === hash);

  if (existingIndex !== -1) {
    // Identical content already known — refresh metadata (path may have
    // changed) and bump to the front, but don't make a second backup copy.
    const existing = { ...list[existingIndex], originalPath: filePath, originalName: path.basename(filePath), sizeBytes: stat.size, lastOpenedAt: Date.now() };
    const rest = list.filter((e) => e.hash !== hash);
    writeList(userDataPath, [existing, ...rest]);
    return existing;
  }

  fs.mkdirSync(backupDir(userDataPath), { recursive: true });
  const backupPath = path.join(backupDir(userDataPath), hash + '.json');
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }

  const entry = {
    hash,
    originalPath: filePath,
    originalName: path.basename(filePath),
    backupPath,
    sizeBytes: stat.size,
    importedAt: Date.now(),
    lastOpenedAt: Date.now(),
  };

  const updated = [entry, ...list];
  const kept = updated.slice(0, MAX_ENTRIES);
  const dropped = updated.slice(MAX_ENTRIES);
  for (const d of dropped) {
    try {
      if (d.backupPath && fs.existsSync(d.backupPath)) fs.unlinkSync(d.backupPath);
    } catch {
      // Best-effort cleanup — a leftover backup file here is not worth
      // failing the whole import over.
    }
  }
  writeList(userDataPath, kept);
  return entry;
}

function getRecentFiles(userDataPath) {
  return readList(userDataPath);
}

// Prefers the original path if it's still reachable (content is identical
// either way, since list membership is hash-keyed), falling back to the
// internal backup copy transparently — this is what makes "open from
// history" keep working after the original file is moved or deleted.
function resolveFileForOpen(userDataPath, hash) {
  const list = readList(userDataPath);
  const entry = list.find((e) => e.hash === hash);
  if (!entry) return null;
  if (entry.originalPath && fs.existsSync(entry.originalPath)) return entry.originalPath;
  if (entry.backupPath && fs.existsSync(entry.backupPath)) return entry.backupPath;
  return null;
}

function removeRecentFile(userDataPath, hash) {
  const list = readList(userDataPath);
  const entry = list.find((e) => e.hash === hash);
  if (entry && entry.backupPath) {
    try {
      if (fs.existsSync(entry.backupPath)) fs.unlinkSync(entry.backupPath);
    } catch {
      // Best-effort.
    }
  }
  writeList(userDataPath, list.filter((e) => e.hash !== hash));
  return getRecentFiles(userDataPath);
}

module.exports = { registerImportedFile, getRecentFiles, resolveFileForOpen, removeRecentFile, hashFile };
