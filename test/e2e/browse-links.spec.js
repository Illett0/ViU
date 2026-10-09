'use strict';

// E2E suite for issue #32 (browsing UI): names and dates shown in one
// view link to their own detail view, so the data can be browsed detail to
// detail — day-view stays → stay-point detail, stats dates → day view,
// chronology municipality events → the stay point of that first visit — and
// the back button walks those jumps like any other navigation.

const assert = require('assert');
const fs = require('fs');
const { CLUSTER_A, OSAKA, OSAKA_CODE, TOKYO_CODE, near, settle, createStepRunner, launchApp, completeOnboarding, getView } = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));

  try {
    await completeOnboarding(page, step);
    const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
    const rowA = rows.find((r) => near(r.lat, CLUSTER_A.lat) && near(r.lng, CLUSTER_A.lng));
    const rowOsaka = rows.find((r) => near(r.lat, OSAKA.lat) && near(r.lng, OSAKA.lng));

    await step('day view: a stay links to that stay point\'s detail on the map', async () => {
      await page.evaluate(() => window.__pathBrowserTest.openDayView('2024-01-20'));
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      const links = await page.$$('#day-view-timeline .day-tl-link');
      assert(links.length >= 1, 'expected a details link for each stay');
      await links[links.length - 1].click(); // the Osaka stay, after the train ride
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.clusterId, v.params.code], ['place', rowOsaka.clusterId, OSAKA_CODE]);
      assert(!(await page.isHidden('#map-screen')), 'the coverage map tab is shown');
    });

    await step('stats: dates in the longest-trip and top-day lists open that day', async () => {
      await page.click('.tab-btn[data-tab="stats"]');
      const dates = await page.$$eval('#stats-content [data-day]', (ns) => ns.map((n) => n.dataset.day));
      assert(dates.includes('2024-01-20'), `expected the train day as a link, got ${dates}`);
      await page.click('#stats-content .mode-table [data-day="2024-01-20"]');
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      assert((await page.textContent('#day-view-title')).includes('2024年1月20日'));
      await page.keyboard.press('Escape');
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
    });

    await step('chronology: a municipality event opens the stay point of that first visit', async () => {
      await page.click('.tab-btn[data-tab="chronology"]');
      if (!(await page.isChecked('#chronology-include-muni'))) await page.click('#chronology-include-muni');
      // Municipality events only — the 東京都 event also names 千代田区 as its hint.
      await page.click('#chronology-content .chronology-item:has(.chronology-tag:not(.pref)):has-text("千代田区")');
      await page.waitForSelector('#map-screen:not([hidden])');
      await settle(page);
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.clusterId, v.params.code], ['place', rowA.clusterId, TOKYO_CODE], 'first 千代田区 visit is cluster A (2024-01-05)');
    });

    await step('back walks the followed links: place → its prefecture', async () => {
      await page.click('#btn-back');
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.code], ['prefecture', TOKYO_CODE]);
    });

    await step('privacy mode: stats dates are plain text (route views are off)', async () => {
      await page.click('#btn-privacy');
      await page.click('.tab-btn[data-tab="stats"]');
      assert.strictEqual((await page.$$('#stats-content [data-day]')).length, 0);
      await page.click('#btn-privacy');
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
