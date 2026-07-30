'use strict';

// E2E regression suite for 写真のみモード (issue #21) — the entry point that
// lets someone with no Google Timeline export still plot linked photos on
// the map. See renderer/app.mjs's openPhotosOnly()/finishLoadingIntoApp()/
// the photosOnlyMode branch inside render(), and main.js's
// timeline:get-reference-lists IPC handler. Unlike the other specs, this one
// deliberately never clicks #btn-open-file-main / uses the timeline fixture
// at all — PATHBROWSER_TEST_FILE being set (via helpers.js's launchApp) is
// harmless noise here, since timeline:choose-file is never invoked.

const assert = require('assert');
const fs = require('fs');
const { createStepRunner, launchApp } = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();

  try {
    await step('welcome screen shows both the normal and photos-only entry points', async () => {
      assert(await page.isVisible('#btn-open-file-main'), 'expected the normal "ファイルを選択" button to be visible');
      assert(await page.isVisible('#btn-photos-only'), 'expected the new "タイムラインなしで写真だけ見る" button to be visible');
    });

    await step('choosing photos-only routes through privacy notice and settings to the map', async () => {
      await page.click('#btn-photos-only');
      await page.waitForSelector('#btn-privacy-notice-continue', { state: 'visible', timeout: 30000 });
      await page.click('#btn-privacy-notice-continue');
      await page.waitForSelector('#btn-link-photo-folder', { state: 'visible' });

      await page.click('#btn-link-photo-folder');
      await page.waitForFunction(
        () => {
          const el = document.getElementById('photo-scan-summary');
          return !!(el && el.textContent && el.textContent.includes('枚中'));
        },
        { timeout: 30000 }
      );

      // No visit data exists in this mode, so no HOME/WORK/top-place
      // suggestions should ever appear (computeSuggestions reads
      // state.raw.frequentPlaces/visits, both empty in the stub).
      const suggestionCount = await page.locator('#zone-suggestions .zone-suggestion').count();
      assert.strictEqual(suggestionCount, 0, 'expected no exclusion-zone suggestions with zero visit data');

      await page.click('#btn-settings-goto-map');
      await page.waitForSelector('#map-screen:not([hidden])');
      // Privacy mode defaults ON everywhere in this app, and the photo layer
      // is gated behind it just like in normal mode (photos carry the same
      // sensitive GPS+timestamp data as timeline visits — photos-only mode
      // doesn't change that). state.photoLayerVisible=true (set by
      // openPhotosOnly()) only becomes observable once privacy is off.
      await page.evaluate(() => window.__pathBrowserTest.setPrivacy(false));
    });

    await step('only the 県制覇マップ tab is visible; timeline-only controls are hidden', async () => {
      assert(await page.isVisible('.tab-btn[data-tab="map"]'), 'expected the map tab to be visible');
      assert(!(await page.isVisible('#tab-route')), 'expected the route tab to be hidden in photos-only mode');
      assert(!(await page.isVisible('.tab-btn[data-tab="chronology"]')), 'expected the chronology tab to be hidden');
      assert(!(await page.isVisible('.tab-btn[data-tab="stats"]')), 'expected the stats tab to be hidden');
      assert(!(await page.isVisible('#cluster-filter')), 'expected the clustering-threshold slider to be hidden');
      assert(!(await page.isVisible('#btn-timelapse-play')), 'expected the timelapse play button to be hidden');
      assert(!(await page.isVisible('#btn-timelapse-reset')), 'expected the timelapse reset button to be hidden');
      assert(await page.isVisible('#photos-only-banner'), 'expected the photos-only explanatory banner to be visible');
    });

    await step('the national choropleth renders all-grey but stays interactive, with correct reference data', async () => {
      const badgeText = await page.locator('#prefecture-count-badge').textContent();
      assert(/0\s*\/\s*47/.test(badgeText), `expected the prefecture badge to read "0 / 47 県"-style, got: ${badgeText}`);

      // Tokyo (code 13) — drives into it via the same test hook the other
      // specs use; this is testing the reference-list stub, not click z-order,
      // so a hook is appropriate here (see helpers.js's own comment on when
      // to prefer real clicks vs. hooks).
      await page.evaluate(() => window.__pathBrowserTest.goToPrefecture(13));
      await page.waitForTimeout(400);
      const view = await page.evaluate(() => window.__pathBrowserTest.getView());
      assert.strictEqual(view.view, 'prefecture');
      assert.strictEqual(view.params.code, 13);

      const breadcrumbText = await page.locator('#breadcrumb').textContent();
      assert(breadcrumbText.includes('東京都'), `expected the breadcrumb to show the real prefecture name "東京都", got: ${breadcrumbText}`);

      const detailText = await page.locator('#detail-panel-content').textContent();
      assert(!detailText.includes('0 / 0'), 'municipality-conquest ratio should show a real denominator (e.g. 0/62), not 0/0 — this is the reference-list regression check');
    });

    await step('photo layer is visible by default and pins resolve to a real place name', async () => {
      const photoLayerActive = await page.evaluate(() => document.getElementById('btn-photo-toggle').classList.contains('active'));
      assert(photoLayerActive, 'expected the photo layer to default to visible in photos-only mode');

      const photoCount = (await page.evaluate(() => window.__pathBrowserTest.getPhotoMarkerCount())).map;
      assert(photoCount > 0, 'expected at least one photo marker to be plotted from the fixture photo folder');

      const plotted = await page.evaluate(() => window.__pathBrowserTest.getPhotoMarkerLatLngs());
      const tokyoPhoto = plotted.find((p) => p.filePath.includes('tokyo_stay'));
      assert(tokyoPhoto, 'expected the tokyo_stay.jpg marker to be plotted');
      const pt = await page.evaluate(({ lat, lng }) => window.__pathBrowserTest.latLngToPoint(lat, lng), tokyoPhoto);
      await page.mouse.click(pt.x, pt.y);
      await page.waitForTimeout(300);
      const popupText = await page.locator('.photo-popup').textContent();
      assert(
        !popupText.includes('不明') && /区|市|町|村/.test(popupText),
        `expected the photo popup to show a real municipality name (regression check for the reference-list fix), got: ${popupText}`
      );
    });

    await step('the year filter includes years derived from photo taken-at dates', async () => {
      const yearOptions = await page.locator('#filter-year option').allTextContents();
      assert(yearOptions.some((t) => /\d{4}年/.test(t)), `expected at least one real year option in the filter, got: ${JSON.stringify(yearOptions)}`);
    });

    await step('opening a real timeline file from within photos-only mode restores the hidden tabs', async () => {
      await page.click('#btn-settings');
      await page.waitForSelector('#settings-screen:not([hidden])');
      await page.click('#btn-settings-close');
      await page.waitForSelector('#map-screen:not([hidden])');

      await page.click('#btn-open-file'); // header button, not #btn-open-file-main (welcome-screen-only, already gone by this point)
      await page.waitForSelector('#btn-privacy-notice-continue', { state: 'visible', timeout: 30000 });
      await page.click('#btn-privacy-notice-continue');
      await page.click('#btn-settings-goto-map');
      await page.waitForSelector('#map-screen:not([hidden])');

      assert(await page.isVisible('#tab-route'), 'expected the route tab to reappear once a real timeline file is loaded');
      assert(await page.isVisible('.tab-btn[data-tab="chronology"]'), 'expected the chronology tab to reappear');
      assert(await page.isVisible('.tab-btn[data-tab="stats"]'), 'expected the stats tab to reappear');
      assert(!(await page.isVisible('#photos-only-banner')), 'expected the photos-only banner to disappear once a real timeline is loaded');
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
