'use strict';

// E2E suite for issue #36 (browsing UI): the address bar — the
// breadcrumb becomes a search field (🔍, "/" or Ctrl+L) that finds
// prefectures (Japanese or English names), every municipality (unvisited ones
// tagged), detail names fetched now or in an earlier session (disk cache, no
// request), loosely written dates and periods, and jumps to them; Esc
// restores the breadcrumb; privacy mode keeps dates and individual places
// out of the results.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');
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

    // A detail name "fetched in an earlier session": the main process reads
    // its disk cache lazily on first use, which is the address bar's open.
    const cacheVersion = Number(fs.readFileSync(path.join(ROOT, 'lib', 'nominatim.js'), 'utf-8').match(/const CACHE_VERSION = (\d+)/)[1]);
    fs.writeFileSync(
      path.join(userDataDir, 'nominatim-cache.json'),
      JSON.stringify({ version: cacheVersion, entries: { 'place:fixture-osaka-a': { label: '過去の地名テスト', error: null } } })
    );

    await step('a detail name fetched in an earlier session is searchable without fetching', async () => {
      await page.click('#btn-search');
      await page.fill('#address-input', '過去の地名');
      await page.waitForFunction(() => document.querySelector('#address-results li') && document.querySelector('#address-results li').textContent.startsWith('滞在地点過去の地名テスト'));
      const calls = await app.evaluate(() => globalThis.__viuGeocodeStub.calls.length);
      assert.strictEqual(calls, 0, 'nothing was requested');
      await page.keyboard.press('Enter');
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.code], ['place', OSAKA_CODE]);
      await page.keyboard.press('Alt+Home');
    });

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

    await step('an unvisited municipality is offered (tagged) and shown on the municipality map of its prefecture', async () => {
      await page.click('#btn-search');
      const results = await typeQuery('那覇');
      assert(results[0].includes('那覇市') && results[0].includes('未訪問'), `${results}`);
      await page.keyboard.press('Enter');
      await settle(page);
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.clusterId, v.params.code], ['place', null, 47]);
      const panel = await page.textContent('#detail-panel-content');
      assert(panel.includes('那覇市') && panel.includes('この期間に訪れた記録はありません'), panel);
      assert((await page.evaluate(() => window.__pathBrowserTest.getMapZoom())).zoom >= 10, 'zoomed to the municipality');
    });

    await step('loosely written dates: 2024年1月20日 and 1/20 find that day', async () => {
      await page.click('#btn-search');
      let results = await typeQuery('2024年1月20日');
      assert.strictEqual(results[0], '日付2024-01-20');
      results = await typeQuery('1/20');
      assert.strictEqual(results[0], '日付2024-01-20');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
    });

    await step('2024年1月 / 2024 switch the period like the header selects', async () => {
      await page.click('#btn-search');
      let results = await typeQuery('2024年1月');
      assert.strictEqual(results[0], '期間2024年1月この期間で表示');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.deepStrictEqual([await page.inputValue('#filter-year'), await page.inputValue('#filter-month')], ['2024', '1']);
      assert.strictEqual((await getView(page)).view, 'national');
      await page.click('#btn-search');
      results = await typeQuery('2024');
      assert.strictEqual(results[0], '期間2024年この期間で表示');
      await page.keyboard.press('Enter');
      await settle(page);
      assert.deepStrictEqual([await page.inputValue('#filter-year'), await page.inputValue('#filter-month')], ['2024', '']);
      await page.selectOption('#filter-year', '');
      await settle(page);
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
      assert.deepStrictEqual(await typeQuery('2024'), ['期間2024年この期間で表示'], 'the period, but no dates');
      assert.deepStrictEqual(await typeQuery('stub'), ['見つかりませんでした']);
      const cached = await page.evaluate(() => window.pathBrowser.getCachedLabels([{ placeId: 'fixture-osaka-a', lat: 0, lng: 0 }]));
      assert.deepStrictEqual(cached, [], 'the main process withholds cached names under privacy mode');
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
