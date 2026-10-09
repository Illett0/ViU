'use strict';

// E2E suite for issue #34 (browsing UI): related links — the stay
// point detail lists the nearest other stay points (zone-filtered like the
// ranking), and each stay in the day view links to the previous/next day that
// same place was visited.

const assert = require('assert');
const fs = require('fs');
const { CLUSTER_A, CLUSTER_B, TOKYO_CODE, near, settle, createStepRunner, launchApp, completeOnboarding, goToPlace, getView } = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));

  try {
    await completeOnboarding(page, step);
    const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
    const rowA = rows.find((r) => near(r.lat, CLUSTER_A.lat) && near(r.lng, CLUSTER_A.lng));
    const rowB = rows.find((r) => near(r.lat, CLUSTER_B.lat) && near(r.lng, CLUSTER_B.lng));
    const openA = () => goToPlace(page, { clusterId: rowA.clusterId, muniCode: null, code: TOKYO_CODE });

    await step('place detail lists the nearest stay points, closest first', async () => {
      await openA();
      const items = await page.$$eval('#detail-panel-content .nearby-list li', (ns) => ns.map((n) => ({ id: Number(n.querySelector('button').dataset.clusterId), meta: n.querySelector('.nearby-meta').textContent })));
      assert(items.length >= 2, JSON.stringify(items));
      assert.strictEqual(items[0].id, rowB.clusterId, 'cluster B (~100m north) is the nearest');
      assert(/^1\d\d m · 2 回$/.test(items[0].meta), `distance and visits: ${items[0].meta}`);
      assert(!items.some((i) => i.id === rowA.clusterId), 'the place itself is not listed');
    });

    await step('clicking a nearby stay point opens it, and back returns', async () => {
      await page.click(`#detail-panel-content .nearby-item[data-cluster-id="${rowB.clusterId}"]`);
      let v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.clusterId, v.params.code], ['place', rowB.clusterId, TOKYO_CODE]);
      await page.click('#btn-back');
      v = await getView(page);
      assert.strictEqual(v.params.clusterId, rowA.clusterId);
    });

    await step('a zoned-out stay point is not offered as nearby', async () => {
      await page.evaluate(({ lat, lng }) => window.__pathBrowserTest.addZone(lat, lng, 30), CLUSTER_B);
      await openA();
      const ids = await page.$$eval('#detail-panel-content .nearby-item', (ns) => ns.map((n) => Number(n.dataset.clusterId)));
      assert(!ids.includes(rowB.clusterId), `B is inside a zone: ${ids}`);
      await page.evaluate(() => window.__pathBrowserTest.clearZones());
    });

    await step('day view: a stay links to the previous and next day at the same place', async () => {
      await page.evaluate(() => window.__pathBrowserTest.openDayView('2024-01-12'));
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      const days = await page.$$eval('#day-view-timeline .day-tl-day', (ns) => ns.map((n) => n.dataset.day));
      assert.deepStrictEqual(days, ['2024-01-05', '2024-01-19']);
      await page.click('#day-view-timeline .day-tl-day[data-day="2024-01-19"]');
      await settle(page);
      assert((await page.textContent('#day-view-title')).includes('2024年1月19日'));
      assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'day-view-title', 'focus moves to the new date');
    });

    await step('the first visit has no "previous" link', async () => {
      await page.evaluate(() => window.__pathBrowserTest.openDayView('2024-01-05'));
      const days = await page.$$eval('#day-view-timeline .day-tl-day', (ns) => ns.map((n) => n.dataset.day));
      assert.deepStrictEqual(days, ['2024-01-12']);
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
