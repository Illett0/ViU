'use strict';

// E2E suite for issue #38 (browsing UI): comparing two periods side by
// side — the comparison map replaces the detail panel, shows another period
// (default: the year before the left map's), follows the same view and
// pan/zoom both ways, has its own period selector and visited count, and
// turning it off restores the detail panel. Uses the multi-year fixture.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { settle, createStepRunner, launchApp, completeOnboarding, goToPrefecture } = require('./helpers');

const HISTORY_FILE = path.join(__dirname, 'fixtures', 'timeline.history.json');
const TOKYO = 13;
const KYOTO = 26;

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp({ PATHBROWSER_TEST_FILE: HISTORY_FILE });

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));

  const leftStyles = () => page.evaluate(() => window.__pathBrowserTest.getPrefectureStyles());
  const rightStyles = () => page.evaluate(() => window.__pathBrowserTest.getCompareStyles());
  const UNVISITED = async () => (await leftStyles())[1].fillColor; // Hokkaido: never visited in the fixture

  try {
    await completeOnboarding(page, step);

    await step('turning comparison on shows a second map instead of the detail panel', async () => {
      await page.selectOption('#filter-year', '2024');
      await page.click('#btn-compare');
      await page.waitForSelector('#compare-panel:not([hidden])');
      assert(await page.isHidden('#detail-panel'));
      assert.strictEqual(await page.getAttribute('#btn-compare', 'aria-pressed'), 'true');
      assert(await page.isDisabled('#btn-timelapse-play'), 'the timelapse (left map only) is off while comparing');
    });

    await step('the right map defaults to the previous year and colors that period', async () => {
      assert.strictEqual(await page.inputValue('#compare-year'), '2023');
      assert.strictEqual(await page.textContent('#map-period-badge'), '2024年');
      const unvisited = await UNVISITED();
      const left = await leftStyles();
      const right = await rightStyles();
      assert.notStrictEqual(left[TOKYO].fillColor, unvisited, 'Tokyo visited in 2024');
      assert.strictEqual(left[KYOTO].fillColor, unvisited, 'Kyoto not visited in 2024');
      assert.strictEqual(right[TOKYO].fillColor, unvisited, 'Tokyo not visited in 2023');
      assert.notStrictEqual(right[KYOTO].fillColor, unvisited, 'Kyoto visited in 2023');
      assert(/^1 \/ 47/.test(await page.textContent('#compare-count-badge')), await page.textContent('#compare-count-badge'));
    });

    await step('changing the right period re-colors only the right map', async () => {
      await page.selectOption('#compare-year', '2024');
      const right = await rightStyles();
      assert.notStrictEqual(right[TOKYO].fillColor, await UNVISITED());
      assert(/^2 \/ 47/.test(await page.textContent('#compare-count-badge')));
      await page.selectOption('#compare-year', '2023');
    });

    await step('opening a prefecture shows it on both maps, with the camera in sync', async () => {
      await goToPrefecture(page, TOKYO);
      await settle(page);
      const right = await rightStyles();
      assert.strictEqual(right[TOKYO].color, '#ff7f0e', 'the selected prefecture is outlined on the right map too');
      const l = await page.evaluate(() => window.__pathBrowserTest.getMapZoom());
      const r = await page.evaluate(() => window.__pathBrowserTest.getCompareView());
      assert.strictEqual(r.zoom, l.zoom);
      assert(Math.abs(r.center.lat - l.center.lat) < 1e-6 && Math.abs(r.center.lng - l.center.lng) < 1e-6, `${JSON.stringify(l.center)} vs ${JSON.stringify(r.center)}`);
    });

    await step('panning the right map moves the left one', async () => {
      await page.evaluate(() => window.__pathBrowserTest.panCompareMap(0.2, 0.3));
      await settle(page);
      const l = await page.evaluate(() => window.__pathBrowserTest.getMapZoom());
      const r = await page.evaluate(() => window.__pathBrowserTest.getCompareView());
      assert(Math.abs(r.center.lat - l.center.lat) < 1e-6 && Math.abs(r.center.lng - l.center.lng) < 1e-6);
    });

    await step('turning comparison off restores the detail panel', async () => {
      await page.click('#btn-compare');
      assert(await page.isHidden('#compare-panel'));
      assert(await page.isVisible('#detail-panel'));
      assert(await page.isEnabled('#btn-timelapse-play'));
      assert((await page.textContent('#detail-panel-content')).includes('東京都'));
    });

    assert.deepStrictEqual(pageErrors, [], 'uncaught renderer errors:\n' + pageErrors.join('\n'));
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
