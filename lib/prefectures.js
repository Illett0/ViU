'use strict';

const fs = require('fs');
const path = require('path');
const bbox = require('@turf/bbox').default;
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { point } = require('@turf/helpers');

const GEOJSON_PATH = path.join(__dirname, '..', 'data', 'prefectures.geojson');

let featuresWithBBox = null;
let geojsonCache = null;

function loadGeoJSON() {
  if (!geojsonCache) {
    geojsonCache = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf-8'));
  }
  return geojsonCache;
}

function getFeatures() {
  if (!featuresWithBBox) {
    const geojson = loadGeoJSON();
    featuresWithBBox = geojson.features.map((f) => ({
      code: f.properties.code,
      name: f.properties.name,
      feature: f,
      bbox: bbox(f), // [minX, minY, maxX, maxY]
    }));
  }
  return featuresWithBBox;
}

function getPrefectureList() {
  return getFeatures().map((f) => ({ code: f.code, name: f.name }));
}

// ~1km grid cache key, since repeated visits/paths cluster tightly.
function cacheKey(lat, lng) {
  return Math.round(lat * 100) + '_' + Math.round(lng * 100);
}

const lookupCache = new Map();

// Returns { code, name } of the prefecture containing (lat, lng), or null if none matched.
function findPrefecture(lat, lng) {
  if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) return null;

  const key = cacheKey(lat, lng);
  if (lookupCache.has(key)) return lookupCache.get(key);

  const pt = point([lng, lat]);
  const features = getFeatures();
  let result = null;

  for (const f of features) {
    const [minX, minY, maxX, maxY] = f.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    if (booleanPointInPolygon(pt, f.feature)) {
      result = { code: f.code, name: f.name };
      break;
    }
  }

  lookupCache.set(key, result);
  return result;
}

module.exports = { findPrefecture, getPrefectureList, loadGeoJSON };
