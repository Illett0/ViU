'use strict';

// E2E regression suite for the 滞在地点 detail panel's inline photo gallery
// (Stage 4, issue #2 — renderer/app.mjs's photosForPlace/renderPlaceDetail,
// reusing renderer/photoView.mjs's galleryHtml/loadGalleryThumbnails). See
// test/e2e/helpers.js for the shared launch/onboarding/fixture setup this
// builds on, and CLAUDE.md for how the whole test/e2e/*.spec.js suite runs.

const assert = require('assert');
const fs = require('fs');
const {
  CLUSTER_A,
  OSAKA,
  TOKYO_CODE,
  OSAKA_CODE,
  near,
  goToPlace,
  createStepRunner,
  launchApp,
  completeOnboarding,
} = require('./helpers');

const GALLERY_HEADING_TEXT = 'この場所の写真';

async function hasGalleryHeading(page) {
  return page.evaluate((heading) => {
    const h3s = Array.from(document.querySelectorAll('#detail-panel-content h3'));
    return h3s.some((h) => h.textContent.includes(heading));
  }, GALLERY_HEADING_TEXT);
}

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();

  try {
    await completeOnboarding(page, step);

    const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
    const rowA = rows.find((r) => near(r.lat, CLUSTER_A.lat) && near(r.lng, CLUSTER_A.lng));
    const rowOsaka = rows.find((r) => near(r.lat, OSAKA.lat) && near(r.lng, OSAKA.lng));
    assert(rowA, 'expected cluster A (tokyo_stay.jpg is coincident with this one) in ranking');
    assert(rowOsaka, 'expected the Osaka cluster in ranking');

    // ---- A place with a genuinely nearby photo (tokyo_stay.jpg sits exactly
    // on this cluster — see helpers.js's CLUSTER_A comment) gets a gallery
    // section, with a thumbnail that loads and opens the shared lightbox ----
    await step('a place with a nearby photo shows a gallery section with a loadable, clickable thumbnail', async () => {
      await goToPlace(page, { clusterId: rowA.clusterId, muniCode: rowA.muniCode, code: TOKYO_CODE });

      assert(await hasGalleryHeading(page), 'expected a "この場所の写真" section for a place with a coincident photo');

      const thumbWraps = page.locator('#detail-panel-content .photo-cluster-popup-thumb-wrap');
      assert.strictEqual(await thumbWraps.count(), 1, 'expected exactly one thumbnail (tokyo_stay.jpg) for this place');

      const thumb = thumbWraps.first();
      await thumb.locator('img').waitFor({ state: 'attached', timeout: 10000 });

      await thumb.click();
      const lightboxVisible = await page.evaluate(() => !document.getElementById('photo-lightbox-overlay').hidden);
      assert(lightboxVisible, 'clicking the place-detail thumbnail should open the shared lightbox');

      const caption = await page.locator('#photo-lightbox-caption').textContent();
      assert(caption.includes('tokyo_stay.jpg'), `expected the lightbox caption to name the photo file, got: ${caption}`);

      await page.click('#btn-photo-lightbox-close');
      const lightboxHiddenAfterClose = await page.evaluate(() => document.getElementById('photo-lightbox-overlay').hidden);
      assert(lightboxHiddenAfterClose, 'the lightbox should close on its close button');
    });

    // ---- A place with no photo within the nudge/gallery real-world radius
    // (the Osaka fixture's photo cluster deliberately sits ~6km from this
    // stay pin — see helpers.js's OSAKA comment / click-handling.spec.js's
    // issue #24 test) must not render an empty/dangling gallery section ----
    await step('a place with no nearby photo shows no gallery section at all', async () => {
      await goToPlace(page, { clusterId: rowOsaka.clusterId, muniCode: rowOsaka.muniCode, code: OSAKA_CODE });
      assert(!(await hasGalleryHeading(page)), 'a place with zero matching photos should not render a gallery section');
      assert.strictEqual(
        await page.locator('#detail-panel-content .photo-cluster-popup-thumb-wrap').count(),
        0,
        'expected no thumbnail wraps for a place with zero matching photos'
      );
    });

    // ---- Navigating away mid-fetch must not throw or leave stale state:
    // renderPlaceDetail cancels the previous place's in-flight thumbnail
    // fetches (placeGalleryCancel) before rendering the next one ----
    await step('navigating from one place to another does not error and re-renders the gallery correctly', async () => {
      await goToPlace(page, { clusterId: rowA.clusterId, muniCode: rowA.muniCode, code: TOKYO_CODE });
      assert(await hasGalleryHeading(page), 'expected the gallery section again after navigating back to cluster A');
      await goToPlace(page, { clusterId: rowOsaka.clusterId, muniCode: rowOsaka.muniCode, code: OSAKA_CODE });
      assert(!(await hasGalleryHeading(page)), 'expected no gallery section after navigating to the Osaka place');
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
