'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeImage, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const nominatim = require('./lib/nominatim');
const exclusionZones = require('./lib/exclusionZones');
const recentFiles = require('./lib/recentFiles');
const geoCache = require('./lib/geoCache');
const photoCache = require('./lib/photoCache');
const thumbnailCache = require('./lib/thumbnailCache');
const { getPrefectureList } = require('./lib/prefectures');
const { getMunicipalityList } = require('./lib/municipalities');

// Test-only escape hatch, mirroring PATHBROWSER_TEST_FILE/PATHBROWSER_TEST_PHOTO_FOLDER:
// isolates the E2E suite's on-disk state (recent-files history, exclusion
// zones, geo/nominatim/photo/thumbnail caches, linked photo folder) from
// whatever the developer's own Electron profile has accumulated, so repeated
// `npm run test:e2e` runs start from a clean slate instead of depending on
// leftover state from a previous run or from real app usage. Must be set
// before app.whenReady() — userData is read at window/IPC-handler creation.
if (process.env.PATHBROWSER_TEST_USERDATA) {
  app.setPath('userData', process.env.PATHBROWSER_TEST_USERDATA);
}

let mainWindow;
// Mirrors the renderer's privacy-mode toggle (renderer/app.mjs setPrivacy ->
// app:set-privacy-mode). The renderer already never asks for a detail name
// while privacy mode is on, but this is the one code path that sends
// coordinates off the machine, so it's gated here too rather than trusting
// the renderer alone. Defaults to ON, same as the renderer's own default.
let privacyModeEnabled = true;
let prefectureGeoJSONCache = null;

// UI language (issue #22): 'ja' or 'en'. An explicit choice from the
// settings screen is persisted in userData/settings.json; until then it
// follows the OS language (Japanese OS -> 'ja', anything else -> 'en').
// PATHBROWSER_TEST_LANG pins it for E2E runs, so the suite doesn't depend on
// the machine's locale.
const SUPPORTED_LANGUAGES = ['ja', 'en'];
let currentLanguage = 'ja';

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function resolveLanguage() {
  const forced = process.env.PATHBROWSER_TEST_LANG;
  if (SUPPORTED_LANGUAGES.includes(forced)) return forced;
  const saved = readSettings().language;
  if (SUPPORTED_LANGUAGES.includes(saved)) return saved;
  return app.getLocale().toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

// Picks the main-process string (native dialogs) for the current language.
function tr(ja, en) {
  return currentLanguage === 'en' ? en : ja;
}
let municipalityGeoJSONCache = null;

// A launch right after installing/updating (see build/installer.nsh) should
// not steal focus: the user may well be working in another app while the
// installer finishes. The marker is consumed on first read so only that one
// launch is affected, and ignored if stale (the "run ViU" box was unchecked
// and the user starts ViU themselves much later — that launch should behave
// normally). PATHBROWSER_TEST_QUIET_LAUNCH exercises the same path in E2E,
// where there's no installer.
const QUIET_LAUNCH_MARKER_MAX_AGE_MS = 10 * 60 * 1000;

function consumeQuietLaunchMarker() {
  if (process.argv.includes('--updated') || process.env.PATHBROWSER_TEST_QUIET_LAUNCH) return true;
  const marker = path.join(path.dirname(process.execPath), 'installed-launch.marker');
  try {
    const { mtimeMs } = fs.statSync(marker);
    fs.unlinkSync(marker);
    return Date.now() - mtimeMs < QUIET_LAUNCH_MARKER_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function createWindow() {
  const quietLaunch = consumeQuietLaunchMarker();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    // macOS takes the icon from the app bundle (build.mac.icon) and ignores this.
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!quietLaunch) {
      mainWindow.show();
      return;
    }
    // Appear only as a minimized taskbar button — never activated, never
    // drawn over the app the user is using — and flash it so it's still
    // noticeable that ViU is ready. Flashing stops once the user opens it.
    // minimize() on a not-yet-shown window maps to SW_SHOWMINNOACTIVE on
    // Windows (no showInactive() first, which would briefly draw the window
    // on top of the user's work).
    mainWindow.minimize();
    mainWindow.flashFrame(true);
    mainWindow.once('focus', () => mainWindow.flashFrame(false));
  });

  // target="_blank" links (issue #15's export-instructions guide links to
  // Google's own timeline/Takeout pages) would otherwise silently do nothing —
  // Electron denies new-window creation by default unless handled. Route
  // http(s) links to the OS default browser instead of opening inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // The app is a single local page — never let the window itself navigate
  // away to a remote URL (e.g. a stray link without target="_blank", or a
  // dropped file/URL), which would put an arbitrary web page in the same
  // window that holds the user's location data.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) {
      event.preventDefault();
      if (url.startsWith('https:') || url.startsWith('http:')) shell.openExternal(url);
    }
  });
}

app.whenReady().then(() => {
  currentLanguage = resolveLanguage();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:get-version', async () => {
  return app.getVersion();
});

ipcMain.handle('app:get-language', async () => currentLanguage);

ipcMain.handle('app:set-language', async (event, language) => {
  if (!SUPPORTED_LANGUAGES.includes(language)) return currentLanguage;
  currentLanguage = language;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), language }, null, 2));
  return currentLanguage;
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

// issue #21 (写真のみモード): lets the renderer populate state.raw.prefectures/
// municipalities without ever parsing a timeline file, so breadcrumb names,
// 市区町村制覇率 denominators, and photo place-name lookups (all of which key
// off these lists — see renderer/app.mjs's buildMunicipalityIndex) keep
// working correctly with zero visit data. Cheap, disk-cached-in-memory reads
// (lib/prefectures.js / lib/municipalities.js), no worker thread needed.
ipcMain.handle('timeline:get-reference-lists', async () => {
  return { prefectures: getPrefectureList(), municipalities: getMunicipalityList() };
});

ipcMain.handle('timeline:choose-file', async () => {
  // Test-only escape hatch: native file dialogs can't be driven by UI automation,
  // so E2E scripts set this env var to skip the dialog entirely.
  if (process.env.PATHBROWSER_TEST_FILE) return process.env.PATHBROWSER_TEST_FILE;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: tr('Googleタイムラインのエクスポートファイルを選択', 'Select a Google Timeline export file'),
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
    // A non-zero exit without a prior 'done'/'error' message means the worker
    // crashed; reject so the renderer shows an error instead of waiting
    // forever on the progress screen. (A no-op if already settled.)
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`parse worker exited with code ${code}`));
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

ipcMain.handle('app:set-privacy-mode', async (event, enabled) => {
  privacyModeEnabled = enabled !== false;
});

ipcMain.handle('timeline:reverse-geocode', async (event, { placeId, lat, lng }) => {
  if (privacyModeEnabled) return { label: null, error: 'privacy-mode', fromCache: false };
  return nominatim.reverseGeocode(app.getPath('userData'), { placeId, lat, lng });
});

// Clears the on-disk performance caches (municipality/clustering results,
// Nominatim reverse-geocode labels, scanned photo metadata, generated
// thumbnails). Does NOT touch recent-files history, backups, exclusion
// zones, or the linked photo folder itself — those are user data/settings,
// not caches, and this button is scoped to "make ViU recompute from
// scratch" only.
ipcMain.handle('cache:clear', async () => {
  const userDataPath = app.getPath('userData');
  const geoCount = geoCache.clearCache(userDataPath);
  const nominatimCount = nominatim.clearCache(userDataPath);
  const photoCount = photoCache.clearEntries(userDataPath);
  const thumbnailCount = thumbnailCache.clearCache(userDataPath);
  return { geoCount, nominatimCount, photoCount, thumbnailCount };
});

// "すべてのデータを削除": unlike cache:clear above, this wipes everything ViU
// has ever written under userData — including the recent-files history and
// its timeline-backups/ (full copies of imported location-history exports),
// exclusion zones, and the linked photo folder — plus Chromium's own
// HTTP cache/storage for this app (map tiles reveal which areas were
// viewed). Confirmed with a native dialog here in the main process rather
// than a renderer confirm(), so the destructive step can't be triggered by
// a single stray IPC call without the user seeing the prompt.
const USER_DATA_ENTRIES = [
  'geo-cache',
  'nominatim-cache.json',
  'overpass-cache.json',
  'photo-cache.json',
  'thumbnail-cache',
  'recent-files.json',
  'timeline-backups',
  'exclusion-zones.json',
  'settings.json',
];

ipcMain.handle('data:delete-all', async () => {
  // Test-only escape hatch, mirroring PATHBROWSER_TEST_EXPORT_PATH: native
  // message boxes can't be driven by UI automation.
  const { response } = process.env.PATHBROWSER_TEST_CONFIRM_DELETE_ALL
    ? { response: 0 }
    : await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: [tr('すべて削除する', 'Delete everything'), tr('キャンセル', 'Cancel')],
        defaultId: 1,
        cancelId: 1,
        title: tr('すべてのデータを削除', 'Delete all data'),
        message: tr('ViUが保存したデータをすべて削除しますか？', 'Delete all data saved by ViU?'),
        detail: tr(
          '最近使ったファイルの履歴とアプリ内バックアップ（タイムラインのコピー）、除外ゾーン、写真フォルダの連携設定、各種キャッシュが削除されます。元のタイムラインファイルや写真そのものは削除されません。この操作は取り消せません。',
          'This deletes the recent-files history and in-app backups (copies of your timeline), exclusion zones, the linked photo folder setting, and all caches. Your original timeline file and photos are not deleted. This cannot be undone.'
        ),
      });
  if (response !== 0) return { deleted: false };

  const userDataPath = app.getPath('userData');
  // Drop the in-memory copies too, so nothing deleted from disk can be
  // re-persisted from memory afterwards.
  nominatim.clearCache(userDataPath);
  for (const name of USER_DATA_ENTRIES) {
    try {
      fs.rmSync(path.join(userDataPath, name), { recursive: true, force: true });
    } catch (err) {
      console.error('delete-all: failed to remove', name, err && err.code);
    }
  }
  await session.defaultSession.clearCache();
  await session.defaultSession.clearStorageData();
  return { deleted: true };
});

ipcMain.handle('photos:choose-folder', async () => {
  if (process.env.PATHBROWSER_TEST_PHOTO_FOLDER) return process.env.PATHBROWSER_TEST_PHOTO_FOLDER;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: tr('写真フォルダを選択', 'Select a photo folder'),
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('photos:get-linked-folder', async () => {
  return photoCache.getLinkedFolder(app.getPath('userData'));
});

ipcMain.handle('photos:scan-folder', async (event, folder) => {
  const userDataPath = app.getPath('userData');
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'worker', 'photoScanWorker.js'), {
      workerData: { folder, userDataPath },
    });

    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        event.sender.send('photos:scan-progress', msg);
      } else if (msg.type === 'done') {
        resolve(msg.result);
      } else if (msg.type === 'error') {
        reject(new Error(msg.message));
      }
    });

    worker.on('error', (err) => reject(err));
  });
});

// Returns a base64 data: URL for on-demand display in a popup/lightbox
// (fits the existing CSP's `img-src ... data:` allowance without needing a
// custom protocol handler).
//
// Resized via Electron's built-in `nativeImage` (no extra native dependency,
// so packaging/electron-builder is unaffected) rather than sending the
// original file's full bytes — a modern phone photo is easily 5-15MB, and
// with libraries in the hundreds-of-GB / tens-of-thousands-of-photos range,
// shipping the untouched original over IPC for every popup/lightbox open
// noticeably degrades responsiveness for no visual benefit (the popup thumb
// and lightbox are both far smaller than a native photo's resolution
// anyway). THUMBNAIL_MAX_DIMENSION is sized for the lightbox (the larger of
// the two consumers — see photoView.mjs, which reuses this same result for
// both), not just the small popup preview.
//
// HEIC can't go through nativeImage (Chromium has no HEVC decoder) — it's
// decoded to raw pixels by worker/thumbnailWorker.js (libheif wasm) and only
// the resize/JPEG-encode happens here. That decode costs ~1s of CPU per
// photo, which is what makes the disk cache below matter most.
const THUMBNAIL_MAX_DIMENSION = 1600;
const THUMBNAIL_JPEG_QUALITY = 78;
// Baked into each cache entry's key, so changing the constants above (or
// bumping the version on any other generation-output change) makes old
// cached thumbnails miss instead of being served stale.
const THUMBNAIL_CACHE_PARAMS = `v1|${THUMBNAIL_MAX_DIMENSION}|${THUMBNAIL_JPEG_QUALITY}`;

// Lazily-spawned persistent HEIC decode worker (see worker/thumbnailWorker.js
// for why it's a worker and why it's long-lived). Replies are matched back to
// callers by id since several decodes can be requested at once (gallery).
let thumbWorker = null;
let thumbWorkerSeq = 0;
const thumbWorkerPending = new Map();

function decodeHeicInWorker(filePath) {
  if (!thumbWorker) {
    thumbWorker = new Worker(path.join(__dirname, 'worker', 'thumbnailWorker.js'));
    thumbWorker.on('message', (msg) => {
      const pending = thumbWorkerPending.get(msg.id);
      if (!pending) return;
      thumbWorkerPending.delete(msg.id);
      if (msg.ok) pending.resolve(msg);
      else pending.reject(new Error(msg.message));
    });
    // Worker died (OOM on a pathological file, etc.) — fail everything in
    // flight and let the next request spawn a fresh worker.
    thumbWorker.on('error', (err) => {
      for (const pending of thumbWorkerPending.values()) pending.reject(err);
      thumbWorkerPending.clear();
      thumbWorker = null;
    });
  }
  const id = ++thumbWorkerSeq;
  return new Promise((resolve, reject) => {
    thumbWorkerPending.set(id, { resolve, reject });
    thumbWorker.postMessage({ id, filePath });
  });
}

ipcMain.handle('photos:get-thumbnail', async (event, filePath) => {
  const userDataPath = app.getPath('userData');
  const cached = thumbnailCache.read(userDataPath, filePath, THUMBNAIL_CACHE_PARAMS);
  if (cached) return { dataUrl: `data:image/jpeg;base64,${cached.toString('base64')}` };

  const ext = path.extname(filePath).toLowerCase();
  try {
    let img;
    if (ext === '.heic') {
      const { width, height, pixels } = await decodeHeicInWorker(filePath);
      img = nativeImage.createFromBitmap(Buffer.from(pixels), { width, height });
    } else {
      img = nativeImage.createFromPath(filePath);
    }
    if (img.isEmpty()) return { unsupported: true };
    const { width, height } = img.getSize();
    const longSide = Math.max(width, height);
    if (longSide > THUMBNAIL_MAX_DIMENSION) {
      const scale = THUMBNAIL_MAX_DIMENSION / longSide;
      img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
    }
    const buf = img.toJPEG(THUMBNAIL_JPEG_QUALITY);
    thumbnailCache.write(userDataPath, filePath, THUMBNAIL_CACHE_PARAMS, buf);
    return { dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` };
  } catch {
    return { unsupported: true };
  }
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
    title: tr('制覇マップをPNGで保存', 'Save the coverage map as PNG'),
    defaultPath: 'viu-map.png',
    filters: [{ name: tr('PNG画像', 'PNG image'), extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, image.toPNG());
  return result.filePath;
});
