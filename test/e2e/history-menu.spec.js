'use strict';

// E2E suite for issue #33 (browsing UI): the browsing history list
// next to back/forward — newest first with the current entry marked, a click
// jumps straight to that entry (keeping later entries reachable by forward),
// keyboard/Esc handling, and right-click on back/forward as a second way in.

const assert = require('assert');
const fs = require('fs');
const { CLUSTER_A, OSAKA_CODE, TOKYO_CODE, near, createStepRunner, launchApp, completeOnboarding, goToPrefecture, goToPlace, getView } = require('./helpers');

async function menuItems(page) {
  return page.$$eval('#history-menu .history-item', (ns) => ns.map((n) => ({ label: n.textContent, current: n.getAttribute('aria-current') === 'true' })));
}

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));

  try {
    await completeOnboarding(page, step);

    await step('the history button is disabled with nothing to go back to', async () => {
      assert(await page.isDisabled('#btn-history'));
    });

    await step('the menu lists visited views newest first, current one marked', async () => {
      const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
      const rowA = rows.find((r) => near(r.lat, CLUSTER_A.lat) && near(r.lng, CLUSTER_A.lng));
      await goToPrefecture(page, TOKYO_CODE);
      await goToPlace(page, { clusterId: rowA.clusterId, muniCode: null, code: TOKYO_CODE });
      await goToPrefecture(page, OSAKA_CODE);
      await page.click('#btn-history');
      await page.waitForSelector('#history-menu:not([hidden])');
      const items = await menuItems(page);
      assert.strictEqual(items.length, 4, JSON.stringify(items));
      assert.strictEqual(items[0].label, '大阪府');
      assert(/^東京都 › .*千代田区/.test(items[1].label), `a place is named by where it is: ${items[1].label}`);
      assert.strictEqual(items[2].label, '東京都');
      assert.strictEqual(items[3].label, '日本地図');
      assert.deepStrictEqual(items.map((i) => i.current), [true, false, false, false]);
      assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('aria-current')), 'true', 'focus starts on the current entry');
    });

    await step('clicking an entry jumps there and keeps later entries for forward', async () => {
      await page.click('#history-menu .history-item[data-index="1"]');
      assert(await page.isHidden('#history-menu'));
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.code], ['prefecture', TOKYO_CODE]);
      assert(await page.isEnabled('#btn-forward'));
      assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'btn-history');
    });

    await step('keyboard: arrows move between entries, Esc closes and returns focus', async () => {
      await page.click('#btn-history');
      const items = await menuItems(page);
      assert.strictEqual(items.findIndex((i) => i.current), 2, 'the current mark moved to 東京都');
      await page.keyboard.press('ArrowDown');
      assert.strictEqual(await page.evaluate(() => document.activeElement.textContent), '日本地図');
      await page.keyboard.press('Escape');
      assert(await page.isHidden('#history-menu'));
      assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'btn-history');
    });

    await step('right-clicking the back button opens the same menu; clicking outside closes it', async () => {
      await page.click('#btn-back', { button: 'right' });
      await page.waitForSelector('#history-menu:not([hidden])');
      await page.click('#app-header h1'); // somewhere inert (a map click would navigate)
      assert(await page.isHidden('#history-menu'));
    });

    await step('navigating somewhere new after a jump drops the forward entries, as in a browser', async () => {
      await goToPrefecture(page, 1);
      await page.click('#btn-history');
      const labels = (await menuItems(page)).map((i) => i.label);
      assert.deepStrictEqual(labels.slice(0, 2), ['北海道', '東京都']);
      assert(!labels.includes('大阪府'), `forward entries should be gone: ${labels}`);
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
