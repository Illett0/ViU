'use strict';

// Parses Google Timeline coordinate strings like "35.8716351°, 137.9774036°"
// into { lat, lng }. Returns null if the string is missing or malformed.
function parseLatLng(str) {
  if (typeof str !== 'string') return null;
  const parts = str.split(',');
  if (parts.length !== 2) return null;
  const lat = parseFloat(parts[0].replace('°', '').trim());
  const lng = parseFloat(parts[1].replace('°', '').trim());
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  return { lat, lng };
}

// Haversine distance in meters.
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = { parseLatLng, distanceMeters };
