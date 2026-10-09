'use strict';

// E2E regression suite for the on-disk privacy guarantees that matter once
// ViU is distributed to other people:
//   - the main process itself refuses to send coordinates to Nominatim/
//     Overpass while privacy mode is ON (main.js app:set-privacy-mode gate),
//     independent of the renderer's own "don't ask" logic
//   - "すべてのデータを削除" (main.js data:delete-all) removes everything ViU
//     wrote under userData — recent-files history, timeline-backups/ (full
//     copies of the imported export), exclusion zones, caches — and returns
//     the window to the welcome screen with nothing left in memory.
// Uses PATHBROWSER_TEST_CONFIRM_DELETE_ALL to skip the native confirm box,
// same pattern as the other PATHBROWSER_TEST_* escape hatches.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CLUSTER_A, createStepRunner, launchApp, completeOnboarding } = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp({ PATHBROWSER_TEST_CONFIRM_DELETE_ALL: '1' });

  try {
    await completeOnboarding(page, step);

    await step('the main process refuses reverse geocoding while privacy mode is ON', async () => {
      await page.evaluate(() => window.__pathBrowserTest.setPrivacy(true));
      const res = await page.evaluate(({ lat, lng }) => window.pathBrowser.reverseGeocode(null, lat, lng), CLUSTER_A);
      assert.strictEqual(res.error, 'privacy-mode', `expected the main-process privacy gate to refuse the request, got ${JSON.stringify(res)}`);
      assert.strictEqual(res.label, null);
      assert(!fs.existsSync(path.join(userDataDir, 'nominatim-cache.json')), 'nothing should have been fetched or cached under privacy mode');
    });

    await step('importing a file leaves a backup copy, history entry, and zones on disk', async () => {
      await page.evaluate(({ lat, lng }) => window.__pathBrowserTest.addZone(lat, lng, 50), CLUSTER_A);
      assert(fs.existsSync(path.join(userDataDir, 'recent-files.json')), 'expected recent-files.json after import');
      const backups = fs.readdirSync(path.join(userDataDir, 'timeline-backups'));
      assert(backups.length === 1, `expected exactly one timeline backup, got ${backups.length}`);
      assert(fs.existsSync(path.join(userDataDir, 'exclusion-zones.json')), 'expected exclusion-zones.json after adding a zone');
    });

    await step('"すべてのデータを削除" wipes userData and returns to an empty welcome screen', async () => {
      await page.evaluate(() => window.__pathBrowserTest.openSettings());
      await page.click('#btn-delete-all-data');
      await page.waitForSelector('#welcome-screen:not([hidden])', { timeout: 30000 });
      await page.waitForSelector('#btn-open-file-main', { state: 'visible' });

      for (const name of ['recent-files.json', 'timeline-backups', 'exclusion-zones.json', 'geo-cache', 'photo-cache.json', 'thumbnail-cache']) {
        assert(!fs.existsSync(path.join(userDataDir, name)), `expected ${name} to be deleted`);
      }
      const recentHidden = await page.evaluate(() => document.getElementById('recent-files-section').hidden);
      assert(recentHidden, 'the recent-files list should be empty (hidden) after deleting all data');
      const zones = await page.evaluate(() => window.pathBrowser.getZones());
      assert.deepStrictEqual(zones, [], 'no exclusion zones should survive');
      const linked = await page.evaluate(() => window.pathBrowser.getLinkedPhotoFolder());
      assert.strictEqual(linked, null, 'the linked photo folder setting should be gone');
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
