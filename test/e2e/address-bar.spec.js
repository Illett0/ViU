'use strict';

// E2E suite for issue #36 (browsing UI): the address bar — the
// breadcrumb becomes a search field (🔍, "/" or Ctrl+L) that finds
// prefectures (Japanese or English names), visited municipalities, fetched
// detail names and dates, and jumps to them; Esc restores the breadcrumb;
// privacy mode keeps dates and individual places out of the results.

const assert = require('assert');
const fs = require('fs');
const { OSAKA_CODE, TOKYO_CODE, settle, createStepRunner, launchApp, completeOnboarding, goToPrefecture, getView } = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));

  const typeQuery = async (text) => {
    await page.fill('#address-input', text);
    await page.waitForSelector('#address-results:not([hidden])');
    return page.$$eval('#address-results li', (ns) => ns.map((n) => n.textContent));
  };

  try {
    await completeOnboarding(page, step);

    await step('"/" turns the breadcrumb into a search field; a prefecture name jumps there', async () => {
      assert(await page.isVisible('#btn-search'));
      await page.keyboard.press('/');
      assert(await page.isVisible('#address-input'));
      assert(await page.isHidden('#breadcrumb'));
      const results = await typeQuery('大阪');
      assert(results[0].includes('大阪府'), `prefecture first: ${results}`);
      assert(results.some((r) => r.includes('大阪市北区')), `visited municipality listed: ${results}`);
      await page.keyboard.press('Enter');
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.code], ['prefecture', OSAKA_CODE]);
      assert(await page.isVisible('#breadcrumb'));
    });

    await step('Ctrl+L also opens it; English prefecture names match in the Japanese UI', async () => {
      await page.keyboard.press('Control+l');
      const results = await typeQuery('tokyo');
      assert(results[0].includes('東京都'), `${results}`);
      await page.keyboard.press('Enter');
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.code], ['prefecture', TOKYO_CODE]);
    });

    await step('a municipality opens its summary, named in the breadcrumb', async () => {
      await page.click('#btn-search');
      await typeQuery('千代田');
      await page.keyboard.press('Enter');
      await settle(page);
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.clusterId, v.params.code], ['place', null, TOKYO_CODE]);
      assert((await page.textContent('#breadcrumb')).includes('千代田区'));
      const panel = await page.textContent('#detail-panel-content');
      assert(panel.includes('千代田区') && !panel.includes('プライバシー保護モードのため'), panel);
    });

    await step('dates: newest first, arrow keys pick one, Enter opens that day', async () => {
      await page.click('#btn-search');
      const results = await typeQuery('2024-01-2');
      assert.deepStrictEqual(results.slice(0, 2).map((r) => r.replace(/^日付/, '')), ['2024-01-26', '2024-01-20']);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      assert((await page.textContent('#day-view-title')).includes('2024年1月20日'));
      await page.keyboard.press('Escape');
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
    });

    await step('fetched detail names are searchable and open the stay point', async () => {
      await goToPrefecture(page, TOKYO_CODE);
      await page.waitForFunction(() => window.__pathBrowserTest.getPlaceLabelCache().entries.some(([, e]) => e.status === 'done'));
      await page.click('#btn-search');
      const results = await typeQuery('stub');
      assert(results[0].startsWith('滞在地点'), `${results}`);
      await page.keyboard.press('Enter');
      const v = await getView(page);
      assert.strictEqual(v.view, 'place');
      assert.notStrictEqual(v.params.clusterId, null);
    });

    await step('no match says so; Esc restores the breadcrumb', async () => {
      await page.click('#btn-search');
      const results = await typeQuery('zzzz');
      assert.deepStrictEqual(results, ['見つかりませんでした']);
      await page.keyboard.press('Escape');
      assert(await page.isHidden('#address-input'));
      assert(await page.isVisible('#breadcrumb'));
    });

    await step('privacy mode: dates and individual places are not offered', async () => {
      await page.click('#btn-privacy');
      await page.click('#btn-search');
      assert.deepStrictEqual(await typeQuery('2024'), ['見つかりませんでした']);
      assert.deepStrictEqual(await typeQuery('stub'), ['見つかりませんでした']);
      await page.keyboard.press('Escape');
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
