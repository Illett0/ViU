# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # install dependencies
npm start                 # run the app (electron .) — opens a native file-picker dialog on launch
npm run dist               # electron-builder: produces dist/PathBrowser Setup <version>.exe (Windows NSIS, x64 only)
npm run fetch:boundaries   # regenerate data/municipalities.geojson from the 1% simplification (47 files, requires network) — one-off, not run in normal dev
```

No lint or test scripts are configured (no ESLint/Prettier config, no test runner in `package.json`). There is no automated test suite. Verification has historically been manual — see the README's `## 動作確認` section for the list of behaviors that get manually re-checked (map rendering, privacy mode, exclusion zones, clustering, photo linking, stats, etc.) after a change; treat it as the closest thing to a regression checklist when touching related code.

For manual/scripted E2E-style runs, native OS dialogs (file picker, folder picker, save dialog) can't be driven by UI automation, so `main.js` has escape-hatch env vars that bypass them:
- `PATHBROWSER_TEST_FILE` — skips the timeline JSON file picker, returns this path directly
- `PATHBROWSER_TEST_PHOTO_FOLDER` — skips the photo folder picker
- `PATHBROWSER_TEST_EXPORT_PATH` — skips the PNG save dialog, writes here directly

## Architecture

**Three-process Electron split**, communicating only through a narrow IPC surface:

- `main.js` — Node-side process. Owns the BrowserWindow, all `ipcMain.handle('namespace:action', ...)` handlers (namespaces: `timeline:*`, `photos:*`, `cache:*`), and file-system/dialog access.
- `preload.js` — the *only* bridge between them. `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` on the BrowserWindow, so the renderer has zero direct Node access. `contextBridge.exposeInMainWorld('pathBrowser', {...})` exposes a thin one-to-one wrapper per IPC channel (e.g. `getRecentFiles()` → `timeline:get-recent-files`). Adding a new main-process capability means adding the handler in `main.js` *and* a matching wrapper here.
- `renderer/` — vanilla ES modules loaded straight by `index.html`, no bundler, no framework. `app.mjs` is the orchestrator: it owns the single mutable `state` object, wires up DOM element refs and event listeners, and calls into the view/aggregate modules. `state.mjs` is specifically the navigation model (a back/forward history stack — `navigateTo`/`goBack`/`goForward`/`currentView`), not a general store. `renderer/aggregate.mjs` is DOM-independent aggregation/filter/cluster-postprocessing logic imported by `app.mjs` — if it needs to run outside a browser context (e.g. a script), only this file matters.

**Worker threads keep the UI thread unblocked** for anything heavy — spawned from `main.js` via `worker_threads`, not `child_process`:
- `worker/parseWorker.js` — parses+normalizes the timeline JSON (can be 50MB+), does prefecture/municipality point-in-polygon judging, and default clustering. Reports incremental `progress` messages back over IPC.
- `worker/clusterWorker.js` — re-clusters when the user moves the clustering-threshold slider (avoids re-running the full parse).
- `worker/photoScanWorker.js` — recursively scans a linked photo folder and extracts Exif GPS / Google Takeout sidecar JSON metadata.

**`lib/` is shared Node-side logic**, used by both `main.js` and the workers (not by the renderer, which never touches Node APIs directly): `prefectures.js`/`municipalities.js` (GeoJSON loading + point-in-polygon), `cluster.js` (Union-Find distance clustering), `coords.js`, `geoCache.js`, `nominatim.js`, `exclusionZones.js`, `recentFiles.js`, `photoCache.js`.

**Caching/persistence is disk-based under `app.getPath('userData')`, outside the repo** — never `localStorage` (there's no DOM access to it in the main/worker processes anyway). Cache keys are fingerprints derived from file path/size/mtime (timeline parse+cluster results) or from placeId/coordinates (Nominatim reverse-geocode results, rate-limited to ≥1s between requests). `cache:clear` wipes these performance caches only — it explicitly does not touch recent-files history, backups, exclusion zones, or the linked photo folder (see the comment above that handler in `main.js`).

**Privacy/exclusion-zone filtering is a separate layer from aggregation, by design**: prefecture/municipality "visited" status and totals (distance, mode breakdowns, etc.) are computed first from the full dataset; exclusion zones then apply an *additional* filter (`applyExclusionZones` in `aggregate.mjs`) on top, scoped only to what's user-facing (rankings, pins, routes, visit lists) — visited-status/aggregate totals must stay computed pre-exclusion. When editing aggregation logic, preserve this ordering rather than folding zone filtering into the base computation.

**Boundary GeoJSON is pre-generated, not fetched at runtime**: `data/prefectures.geojson` (from dataofjapan/land) and `data/municipalities.geojson` (from smartnews-smri/japan-topography, 0.1% simplification, ~7.8MB) ship in the repo as static files loaded via `timeline:get-*-geojson` IPC handlers with an in-memory cache. `scripts/fetch-municipality-boundaries.js` is the only way to regenerate the municipality file (switches to the 1% simplification for higher fidelity); it's a manual one-off, not part of any build step.

## Handling personal/location data

This repo's `.gitignore` deliberately blocks real user data from ever being committed: `/timeline/`, `*.takeout.json`, `タイムライン*.json`, `geo-cache/`, `nominatim-cache.json`, `exclusion-zones.json`, `recent-files.json`, `timeline-backups/`. Don't work around these or add real personal location/photo exports into the tracked tree — the whole app's privacy model (see README `## プライバシーについて` / `## 主な機能` privacy-mode bullet) is a core design constraint, not an incidental feature, so be conservative about anything that could widen what data is displayed, logged, or persisted outside `userData`.

## Repo context

- GitHub: `Illett0/PathBrowser`. Issues are used to track staged/deferred work (e.g. a feature rolled out in stages); close with `gh issue close <番号>` when the corresponding work lands.
- License: PolyForm Noncommercial 1.0.0 — noncommercial use only.
- README.md is comprehensive and kept current (feature list, data provenance, project layout, manual verification checklist) — check it before assuming something is undocumented.
