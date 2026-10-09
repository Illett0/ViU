'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pathBrowser', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  chooseFile: () => ipcRenderer.invoke('timeline:choose-file'),
  parseFile: (filePath) => ipcRenderer.invoke('timeline:parse-file', filePath),
  getPrefectureGeoJSON: () => ipcRenderer.invoke('timeline:get-prefecture-geojson'),
  getMunicipalityGeoJSON: () => ipcRenderer.invoke('timeline:get-municipality-geojson'),
  getReferenceLists: () => ipcRenderer.invoke('timeline:get-reference-lists'),
  recluster: (fingerprint, threshold, points) => ipcRenderer.invoke('timeline:recluster', { fingerprint, threshold, points }),
  reverseGeocode: (placeId, lat, lng) => ipcRenderer.invoke('timeline:reverse-geocode', { placeId, lat, lng }),
  getZones: () => ipcRenderer.invoke('timeline:get-zones'),
  saveZones: (zones) => ipcRenderer.invoke('timeline:save-zones', zones),
  getBookmarks: () => ipcRenderer.invoke('bookmarks:get'),
  saveBookmarks: (list) => ipcRenderer.invoke('bookmarks:save', list),
  exportMapPng: (rect) => ipcRenderer.invoke('timeline:export-png', rect),
  getRecentFiles: () => ipcRenderer.invoke('timeline:get-recent-files'),
  resolveRecentFile: (hash) => ipcRenderer.invoke('timeline:resolve-recent-file', hash),
  removeRecentFile: (hash) => ipcRenderer.invoke('timeline:remove-recent-file', hash),
  clearCache: () => ipcRenderer.invoke('cache:clear'),
  deleteAllData: () => ipcRenderer.invoke('data:delete-all'),
  setPrivacyMode: (enabled) => ipcRenderer.invoke('app:set-privacy-mode', enabled),
  getLanguage: () => ipcRenderer.invoke('app:get-language'),
  setLanguage: (language) => ipcRenderer.invoke('app:set-language', language),
  choosePhotoFolder: () => ipcRenderer.invoke('photos:choose-folder'),
  getLinkedPhotoFolder: () => ipcRenderer.invoke('photos:get-linked-folder'),
  scanPhotoFolder: (folder) => ipcRenderer.invoke('photos:scan-folder', folder),
  getPhotoThumbnail: (filePath) => ipcRenderer.invoke('photos:get-thumbnail', filePath),
  onProgress: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('timeline:progress', listener);
    return () => ipcRenderer.removeListener('timeline:progress', listener);
  },
  onReclusterProgress: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('timeline:recluster-progress', listener);
    return () => ipcRenderer.removeListener('timeline:recluster-progress', listener);
  },
  onPhotoScanProgress: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('photos:scan-progress', listener);
    return () => ipcRenderer.removeListener('photos:scan-progress', listener);
  },
});
