'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pathBrowser', {
  chooseFile: () => ipcRenderer.invoke('timeline:choose-file'),
  parseFile: (filePath) => ipcRenderer.invoke('timeline:parse-file', filePath),
  getPrefectureGeoJSON: () => ipcRenderer.invoke('timeline:get-prefecture-geojson'),
  getMunicipalityGeoJSON: () => ipcRenderer.invoke('timeline:get-municipality-geojson'),
  recluster: (fingerprint, threshold, points) => ipcRenderer.invoke('timeline:recluster', { fingerprint, threshold, points }),
  reverseGeocode: (placeId, lat, lng) => ipcRenderer.invoke('timeline:reverse-geocode', { placeId, lat, lng }),
  getZones: () => ipcRenderer.invoke('timeline:get-zones'),
  saveZones: (zones) => ipcRenderer.invoke('timeline:save-zones', zones),
  exportMapPng: (rect) => ipcRenderer.invoke('timeline:export-png', rect),
  getRecentFiles: () => ipcRenderer.invoke('timeline:get-recent-files'),
  resolveRecentFile: (hash) => ipcRenderer.invoke('timeline:resolve-recent-file', hash),
  removeRecentFile: (hash) => ipcRenderer.invoke('timeline:remove-recent-file', hash),
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
});
