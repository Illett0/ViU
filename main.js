'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const nominatim = require('./lib/nominatim');
const exclusionZones = require('./lib/exclusionZones');
const recentFiles = require('./lib/recentFiles');

let mainWindow;
let prefectureGeoJSONCache = null;
let municipalityGeoJSONCache = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('timeline:get-prefecture-geojson', async () => {
  if (!prefectureGeoJSONCache) {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'prefectures.geojson'), 'utf-8');
    prefectureGeoJSONCache = JSON.parse(raw);
  }
  return prefectureGeoJSONCache;
});

ipcMain.handle('timeline:get-municipality-geojson', async () => {
  if (!municipalityGeoJSONCache) {
    const raw = fs.readFileSync(path.join(__dirname, 'data', 'municipalities.geojson'), 'utf-8');
    municipalityGeoJSONCache = JSON.parse(raw);
  }
  return municipalityGeoJSONCache;
});

ipcMain.handle('timeline:choose-file', async () => {
  // Test-only escape hatch: native file dialogs can't be driven by UI automation,
  // so E2E scripts set this env var to skip the dialog entirely.
  if (process.env.PATHBROWSER_TEST_FILE) return process.env.PATHBROWSER_TEST_FILE;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Googleタイムラインのエクスポートファイルを選択',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('timeline:parse-file', async (event, filePath) => {
  const userDataPath = app.getPath('userData');
  // Hash + backup runs concurrently with parsing (both just read the same
  // file independently) rather than sequentially after, so this doesn't add
  // to the visible load time. Registered on success only, so a file that
  // fails to parse (not actually a valid Timeline export) never gets backed up.
  const registration = recentFiles.registerImportedFile(userDataPath, filePath).catch((err) => {
    console.error('recent-files registration failed:', err);
    return null;
  });

  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker', 'parseWorker.js'), {
      workerData: { filePath, userDataPath },
    });

    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        event.sender.send('timeline:progress', msg);
      } else if (msg.type === 'done') {
        resolve(msg.result);
      } else if (msg.type === 'error') {
        reject(new Error(msg.message));
      }
    });

    worker.on('error', (err) => reject(err));
    worker.on('exit', (code) => {
      if (code !== 0) {
        // A non-zero exit without a prior 'done'/'error' message means the worker crashed.
      }
    });
  });

  await registration;
  return result;
});

ipcMain.handle('timeline:get-recent-files', async () => {
  return recentFiles.getRecentFiles(app.getPath('userData'));
});

ipcMain.handle('timeline:resolve-recent-file', async (event, hash) => {
  return recentFiles.resolveFileForOpen(app.getPath('userData'), hash);
});

ipcMain.handle('timeline:remove-recent-file', async (event, hash) => {
  return recentFiles.removeRecentFile(app.getPath('userData'), hash);
});

ipcMain.handle('timeline:recluster', async (event, { fingerprint, threshold, points }) => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker', 'clusterWorker.js'), {
      workerData: { points, threshold, userDataPath: app.getPath('userData'), fingerprint },
    });

    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        event.sender.send('timeline:recluster-progress', msg);
      } else if (msg.type === 'done') {
        resolve(msg.result);
      } else if (msg.type === 'error') {
        reject(new Error(msg.message));
      }
    });

    worker.on('error', (err) => reject(err));
  });
});

ipcMain.handle('timeline:reverse-geocode', async (event, { placeId, lat, lng }) => {
  return nominatim.reverseGeocode(app.getPath('userData'), { placeId, lat, lng });
});

ipcMain.handle('timeline:get-zones', async () => {
  return exclusionZones.readZones(app.getPath('userData'));
});

ipcMain.handle('timeline:save-zones', async (event, zones) => {
  return exclusionZones.writeZones(app.getPath('userData'), zones);
});

// Captures exactly what's on screen (respecting privacy mode, granularity,
// filters, and exclusion zones) rather than re-rendering the map headlessly —
// simplest way to guarantee the export can't accidentally show more than the
// live view does. `rect` is the map container's on-screen bounding box, in
// the same CSS-pixel coordinates as Element.getBoundingClientRect().
ipcMain.handle('timeline:export-png', async (event, rect) => {
  const image = await mainWindow.webContents.capturePage(rect);

  // Test-only escape hatch, mirroring PATHBROWSER_TEST_FILE: native save
  // dialogs can't be driven by UI automation.
  if (process.env.PATHBROWSER_TEST_EXPORT_PATH) {
    fs.writeFileSync(process.env.PATHBROWSER_TEST_EXPORT_PATH, image.toPNG());
    return process.env.PATHBROWSER_TEST_EXPORT_PATH;
  }

  const result = await dialog.showSaveDialog(mainWindow, {
    title: '制覇マップをPNGで保存',
    defaultPath: 'pathbrowser-map.png',
    filters: [{ name: 'PNG画像', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, image.toPNG());
  return result.filePath;
});
