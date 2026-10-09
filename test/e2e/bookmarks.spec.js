'use strict';

// E2E suite for issue #35 (browsing UI): bookmarks — save the current
// view (tab, view, period filter) under a name, persist it to
// userData/bookmarks.json, reopen it later; a stay point is stored by its
// coordinates, so it still resolves after re-clustering changes every cluster
// id, falls back to the prefecture when it's zoned out, and opens at
// municipality level under privacy mode.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CLUSTER_A, TOKYO_CODE, near, settle, createStepRunner, launchApp, completeOnboarding, goToPlace, getView } = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();
  const bookmarksFile = path.join(userDataDir, 'bookmarks.json');
  const readFile = () => JSON.parse(fs.readFileSync(bookmarksFile, 'utf-8'));
  const clusterAt = async (p) => (await page.evaluate(() => window.__pathBrowserTest.getClusterRanking())).find((r) => near(r.lat, p.lat, 0.002) && near(r.lng, p.lng, 0.002));
  const openBookmarkNamed = async (name) => {
    await page.click('#btn-bookmarks');
    await page.click(`#bookmark-list .bookmark-open:text-is("${name}")`);
    await settle(page);
  };

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));
  const dialogs = [];
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    d.accept();
  });

  try {
    await completeOnboarding(page, step);

    await step('bookmarking a stay point with a year filter saves its coordinates, not its cluster id', async () => {
      assert(await page.isEnabled('#btn-bookmarks'));
      await page.selectOption('#filter-year', '2024');
      const rowA = await clusterAt(CLUSTER_A);
      await goToPlace(page, { clusterId: rowA.clusterId, muniCode: null, code: TOKYO_CODE });
      await page.click('#btn-bookmarks');
      const suggested = await page.inputValue('#bookmark-name');
      assert(/^東京都 › .*千代田区.*（2024年）$/.test(suggested), `default name: ${suggested}`);
      await page.fill('#bookmark-name', '東京駅');
      await page.press('#bookmark-name', 'Enter');
      await page.waitForSelector('#bookmark-list .bookmark-open');
      const saved = readFile();
      assert.strictEqual(saved.length, 1);
      assert.deepStrictEqual([saved[0].name, saved[0].view, saved[0].filter.year], ['東京駅', 'place', 2024]);
      assert(near(saved[0].anchor.lat, CLUSTER_A.lat) && near(saved[0].anchor.lng, CLUSTER_A.lng), JSON.stringify(saved[0].anchor));
      assert(!('clusterId' in saved[0].params), 'no cluster id is persisted');
      await page.keyboard.press('Escape');
      assert(await page.isHidden('#bookmark-panel'));
    });

    await step('opening it restores the view and filter; back goes to its prefecture', async () => {
      await page.selectOption('#filter-year', '');
      await page.click('#breadcrumb .crumb[data-index="0"]').catch(() => {});
      await openBookmarkNamed('東京駅');
      const rowA = await clusterAt(CLUSTER_A);
      let v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.clusterId], ['place', rowA.clusterId]);
      assert.strictEqual(await page.inputValue('#filter-year'), '2024');
      await page.click('#btn-back');
      v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.code], ['prefecture', TOKYO_CODE]);
    });

    await step('after re-clustering (all cluster ids change) it still finds the place', async () => {
      await page.$eval('#cluster-threshold', (input) => {
        input.value = '200';
        input.dispatchEvent(new Event('change'));
      });
      await page.waitForFunction(() => document.getElementById('cluster-threshold-label').textContent === '200m');
      await openBookmarkNamed('東京駅');
      const merged = await clusterAt(CLUSTER_A);
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.clusterId], ['place', merged.clusterId]);
    });

    await step('a bookmarked place inside an exclusion zone opens its prefecture instead, with a notice', async () => {
      await page.evaluate(({ lat, lng }) => window.__pathBrowserTest.addZone(lat, lng, 300), CLUSTER_A);
      await openBookmarkNamed('東京駅');
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.code], ['prefecture', TOKYO_CODE]);
      assert.strictEqual(dialogs.length, 1, 'one notice explains the fallback');
      await page.evaluate(() => window.__pathBrowserTest.clearZones());
    });

    await step('under privacy mode it opens at municipality level', async () => {
      await page.click('#btn-privacy');
      await openBookmarkNamed('東京駅');
      const v = await getView(page);
      assert.strictEqual(v.view, 'place');
      assert.strictEqual(v.params.clusterId, null);
      assert(v.params.muniCode, 'the municipality roll-up view');
      await page.click('#btn-privacy');
    });

    await step('a stats-tab bookmark reopens the stats tab; deleting removes it from disk', async () => {
      await page.click('.tab-btn[data-tab="stats"]');
      await page.click('#btn-bookmarks');
      // The 2024 filter restored by the previous bookmark is still on.
      assert.strictEqual(await page.inputValue('#bookmark-name'), '移動統計（2024年）');
      await page.click('#bookmark-form button[type="submit"]');
      await page.keyboard.press('Escape');
      await page.click('.tab-btn[data-tab="map"]');
      await openBookmarkNamed('移動統計（2024年）');
      assert(!(await page.isHidden('#stats-screen')), 'stats tab is shown');
      await page.click('#btn-bookmarks');
      await page.click('#bookmark-list .bookmark-delete[data-index="0"]');
      assert.deepStrictEqual(readFile().map((b) => b.name), ['移動統計（2024年）']);
      await page.keyboard.press('Escape');
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
