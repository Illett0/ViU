'use strict';

// E2E regression suite for the three click-handling bugs fixed in commit
// aaa21b9 (issue #13's second comment) plus issues #23 and #24 — see the
// commit message and renderer/app.mjs's wireBackLink/renderMapTab, and
// renderer/mapView.mjs's renderClusterMarkers/initMap, and
// renderer/photoView.mjs's clusterclick handler for the production code
// these assertions exercise.
//
// Drives the real Electron app via Playwright's plain `playwright` package
// (`_electron`), not `@playwright/test` — no extra browser download, and it
// launches the actual `main.js` binary. There's no test framework installed
// (see CLAUDE.md), so this is a plain Node script: assert + a manual step
// runner, non-zero exit on failure. Run via `npm run test:e2e` (runs every
// test/e2e/*.spec.js file — see package.json).
//
// Uses three test-only escape hatches:
//  - PATHBROWSER_TEST_FILE / PATHBROWSER_TEST_PHOTO_FOLDER (main.js) — skip
//    the native file/folder-picker dialogs, which UI automation can't drive.
//  - PATHBROWSER_TEST_USERDATA (main.js, added for this suite) — isolates
//    recent-files/zones/caches from a developer's real Electron profile so
//    repeated runs start clean.
// ...and one in-page hook, `window.__pathBrowserTest` (renderer/app.mjs,
// originally added in commit 5998e2e "E2E検証用テストフックを追加"), used here
// to jump between navigation states quickly (goToPrefecture/goToPlace) and to
// read back state (getView/getClusterRanking/getMapZoom) — but the actual
// bug assertions below always drive the real map via genuine mouse clicks
// (page.mouse.click / locator.click), never by calling the hook in place of
// a click, since that's the only way to exercise the real Leaflet click/pane
// z-order logic these bugs live in. `latLngToPoint` (added for this suite)
// converts a known fixture lat/lng into a page-pixel coordinate so those
// clicks can target an exact map location without guessing offsets.
//
// Shared launch/onboarding/helpers live in ./helpers.js (issue #8).

const assert = require('assert');
const fs = require('fs');
const {
  CLUSTER_A,
  CLUSTER_B,
  OSAKA,
  TOKYO_BACKDROP,
  TOKYO_CODE,
  OSAKA_CODE,
  near,
  distanceMeters,
  goToPrefecture,
  goToPlace,
  latLngToPoint,
  getView,
  createStepRunner,
  launchApp,
  completeOnboarding,
} = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();

  try {
    await completeOnboarding(page, step);

    const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
    const rowA = rows.find((r) => near(r.lat, CLUSTER_A.lat) && near(r.lng, CLUSTER_A.lng));
    const rowB = rows.find((r) => near(r.lat, CLUSTER_B.lat) && near(r.lng, CLUSTER_B.lng));
    const rowOsaka = rows.find((r) => near(r.lat, OSAKA.lat) && near(r.lng, OSAKA.lng));
    assert(rowA && rowA.count === 10, 'expected cluster A (count 10) in ranking, got: ' + JSON.stringify(rowA));
    assert(rowB && rowB.count === 2, 'expected cluster B (count 2) in ranking, got: ' + JSON.stringify(rowB));
    assert(rowOsaka && rowOsaka.count === 3, 'expected Osaka cluster (count 3) in ranking, got: ' + JSON.stringify(rowOsaka));

    // ---- Bug #1: in-panel back-link navigates to the computed parent view ----
    await step('bug #1: back-link goes place -> prefecture -> national', async () => {
      await goToPrefecture(page, TOKYO_CODE);
      let view = await getView(page);
      assert.strictEqual(view.view, 'prefecture');
      assert.strictEqual(view.params.code, TOKYO_CODE);

      await goToPlace(page, { clusterId: rowA.clusterId, muniCode: rowA.muniCode, code: TOKYO_CODE });
      view = await getView(page);
      assert.strictEqual(view.view, 'place');

      await page.click('#detail-panel-content [data-nav="back"]');
      view = await getView(page);
      assert.strictEqual(view.view, 'prefecture', 'back-link from place should land on prefecture view, not an unrelated history entry');
      assert.strictEqual(view.params.code, TOKYO_CODE);

      await page.click('#detail-panel-content [data-nav="back"]');
      view = await getView(page);
      assert.strictEqual(view.view, 'national', 'back-link from prefecture should land on national view');
    });

    // ---- Bug #2: clicking the dimmed prefecture backdrop while a place is
    // selected must not reset the selection back to the bare ranking ----
    await step('bug #2: backdrop misclick on the same prefecture does not reset the place selection', async () => {
      await goToPrefecture(page, TOKYO_CODE);
      await goToPlace(page, { clusterId: rowA.clusterId, muniCode: rowA.muniCode, code: TOKYO_CODE });

      const pt = await latLngToPoint(page, TOKYO_BACKDROP);
      await page.mouse.click(pt.x, pt.y);

      const view = await getView(page);
      assert.strictEqual(view.view, 'place', 'a backdrop misclick within the same prefecture should not have left the place view');
      assert.strictEqual(view.params.clusterId, rowA.clusterId);
    });

    // ---- Bug #3: overlapping 滞在地点 pins — the higher-visit-count pin
    // must win the click, not whichever was drawn last ----
    await step('bug #3: overlapping pins — the higher-count pin wins the click', async () => {
      await goToPrefecture(page, TOKYO_CODE);
      assert.strictEqual((await getView(page)).view, 'prefecture');

      // Click exactly at cluster B's marker center — cluster A's marker
      // (radius ~13px vs the ~100m/~1-2px on-screen separation at this zoom)
      // fully covers this point, so a correctly-implemented z-order must
      // route this click to A, the higher-count pin.
      const pt = await latLngToPoint(page, CLUSTER_B);
      await page.mouse.click(pt.x, pt.y);

      const view = await getView(page);
      assert.strictEqual(view.view, 'place', 'clicking the overlapping pins should drill into a place');
      assert.strictEqual(view.params.clusterId, rowA.clusterId, 'the higher-count pin (cluster A, 10 visits) should win the click over cluster B (2 visits)');
    });

    // ---- Issue #23: a 滞在地点 pin always sits above the photo layer, even
    // *before* it's ever been selected ----
    //
    // The first implementation of this fix only elevated whichever pin was
    // already selected/drilled into (a dedicated selectedMarkerPane above
    // photoMarkerPane). That left a chicken-and-egg deadlock: the very
    // *first* click that selects a pin happens while nothing is selected
    // yet, so at that moment the pin wasn't elevated, and a coincident photo
    // pin swallowed the click — the place could never be reached via the map
    // at all if a photo happened to sit on its pin. Confirmed against the
    // real app and fixed by elevating clusterMarkerPane itself above
    // photoMarkerPane unconditionally (renderer/mapView.mjs's initMap), so
    // this now has to pass starting from the *unselected* prefecture view.
    await step('issue #23: a stay-point pin stays clickable above a coincident photo pin, even before selection', async () => {
      await goToPrefecture(page, TOKYO_CODE);
      assert.strictEqual((await getView(page)).view, 'prefecture', 'must start unselected — this is what exposed the original deadlock');

      const photoOn = (await page.evaluate(() => window.__pathBrowserTest.getPhotoMarkerCount())).map > 0;
      if (!photoOn) {
        await page.evaluate(() => window.__pathBrowserTest.togglePhotoLayer());
      }
      // leaflet.markercluster needs a tick to add the marker DOM node.
      await page.waitForTimeout(300);

      assert(!(await page.$('.photo-popup')), 'no photo popup should be open before the click');

      const pt = await latLngToPoint(page, CLUSTER_A);
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(300);

      const photoPopup = await page.$('.photo-popup');
      assert(!photoPopup, 'clicking the stay-point pin opened a photo popup instead — pane z-order regression (issue #23)');

      const view = await getView(page);
      assert.strictEqual(view.view, 'place', 'the click should have drilled into the place — this is exactly the gesture the deadlock used to swallow');
      assert.strictEqual(view.params.clusterId, rowA.clusterId);
    });

    // ---- Follow-up to issue #23, revised for accuracy-over-clickability
    // (user feedback: the original pixel-based nudge could visibly
    // misrepresent a photo's real location at low zoom): a photo exactly
    // coincident with a stay-point pin is nudged a small FIXED real-world
    // distance (~10m, app.mjs's PHOTO_NUDGE_DISTANCE_METERS/nudgePhotosAwayFromPins),
    // not a zoom-scaled screen-pixel one. At a typical place-level zoom that
    // can be just a couple of screen pixels, so independent map-click
    // separation is no longer guaranteed — that's an accepted trade-off, not
    // a regression; the place-detail panel's own photo gallery (Stage 4,
    // issue #2) reaches these photos without depending on the map pin being
    // clickable at all ----
    await step('a photo coincident with a stay-point pin is nudged a small, bounded real-world distance', async () => {
      await goToPlace(page, { clusterId: rowA.clusterId, muniCode: rowA.muniCode, code: TOKYO_CODE });
      const photoOn = (await page.evaluate(() => window.__pathBrowserTest.getPhotoMarkerCount())).map > 0;
      if (!photoOn) await page.evaluate(() => window.__pathBrowserTest.togglePhotoLayer());
      await page.waitForTimeout(300);

      const plotted = await page.evaluate(() => window.__pathBrowserTest.getPhotoMarkerLatLngs());
      const tokyoPhoto = plotted.find((p) => p.filePath.includes('tokyo_stay'));
      assert(tokyoPhoto, 'expected the tokyo_stay.jpg marker to be plotted');

      const nudgeDistance = distanceMeters(tokyoPhoto.lat, tokyoPhoto.lng, CLUSTER_A.lat, CLUSTER_A.lng);
      assert(nudgeDistance > 3, `a photo exactly coincident with a stay-point pin should have been nudged, got only ${nudgeDistance.toFixed(1)}m`);
      assert(
        nudgeDistance < 20,
        `the nudge should stay close to its ~10m target (small enough not to misrepresent the photo's real location), got ${nudgeDistance.toFixed(1)}m`
      );
    });

    // ---- Issue #24: photo cluster opens the gallery on the very first
    // click, no staged zoom-in across repeated clicks ----
    await step('issue #24: a photo cluster opens the gallery in one click without changing zoom', async () => {
      // This fixture's Osaka photo cluster (osaka_1/2/3) sits ~6km away from
      // the Osaka stay-point pin, deliberately not coincident with it — since
      // issue #23's fix now always keeps stay-point pins above the photo
      // layer, a cluster placed exactly on a stay pin would have the pin
      // (correctly) win every click there, which would be testing #23 again
      // rather than #24. This keeps the two regressions independently
      // verifiable.
      await goToPrefecture(page, OSAKA_CODE);
      await page.waitForSelector('.photo-marker-cluster', { state: 'visible', timeout: 10000 });

      const zoomBefore = (await page.evaluate(() => window.__pathBrowserTest.getMapZoom())).zoom;
      await page.locator('.photo-marker-cluster').first().click();
      await page.waitForSelector('.photo-cluster-popup-grid', { timeout: 5000 });

      const zoomAfter = (await page.evaluate(() => window.__pathBrowserTest.getMapZoom())).zoom;
      assert.strictEqual(zoomAfter, zoomBefore, 'a single cluster click should open the gallery without changing the zoom level');
    });

    // ---- Regression: the pin-coincidence nudge above must NOT fire for
    // photos that are only *pixel*-close to a pin because the map is zoomed
    // way out (e.g. a prefecture-wide view, where a whole prefecture's stay
    // points bunch up within a few screen pixels of each other despite being
    // kilometers apart) — only genuine same-real-world-spot coincidences
    // should move. Caught in real usage: an earlier version of this nudge
    // used pixel distance alone, which scattered the whole photo layer at
    // low zoom. Placed after every test that depends on the real scanned
    // fixture photos (this one calls setPhotos, replacing them).
    await step('a photo merely pixel-close at a zoomed-out view is not nudged', async () => {
      await goToPrefecture(page, TOKYO_CODE); // prefecture-wide fit — zoomed well out
      const { zoom } = await page.evaluate(() => window.__pathBrowserTest.getMapZoom());

      // ~10 screen pixels away from CLUSTER_A at whatever zoom the prefecture
      // fit landed on — at this zoomed-out level that's still far more than
      // the nudge's real-world trigger (a fixed 15m — app.mjs's
      // PHOTO_NUDGE_TRIGGER_METERS/nudgePhotosAwayFromPins), even though it
      // would have been "pixel-close" enough to matter under the old
      // pixel-based trigger this replaced.
      const metersPerPixel = (156543.03392 * Math.cos((CLUSTER_A.lat * Math.PI) / 180)) / Math.pow(2, zoom);
      const realDistanceMeters = metersPerPixel * 10;
      assert(realDistanceMeters > 15, `test setup invalid: expected >15m at zoom ${zoom}, got ${realDistanceMeters.toFixed(0)}m — the fitted zoom changed, adjust this test`);
      const farButPixelClose = { lat: CLUSTER_A.lat + (metersPerPixel * 10) / 111320, lng: CLUSTER_A.lng };

      await page.evaluate((photo) => window.__pathBrowserTest.setPhotos([photo]), {
        filePath: 'C:\\fake\\far_but_pixel_close.jpg',
        lat: farButPixelClose.lat,
        lng: farButPixelClose.lng,
        takenAtMs: 1700000000000,
        source: 'exif',
      });
      const photoOn = (await page.evaluate(() => window.__pathBrowserTest.getPhotoMarkerCount())).map > 0;
      if (!photoOn) await page.evaluate(() => window.__pathBrowserTest.togglePhotoLayer());
      await page.waitForTimeout(300);

      const plotted = await page.evaluate(() => window.__pathBrowserTest.getPhotoMarkerLatLngs());
      const photo = plotted.find((p) => p.filePath.includes('far_but_pixel_close'));
      assert(photo, 'expected the synthetic photo marker to be plotted');
      assert.strictEqual(photo.lat, farButPixelClose.lat, `a photo ${realDistanceMeters.toFixed(0)}m from the nearest pin should not have been nudged, but its plotted latitude changed`);
      assert.strictEqual(photo.lng, farButPixelClose.lng, `a photo ${realDistanceMeters.toFixed(0)}m from the nearest pin should not have been nudged, but its plotted longitude changed`);
    });

    // ---- Follow-up to issue #24: a very large cluster must not flood the
    // main process with a thumbnail decode for every single photo at once ----
    //
    // photos:get-thumbnail (main.js) decodes/resizes/encodes on the main
    // process thread — issue #24 made the *first* click on any cluster open
    // its full gallery regardless of size, so a large, loosely-zoomed cluster
    // (e.g. a whole prefecture of photos before zooming in) could fire
    // dozens/hundreds of those at once and visibly freeze the app. Verifies
    // photoView.mjs's openClusterGallery caps the grid (MAX_GALLERY_PHOTOS)
    // and shows a truncation note, using synthetic photos injected via the
    // test-only setPhotos hook (real files aren't needed — the thumbnail
    // fetches are expected to fail gracefully for these fake paths, this is
    // only checking the cap/UI, not real decode timing).
    await step('a very large photo cluster is capped, not fetched all at once', async () => {
      const LARGE_CLUSTER = { lat: 35.70, lng: 139.80 }; // arbitrary point, away from every other fixture pin
      const synthetic = Array.from({ length: 120 }, (_, i) => ({
        filePath: `C:\\fake\\synthetic_${i}.jpg`,
        lat: LARGE_CLUSTER.lat,
        lng: LARGE_CLUSTER.lng,
        takenAtMs: 1700000000000 + i * 1000,
        source: 'exif',
      }));
      await page.evaluate((photos) => window.__pathBrowserTest.setPhotos(photos), synthetic);
      await goToPrefecture(page, TOKYO_CODE);
      const photoOn = (await page.evaluate(() => window.__pathBrowserTest.getPhotoMarkerCount())).map > 0;
      if (!photoOn) await page.evaluate(() => window.__pathBrowserTest.togglePhotoLayer());
      await page.waitForSelector('.photo-marker-cluster', { state: 'visible', timeout: 10000 });

      await page.locator('.photo-marker-cluster').first().click();
      await page.waitForSelector('.photo-cluster-popup-grid', { timeout: 5000 });

      // Scoped to the most recently opened gallery popup specifically — the
      // previous step's Osaka gallery (3 thumbs) is a *separate*, standalone
      // Leaflet popup that's still sitting in the DOM (nothing in these
      // tests explicitly closes a gallery popup before moving on), so an
      // unscoped page-wide count would double up with it.
      const popup = page.locator('.photo-cluster-popup').last();
      const thumbSlots = await popup.locator('.photo-cluster-popup-thumb-wrap').count();
      assert.strictEqual(thumbSlots, 80, `expected the gallery to cap at 80 thumbnail slots, got ${thumbSlots}`);
      const countText = await popup.locator('.photo-cluster-popup-count').textContent();
      assert(countText.includes('他40枚'), `expected a truncation note mentioning the remaining 40 photos, got: ${countText}`);

      // The capped, concurrency-limited fetches should still all resolve
      // (to the "unsupported" placeholder, since these are fake paths)
      // rather than leaving loading spinners forever.
      await popup.locator('.photo-popup-loading').first().waitFor({ state: 'detached', timeout: 15000 }).catch(() => {});
      const stillLoading = await popup.locator('.photo-popup-loading').count();
      assert.strictEqual(stillLoading, 0, 'all capped thumbnail fetches should have resolved, none left spinning');
    });

    console.log(`\nAll E2E checks passed (${stepNames.length} steps).`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
