'use strict';

// Persistence for bookmarks (issue #35): named saved views — tab, view,
// period filter, granularity, and for a stay point its real-world anchor
// coordinates (cluster ids don't survive re-clustering or a different
// timeline file, a coordinate does). Like exclusion zones, they're stored in
// userData and kept across timeline files; they can hold location data, so
// main.js lists this file in USER_DATA_ENTRIES (「すべてのデータを削除」).

const fs = require('fs');
const path = require('path');

function bookmarksFilePath(userDataPath) {
  return path.join(userDataPath, 'bookmarks.json');
}

function readBookmarks(userDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(bookmarksFilePath(userDataPath), 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBookmarks(userDataPath, bookmarks) {
  const list = Array.isArray(bookmarks) ? bookmarks : [];
  fs.writeFileSync(bookmarksFilePath(userDataPath), JSON.stringify(list));
  return list;
}

module.exports = { readBookmarks, writeBookmarks };
