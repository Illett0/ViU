'use strict';

// Persistence for user-defined "exclusion zones" (e.g. home) — a privacy
// control that applies regardless of the privacy-mode toggle. Stored as a
// flat JSON file in userData so it survives across app restarts and across
// different timeline files (a zone is a place in the real world, not a fact
// about one export).

const fs = require('fs');
const path = require('path');

function zonesFilePath(userDataPath) {
  return path.join(userDataPath, 'exclusion-zones.json');
}

function readZones(userDataPath) {
  try {
    const raw = fs.readFileSync(zonesFilePath(userDataPath), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeZones(userDataPath, zones) {
  fs.writeFileSync(zonesFilePath(userDataPath), JSON.stringify(zones));
  return zones;
}

module.exports = { readZones, writeZones };
