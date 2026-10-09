[日本語](README.md) | **English**

# ViU

A desktop app (built with Electron) that loads your Google Maps location Timeline (exported JSON) and gives you an overview of **a coverage map of the prefectures and municipalities you have visited**, **travel stats** and **stay history**.

Whereas Google Maps' own Timeline is built for "looking back one day at a time", this app specializes in **getting an overview of, and visualizing, your cumulative data**.

## Download

No Node.js knowledge is required. Download the latest `ViU Setup <version>.exe` from the [Releases](../../releases) page and run it. The installer creates shortcuts on the desktop and in the Start menu.

Because the executable is unsigned, Windows SmartScreen may show a warning ("Windows protected your PC") on first launch. Click "More info" → "Run anyway" to start it. Administrator rights are not required (the app is installed into a per-user folder). The launch right after an install (or update) finishes starts minimized and flashes its taskbar button, so it does not steal focus from whatever other app you are working in.

## Quick start (for developers)

To run directly from source, you need Node.js (a version that can run Electron 43.x).

```bash
npm install
npm run setup   # install scripts are allow-listed, so this runs only the approved ones (needed only the first time and after dependency updates)
npm start
```

On launch, a dialog asks you to select a location Timeline JSON file. Select the file you exported yourself (see below for how to export it).

The first load may take a few seconds to compute municipality judging and clustering, but the results are cached as files in the OS-standard app data folder, so they are not recomputed the next time you open the same file (when you change the clustering threshold, each threshold you have used once is cached as well). Exclusion zone settings are also saved in the OS-standard app data folder and carry over no matter which file you open.

### Exporting your Timeline data

1. Export your data from the Google Maps app on your smartphone, or from the settings of [Google Timeline](https://www.google.com/maps/timeline) (Google account settings > Location History > Export Timeline data).
2. The downloaded JSON file (it can be tens of MB) can be opened in this app as is. No prior conversion or splitting is needed.

### If you don't have Timeline data (Photos-only mode)

Even if it is hard to prepare a Google Timeline export, you can just link a folder of geotagged photos to plot and browse where they were taken on the map. Start it from "View photos only, without a timeline" on the start screen. Prefecture/municipality coverage coloring is not shown (since there is no visit data), but the photo features — prefecture/municipality boundaries, photo cluster display, gallery, lightbox, exclusion zones, etc. — all work as usual. The Route Map, Travel Stats, Chronology and timelapse playback tabs are hidden because they have no meaningful data. If you later load a real Timeline file via "Open file" in the header, the app switches straight to normal mode.

### Preparing photo data (optional, for the photo integration feature)

The photo integration feature can read photos with Exif GPS tags, or a Google Photos export from [Google Takeout](https://takeout.google.com/). If you export only "Google Photos" in Takeout, the photos and their geotagged JSON files (e.g. `写真名.jpg.supplemental-metadata.json`) are output in pairs under `Takeout/Google フォト/`; select that folder from "Photo integration" in Settings. (This is personal data containing real location information, so please handle it with care. All processing is local and nothing is sent externally. In addition to JPEG/PNG, thumbnail previews also support HEIC from iPhones and similar devices.)

### Privacy

All analysis, judging and clustering is done locally; your location data (the Timeline file itself) is never sent externally. The app communicates externally in only these two ways:

- **Fetching map tile images** (OpenStreetMap): fetches map images for the area being displayed. The tile server can infer which area you displayed.
- **Fetching detailed place names** (only when Privacy mode is OFF): when you open a stay point's detail panel or ranking, only one representative coordinate of that point is sent to Nominatim (OpenStreetMap's reverse geocoding API) to get the street/facility name. Only when the Nominatim result is uncertain (e.g. just a tenant name), the same coordinate is also queried against the Overpass API (OpenStreetMap) to get the name of the building/commercial facility containing the point or the nearest station. When Privacy mode is ON, this sending is blocked not only in the UI but also in the main process.

**About stored data**: caches, recent-file history, in-app backups (copies of loaded Timelines), exclusion zones and so on are stored only in this PC's app data folder (`%APPDATA%\ViU` on Windows) and are never sent externally. "Delete all data" in Settings (or in the "Recent files" section of the start screen) deletes everything ViU has stored in one go (your original Timeline files and photos are not deleted). We recommend using it before giving away your PC or uninstalling.

The app has a privacy feature that lets you register your home and workplace as "exclusion zones" (see "Features" below for details). After the first data load, you are guided to the exclusion zone settings screen before you start browsing. If you are screen-sharing or recording, take care that location information does not show up on screen.

## Features

- **Language**: The app UI is available in Japanese and English. On first launch it follows the OS language, and you can switch it in Settings. Municipality names stay in Japanese, while prefecture names are shown in English.
- **Coverage Map (制覇マップ)**: Draws prefecture boundaries (or municipality boundaries; granularity is switchable) on a map of Japan and shades visited areas by number of visits. Clicking a prefecture shows its stay count, first/last visit dates, total/average stay time, municipality coverage rate and a list of stay points per municipality. When you click a prefecture, the zoom fits **the largest polygon (the mainland part)** rather than a bounding box that includes remote islands such as the Tama area or the Izu Islands, and if you have visited points on remote islands, jump links appear in the detail panel.
- **Granularity switch**: The Coverage Map switches between "Prefecture / Municipality" with one click. Municipality mode draws about 1,900 municipalities nationwide, but keeps performance up by drawing only those within the visible area. Municipalities you only **passed through** by train, car, etc. without a recorded stay are colored separately from visited ones as "passed through only" (light teal), with a separate count (they are not included in the municipality coverage rate).
- **Color scheme**: The fill (shading by number of visits) is a single-hue blue gradient (unvisited is light gray), while stay-point pins are orange with a white outline; the clearly separated hues keep pins from getting lost in the background. The selected prefecture is indicated by an emphasized border (orange, thick line) rather than a change in fill color, and the fill opacity is lowered automatically whenever pins or routes come to the foreground.
- **Place names**: Stay points are shown by municipality name (e.g. 「京都市左京区」) rather than coordinates. When Privacy mode is OFF, the stay-point ranking in a prefecture's detail panel also shows Nominatim (OpenStreetMap) detailed place names (facility/building/street names) in the form "count — detailed name (municipality name)". Names are fetched sequentially, prioritizing visible rows, at no more than one per second (off-screen rows are not fetched until scrolled into view); once fetched, a name is cached per cluster and also reflected in the tooltip of the pin on the map. The coordinate passed to reverse geocoding is the placeId that appears most often within the cluster (or the most frequent coordinate if there is none), which reduces wrong place names caused by GPS jitter.
- **Clustering of nearby points**: Duplicate records of the same place caused by GPS jitter are merged into a single stay point using distance-based clustering. The threshold (20–200 m, default 50 m) can be adjusted with the slider in the header.
- **Exclusion zones** (always applied, regardless of whether Privacy mode is ON or OFF): Draw circles on the map in Settings to register areas that should be treated "as if they never happened". In addition to the points Google's Timeline export estimated as your home/workplace, the app individually suggests up to the top 10 most-visited points as candidates (Google's own HOME/WORK labels are usually assigned only once each, so other places that might be a home, workplace or frequent spot are suggested too). Data inside exclusion zones is excluded from rankings, map pins, routes (trimmed at the boundary) and visit lists. In the timeline of the per-day route view, moves that start from or arrive at a zone show only their part outside the zone (the time is taken from the first recorded point after leaving the zone and marked with "~", and the distance covers only the part outside the zone), and moves with no records outside the zone are not shown. However, prefecture/municipality visit judging and aggregate values such as total distance are not affected. The zone locations themselves are not shown anywhere except Settings.
- **Route Map (経路マップ)**: Draws travel routes as polylines on Leaflet, colored by mode of transport (walking/running/cycling = greens, train/subway/tram = reds, bus/taxi = blues, car = amber, plane = purple, ferry = teal, ropeway = magenta; the palette was validated with color-vision-deficiency simulation and contrast ratios). Clicking a mode of transport in the legend toggles that mode's visibility. Moves without detailed GPS records are drawn as a dotted line (estimated segment) connecting start and end points. It follows the period filter and can also show the whole period. The background map is slightly faded so routes are easier to see. Routes entering an exclusion zone are trimmed at the zone boundary.
- **Photo integration** (optional): Link a folder of geotagged photos in Settings to overlay where they were taken as pins on both the Coverage Map and the Route Map (nearby pins are clustered; click for a thumbnail preview, click again to enlarge. The enlarged view can also be closed by clicking anywhere outside the image). Location is taken from Exif GPS tags first, and otherwise from the JSON sidecars included in a Google Photos Takeout export (see "Preparing photo data" above for how to get them). Capture date/time follows the period filter, and location follows exclusion zones and Privacy mode (when Privacy mode is ON, the photo layer itself is disabled). All reading is done locally with nothing sent externally. A stay point's detail panel also shows a thumbnail list of photos taken at that point (within the cluster distance threshold) during the period (Stage 4, issue #2); click one to enlarge it in the same lightbox.
- **Estimating where a photo was taken (photos without location)**: For photos with no location in either Exif or Takeout, the capture location is estimated by matching the capture time against the Timeline's travel history (stay and move records). If the capture time falls within a stay, that stay's point is used; otherwise the point of the nearest move record within 2 hours before or after is used. If there is still no nearby record, no estimate is made and the photo stays hidden. Estimated points are shown as semi-transparent pins with a dashed outline, and their popup carries the note "Location: estimated (time difference from record: about n min/hours)", so they are not confused with measured data (Exif/Takeout).
- **Chronology (年表, first-visit chronicle)**: Lists the first-visit dates of prefectures (default) or municipalities in chronological order. Clicking an item jumps to that area on the Coverage Map.
- **Travel Stats (移動統計)**: Shows total distance traveled; distance, count, total time and average speed per mode of transport; a monthly distance chart stacked by mode; a longest-trips ranking (with start/end municipality names); a municipality coverage rate ranking (click to jump to that prefecture's municipality map); a frequent-places ranking (switchable between by count / by total stay time); and behavior-pattern stats such as average distance by day of week, number of moves by time of day, and the top 5 days with the most travel.
- **Timelapse playback**: Press the play button on the Coverage Map and the period filter advances automatically month by month from the first to the last month of your data, animating the map as it fills in (works at both prefecture and municipality granularity). When played on the Japan map view, stay points visited up to that month are also drawn as dots nationwide. Pause and reset are available.
- **PNG export**: Saves the currently displayed Coverage Map (reflecting the granularity, period filter, Privacy mode and exclusion zones exactly as they are) as a PNG image by capturing the screen as shown. The OSM attribution of the map tiles is automatically included in the image.
- **Period filter**: Filtering by year and month recomputes the map and stats from that period's data. When you specify a year, the "prefectures visited for the first time that year" are also shown.
- **Drill-down navigation**: Move from the Japan map → prefecture → stay point using the breadcrumb and back/forward buttons. While a stay point is selected you can switch to another stay point by clicking it on the map, and clicking anywhere other than a point's pin returns to the prefecture view while keeping the map's position and zoom. Changing the year/month, cluster distance or Privacy mode recomputes everything and returns to the Japan map.
- **Per-day route view**: Clicking a date in the "Days stayed" list of a stay point's detail panel shows that day's travel route and stay points on a map, along with a chronological timeline (times of stays and moves, mode of transport, distance, stay duration). Stay points are numbered in visit order; hovering over or focusing a timeline row highlights the corresponding spot on the map, and clicking moves to that spot. Use the "‹ ›" buttons or the ←→ keys to go to the previous/next recorded day. If a photo folder is linked, photos taken that day are also shown as pins on the map and as a thumbnail list below the timeline (toggle with the camera button in the header), and can be clicked to enlarge. Route lines have a white outline so they don't get lost in the map, and so as not to rely on color alone, walking is drawn as a dotted line, rail modes with a white dashed center line, and estimated segments as long dashes. Keyboard operation (Tab to move, Esc to close) and screen readers are also supported.
- **Privacy mode (プライバシーモード)** (ON by default):
  - Limits the map zoom level to the point where municipalities can be distinguished (cannot zoom in to street address/building level)
  - Stay-point pins are rounded to the municipality's representative point (detailed names and coordinates are hidden)
  - All data within 1 km of home (HOME) and workplace (WORK) is excluded from every view and stat
  - The frequent-places ranking is rounded to municipality level
  - The Route Map itself is disabled (since it is the feature that exposes your daily-life area the most)
- **Photos-only mode** (issue #21, for people without a Timeline): Without opening a Timeline file, you can start using the app just by linking a photo folder via "View photos only, without a timeline" on the start screen. Prefecture/municipality boundaries, photo cluster display, gallery, lightbox and exclusion zones work as usual, but since there is no visit data the Coverage Map is not shaded (the whole country is shown in gray), and the Route Map, Travel Stats, Chronology and timelapse playback tabs are hidden. Loading a real Timeline file via "Open file" in the header switches to normal mode.

## Boundary data

### Prefecture boundaries

`data/prefectures.geojson` was taken from [dataofjapan/land](https://github.com/dataofjapan/land) (`japan.geojson`, per-prefecture polygons, open data equivalent to public domain), keeping only the properties the app uses (prefecture code and name) to reduce file size.

```
https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson
```

### Municipality boundaries

`data/municipalities.geojson` was taken from [smartnews-smri/japan-topography](https://github.com/smartnews-smri/japan-topography) (source data: MLIT National Land Numerical Information "Administrative Areas", 1% simplification, 1,902 municipalities and wards nationwide, about 100 vertices per municipality on average), with its properties thinned out in the same way. Wards of designated cities are divided individually, so ward-level place names such as 「京都市左京区」 can be shown.

```
https://raw.githubusercontent.com/smartnews-smri/japan-topography/main/data/municipality/geojson/s0001/N03-21_210101.json
```

The previously bundled 0.1% simplification had only 17.6 vertices per municipality on average and its boundaries were coarse, so it has been replaced with the 1% simplification from the same provider with the same attribution (`s0010`, 47 files, one per prefecture, with properties under National Land Numerical Information's raw column names N03_001/N03_003/N03_004/N03_007). `scripts/fetch-municipality-boundaries.js` (`npm run fetch:boundaries`) fetches the 47 files, converts the column names and merges exclaves into MultiPolygons in one go (run it only when regeneration is needed). It is bundled as a script rather than as the data itself because bulk-fetching 47 files tends to be unreliable depending on the environment, and it is safer to apply the results while checking them each time.

### How prefectures and municipalities are judged

Prefecture boundaries and municipality boundaries come from different datasets, so judging them separately sometimes produced disagreements near prefectural borders (e.g. Osaka according to the prefecture polygon, but Kinokawa City, Wakayama according to the municipality polygon). The app now **judges the municipality first and derives the prefecture from the municipality code**, so the two never disagree (`lib/locate.js`). Points such as ports, reclaimed land and airports that fall outside the simplified coastline are assigned to the nearest municipality within 3 km. Only if that still fails is the prefecture polygon used.

## Tech stack

- Electron (main process: Node.js / renderer: plain HTML, CSS and JS, no UI framework)
- Map rendering: [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles
- Prefecture/municipality judging: `@turf/boolean-point-in-polygon` (main/Worker side), plus a simple point-in-polygon check for exclusion zones and HOME/WORK suggestions (renderer side, `mapView.mjs`)
- Coverage Map PNG export: Electron's `webContents.capturePage()` captures the screen as displayed (no extra library. Because it captures exactly what is shown, Privacy mode or exclusion zone contents can never leak only at export time)
- Detailed place names (street/facility names): on-demand queries to [Nominatim](https://nominatim.org/) (OpenStreetMap's reverse geocoding API), only when Privacy mode is OFF and a detail panel is opened. Only when the result is uncertain, building/commercial facility names and nearest station names are supplemented with the [Overpass API](https://overpass-api.de/)
- Photo integration: [exifr](https://github.com/MikeKovarik/exifr) for reading Exif, and [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) for pin clustering (bundled, MIT license, `renderer/vendor/leaflet.markercluster/`). Recursive folder scanning and metadata extraction run in a Worker Thread of the main process (`worker/photoScanWorker.js`), so they don't block the UI

### Data flow and memory handling

Timeline JSON can exceed 50 MB, so the app is designed as follows.

- File loading, JSON parsing, prefecture/municipality judging and clustering run in a **Worker Thread of the main process** (`worker/parseWorker.js`), so they don't block the UI. Progress is shown during parsing (loading / parsing JSON / normalizing / judging municipalities / clustering).
- `rawSignals` (raw data not needed for analysis) is discarded at load time, and only lightweight normalized data (arrays of stays, moves and path points) is passed to the renderer process.
- Municipality judging and clustering results are saved as JSON under the OS-standard user data folder (`geo-cache/`), keyed by a fingerprint made from the input file's path, size and modification time (`lib/geoCache.js`). From the second launch with the same file onward, recomputation is skipped if this cache exists.
- Nominatim reverse geocoding results are cached in the same folder too, and the same point is never queried again. Requests are sent serially at least 1 second apart, with a User-Agent set in line with Nominatim's usage policy.
- Exclusion zones are applied separately from prefecture/municipality "visited" judging and from total distance and per-mode/per-month aggregates, as an additional filtering stage on the data used for rankings, map pins, routes and visit lists (`applyExclusionZones`).
- The renderer runs in a secure configuration with `contextIsolation` enabled and `nodeIntegration` disabled, and communicates with the main process only through the minimal API exposed by `preload.js` (`window.pathBrowser`).

## Project structure

```
main.js                     Electron main process (window creation, IPC)
preload.js                  Exposes a safe API to the renderer via contextBridge
worker/parseWorker.js        Timeline JSON parsing/normalization, prefecture/municipality judging,
                             default clustering, assigning modes to route segments
worker/clusterWorker.js      Recomputation when the clustering threshold changes
lib/prefectures.js           Prefecture GeoJSON loading, point-in-polygon judging
lib/municipalities.js        Municipality GeoJSON loading, point-in-polygon judging, representative points
lib/cluster.js               Distance-based clustering (Union-Find)
lib/geoCache.js               Disk cache of municipality judging and clustering results
lib/nominatim.js              Nominatim reverse geocoding (rate limiting, caching)
lib/exclusionZones.js         Exclusion zone persistence (user data folder)
lib/coords.js                 Utilities for coordinate string parsing and distance calculation
lib/locate.js                 Unified point → municipality/prefecture judging (nearest municipality outside the coastline)
lib/photoCache.js             Disk cache of photo scan results, persistence of the linked folder
lib/thumbnailCache.js         Disk cache of generated thumbnails
worker/photoScanWorker.js     Recursive photo folder scan, Exif/Takeout metadata extraction
worker/thumbnailWorker.js     HEIC image decoding (libheif wasm)
data/prefectures.geojson      Prefecture boundary data (bundled)
data/municipalities.geojson   Municipality boundary data (bundled)
renderer/mapView.mjs          Coverage Map rendering (prefecture/municipality, granularity switch, remote islands)
renderer/routeView.mjs        Route Map rendering
renderer/photoView.mjs        Photo layer rendering (shared by Coverage Map and Route Map, clustering)
renderer/settingsView.mjs     Exclusion zone settings screen rendering
renderer/chronologyView.mjs   Chronology view rendering
renderer/statsView.mjs        Travel Stats view rendering
renderer/aggregate.mjs        Aggregation, filtering and clustering post-processing logic (DOM-independent)
renderer/context.mjs          Shared state (state, DOM refs, map instances, etc.)
renderer/app.mjs              Orchestrates derived aggregates, rendering, screen transitions and event wiring
renderer/loading.mjs          Recent files, file loading, re-clustering
renderer/photos.mjs           Photo layer, photo scanning, lightbox
renderer/labels.mjs           Sequential fetch queue for detailed place names
renderer/mapTab.mjs           Coverage Map tab (detail panel, breadcrumb)
renderer/routeTab.mjs         Route Map tab, per-day route view
renderer/timelapse.mjs        Timelapse playback
renderer/settings.mjs         Settings screen (exclusion zones, cache/data deletion)
renderer/testHooks.mjs        Hooks for E2E tests
renderer/i18n.mjs             UI language (Japanese/English) switching and translation helpers
```

## Building the distribution package

`electron-builder` can create Windows distributables (NSIS installer and portable exe).

```bash
npm install
npm run setup   # runs the allow-listed install scripts needed for building, such as electron-winstaller
npm run dist
```

`ViU Setup <version>.exe` (an NSIS installer that also creates desktop/Start menu shortcuts) is generated in the `dist/` folder. Because the code is not signed, SmartScreen shows a warning on first launch on the target PC. Obtaining a code signing certificate would remove this warning, but it is not essential for personal use or small-scale distribution.

## Verification

The following has been verified using the developer's own real Timeline data (real data including tens of thousands of segments).

- Loading → normalization → municipality judging → clustering (a few seconds the first time, even faster with the cache), and visit judging across multiple prefectures
- When clicking a prefecture that has remote islands, verified directly from the boundary data that the view fits the mainland polygon correctly (confirmed that the mainland bbox does not include the islands' coordinates)
- Granularity switch: confirmed that municipality mode draws all 1,902 municipalities nationwide and redraws without errors after panning the map
- Municipality coverage rate ranking (per prefecture, all 47) and jumping to the municipality map by clicking
- Chronology view (switching between prefectures only / including municipalities, map navigation by clicking)
- Stay-time aggregation (confirmed that switching the frequent-places ranking between by count / by stay time changes the order)
- Adding/removing exclusion zones: confirmed that the top-ranked entry changes after adding one, that the hidden-count display appears, and that the visited prefecture count is unchanged before and after adding a zone
- Timelapse playback (confirmed that the filter advances automatically month by month and the map and counts update)
- PNG export (confirmed that a file is actually written)
- Fetching Nominatim detailed place names in the stay-point detail panel (confirmed that the API query actually succeeds and a place name is returned)
- Ranking recomputation when changing the clustering threshold slider
- Route Map: confirmed that polylines colored by mode are drawn for both the whole period and a specified year, and that clicking the legend toggles each mode's visibility
- Travel Stats (total distance, per-mode breakdown/duration/average speed, monthly stacked chart, longest-trips ranking, behavior patterns by day of week / time of day / top 5 days)
- Recomputation by year filter and display of "prefectures visited for the first time that year"
- Back/forward navigation of the drill-down history (including cluster-level stay points)
- Privacy mode ON/OFF toggling of the zoom limit, rounding pins to municipalities, disabling the Route Map, excluding the home/workplace surroundings, and rolling up rankings by municipality
- Color scheme: verified fill-opacity/border colors at the SVG attribute level, confirming that only the selected prefecture gets an orange, thick border and that fill opacity drops while pins are shown. Also confirmed that pins are drawn in orange (#ff7f0e) with a white outline
- Ranking display of detailed place names: confirmed that right after opening the panel, only the visible rows change from "municipality name (loading…)" to "detailed name (municipality name)" once fetched; that rows newly scrolled into view are added to the queue; and that leaving the panel discards unprocessed items while the fetched cache remains and is shown immediately on revisit (cache count and queue length verified directly)
- Photo integration: with a real Google Photos Takeout export, confirmed the whole flow of folder linking, scanning (getting locations from both Exif and Takeout sidecars), pin display on the Coverage Map/Route Map, clustering, thumbnail popups and lightbox display
- Scanning a photo folder with a large number of files: confirmed the progress display transitioning from the enumeration phase (progress switches to a file count) to the scanning phase, and incremental updates of the photo layer (unrelated navigation does not rebuild all pins and cause flicker; an open popup is kept)
- Photo cluster gallery: confirmed that clicking a cluster at maximum zoom opens a popup with a thumbnail grid (4 columns, about 400 px wide) and that clicking each thumbnail opens the lightbox; clicking a cluster below maximum zoom zooms in
- HEIC photos: confirmed that GPS and capture date/time of HEIC files are obtained by scanning, that thumbnails appear in popups/galleries (after a short wait the first time), and that colors are correct (no BGRA/RGBA mix-up)
- Thumbnail cache: confirmed that reopening the popup of the same photo shows it instantly (JPEGs are generated in `userData/thumbnail-cache/`), and that clearing the cache in Settings reports and deletes the thumbnail count
- Estimating where a photo was taken (Stage 3): confirmed that a photo without location taken during a Timeline stay is placed at that stay point, and one taken while moving (when a record within 2 hours is nearby) is placed at the nearest move record's point; that estimated pins are visually distinguishable from measured pins with a dashed outline and semi-transparency; that the popup shows that it is an estimate and the time difference; and that photos with no corresponding record within 2 hours stay hidden (as before)
- Integrated photo × Timeline view (Stage 4, issue #2): confirmed that the stay-point detail panel shows photos within the cluster distance threshold and the period as a thumbnail grid (same look as the photo cluster gallery), that clicking a thumbnail opens the existing lightbox, that moving to another stay point aborts unfinished thumbnail fetches, and that the section itself is not shown for places with zero photos
- Photos-only mode (issue #21): confirmed that both buttons on the start screen are shown; that "View photos only, without a timeline" reaches the map screen via photo folder linking and exclusion zone setup (no suggestions are shown); that the Route Map, Chronology and Travel Stats tabs, the cluster distance slider and the timelapse controls are hidden; that the nationwide map is shown entirely in gray yet remains clickable, with correct breadcrumbs and municipality coverage rate denominators (a regression check that the prefecture/municipality reference lists are real data, not empty); that the photo layer is ON by default and place names in photo popups resolve correctly; that the year/month filter reflects the years photos were taken; and that loading a real Timeline via "Open file" in the header brings back the hidden tabs and returns to normal mode

## License

[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). You are free to use, modify and redistribute it for noncommercial purposes, but commercial use is not permitted. See [LICENSE](LICENSE) for details.

---

*This app was developed by an individual with the help of conversations with AI (so-called vibe coding), and does not assume the same quality assurance or maintenance as commercial software. If you find bugs or have ideas for improvement, reporting them via Issues would be much appreciated.*
