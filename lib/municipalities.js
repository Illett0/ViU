'use strict';

const fs = require('fs');
const path = require('path');
const bbox = require('@turf/bbox').default;
const booleanPointInPolygon = require('@turf/boolean-point-in-polygon').default;
const { point } = require('@turf/helpers');

const GEOJSON_PATH = path.join(__dirname, '..', 'data', 'municipalities.geojson');

let featuresWithBBox = null;
let geojsonCache = null;

function loadGeoJSON() {
  if (!geojsonCache) {
    geojsonCache = JSON.parse(fs.readFileSync(GEOJSON_PATH, 'utf-8'));
  }
  return geojsonCache;
}

// Rough representative point for a municipality: the mean of the largest
// ring's vertices. Good enough for "round the pin to this municipality"
// privacy display — it doesn't need to be a true geometric centroid.
function approximateCentroid(feature) {
  const g = feature.geometry;
  const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  let largestRing = null;
  for (const poly of polys) {
    const ring = poly[0];
    if (!largestRing || ring.length > largestRing.length) largestRing = ring;
  }
  let sumLat = 0;
  let sumLng = 0;
  for (const [lng, lat] of largestRing) {
    sumLat += lat;
    sumLng += lng;
  }
  return { lat: sumLat / largestRing.length, lng: sumLng / largestRing.length };
}

function getFeatures() {
  if (!featuresWithBBox) {
    const geojson = loadGeoJSON();
    featuresWithBBox = geojson.features.map((f) => ({
      code: f.properties.code,
      name: f.properties.name,
      prefCode: f.properties.prefCode,
      feature: f,
      bbox: bbox(f), // [minX, minY, maxX, maxY]
      centroid: approximateCentroid(f),
    }));
  }
  return featuresWithBBox;
}

function getMunicipalityList() {
  return getFeatures().map((f) => ({ code: f.code, name: f.name, prefCode: f.prefCode, centroid: f.centroid }));
}

// ~11m grid cache key. Municipality boundaries can be close together in
// dense urban areas, so this needs to be much finer than the prefecture cache.
function cacheKey(lat, lng) {
  return Math.round(lat * 10000) + '_' + Math.round(lng * 10000);
}

const lookupCache = new Map();

// Returns { code, name, prefCode, centroid } of the municipality containing
// (lat, lng), or null if none matched (e.g. offshore, or the small number of
// "所属未定地" parcels excluded from the source data).
function findMunicipality(lat, lng) {
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
      result = { code: f.code, name: f.name, prefCode: f.prefCode, centroid: f.centroid };
      break;
    }
  }

  lookupCache.set(key, result);
  return result;
}

function getMunicipalityByCode(code) {
  return getFeatures().find((f) => f.code === code) || null;
}

module.exports = { findMunicipality, getMunicipalityList, getMunicipalityByCode, loadGeoJSON };
