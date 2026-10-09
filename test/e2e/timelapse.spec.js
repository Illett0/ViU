'use strict';

// E2E regression suite for timelapse playback on the national view: besides
// painting prefectures cumulatively month by month, every 滞在地点 visited so
// far is drawn as a dot nationwide (renderTimelapsePoints in mapView.mjs),
// and those dots go away once playback is reset.

const assert = require('assert');
const fs = require('fs');
const { createStepRunner, launchApp, completeOnboarding } = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();

  try {
    await completeOnboarding(page, step);

    const allPlaces = (await page.evaluate(() => window.__pathBrowserTest.getClusterRanking())).length;

    await step('starting playback draws stay-point dots on the national map', async () => {
      await page.evaluate(() => window.__pathBrowserTest.startTimelapse());
      const n = await page.evaluate(() => window.__pathBrowserTest.getTimelapsePointCount());
      assert(n > 0, 'expected at least one dot after the first timelapse tick');
    });

    await step('by the end of playback every stay point is drawn', async () => {
      await page.waitForFunction(() => !window.__pathBrowserTest.getTimelapseState().playing, null, { timeout: 30000 });
      const n = await page.evaluate(() => window.__pathBrowserTest.getTimelapsePointCount());
      assert(allPlaces > 0);
      // getClusterRanking is capped at 20 rows; the fixture has fewer places than that.
      assert.strictEqual(n, allPlaces, `expected all ${allPlaces} places as dots at the end, got ${n}`);
    });

    await step('resetting playback removes the dots', async () => {
      await page.evaluate(() => window.__pathBrowserTest.resetTimelapse());
      const n = await page.evaluate(() => window.__pathBrowserTest.getTimelapsePointCount());
      assert.strictEqual(n, 0);
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
