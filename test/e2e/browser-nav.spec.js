'use strict';

// E2E suite for the browser conventions in renderer/browserNav.mjs (see the
// local design notes, ichikawa/browser.html): every page change is a history
// entry (tab switches, the day view and its day steps included), Alt+←/→,
// the mouse's back/forward buttons and Alt+Home, Ctrl+H / Ctrl+D, a page's
// map view restored on back, visited links, and the link preview bar.

const assert = require('assert');
const fs = require('fs');
const { CLUSTER_A, CLUSTER_B, OSAKA, OSAKA_CODE, TOKYO_CODE, near, settle, createStepRunner, launchApp, completeOnboarding, goToPrefecture, goToPlace, getView } = require('./helpers');

async function dayViewOpen(page) {
  return !(await page.isHidden('#day-view-overlay'));
}

async function dayViewDate(page) {
  const s = await page.evaluate(() => window.__pathBrowserTest.getDayViewState());
  return s && s.dateStr;
}

async function mouseButton(page, button) {
  await page.evaluate((b) => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { button: b, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new MouseEvent('mouseup', { button: b, bubbles: true, cancelable: true }));
  }, button);
  await settle(page);
}

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
    const rowOsaka = rows.find((r) => near(r.lat, OSAKA.lat) && near(r.lng, OSAKA.lng));

    await step('a tab switch is a history entry: back returns to the map tab, forward to the tab', async () => {
      await goToPrefecture(page, TOKYO_CODE);
      await page.click('.tab-btn[data-tab="stats"]');
      assert(!(await page.isHidden('#stats-screen')));
      await page.click('#btn-back');
      assert(!(await page.isHidden('#map-screen')), 'back shows the coverage map again');
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.code], ['prefecture', TOKYO_CODE]);
      await page.click('#btn-forward');
      assert(!(await page.isHidden('#stats-screen')), 'forward shows the stats tab again');
    });

    await step('Alt+← / Alt+→ go back and forward', async () => {
      await page.keyboard.press('Alt+ArrowLeft');
      assert(!(await page.isHidden('#map-screen')));
      await page.keyboard.press('Alt+ArrowRight');
      assert(!(await page.isHidden('#stats-screen')));
    });

    await step('the mouse back/forward buttons go back and forward', async () => {
      await mouseButton(page, 3);
      assert(!(await page.isHidden('#map-screen')));
      await mouseButton(page, 4);
      assert(!(await page.isHidden('#stats-screen')));
    });

    await step('Alt+Home goes to the map of Japan as a new entry', async () => {
      await page.keyboard.press('Alt+Home');
      await settle(page);
      assert(!(await page.isHidden('#map-screen')));
      assert.strictEqual((await getView(page)).view, 'national');
      assert(await page.isEnabled('#btn-back'));
    });

    await step('the day view is a page: a link out of it and back returns to it', async () => {
      await goToPrefecture(page, TOKYO_CODE);
      await goToPlace(page, { clusterId: rowA.clusterId, muniCode: null, code: TOKYO_CODE });
      await page.evaluate(() => window.__pathBrowserTest.openDayView('2024-01-20')); // the Tokyo → Osaka day
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      const links = await page.$$('#day-view-timeline .day-tl-link');
      await links[links.length - 1].click(); // the Osaka stay
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
      assert.strictEqual((await getView(page)).params.clusterId, rowOsaka.clusterId);
      await page.click('#btn-back');
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      assert.strictEqual(await dayViewDate(page), '2024-01-20');
    });

    await step('stepping days pushes entries; Alt+← inside the day view goes back a day', async () => {
      const dates = (await page.evaluate(() => window.__pathBrowserTest.getDayViewState())).dates;
      const next = dates[dates.indexOf('2024-01-20') + 1];
      await page.keyboard.press('ArrowRight');
      assert.strictEqual(await dayViewDate(page), next, 'plain → still steps to the next recorded day');
      await page.keyboard.press('Alt+ArrowLeft');
      await settle(page);
      assert.strictEqual(await dayViewDate(page), '2024-01-20');
    });

    await step('closing the day view is "back" to its page; forward reopens it', async () => {
      await page.keyboard.press('Escape');
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
      const v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.clusterId], ['place', rowA.clusterId], 'back on the stay point the day was opened from');
      assert(await page.isEnabled('#btn-forward'));
      await page.click('#btn-forward');
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      assert.strictEqual(await dayViewDate(page), '2024-01-20');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
    });

    await step('the history list names tab and day-view pages', async () => {
      await page.keyboard.press('Control+h');
      await page.waitForSelector('#history-menu:not([hidden])');
      const labels = await page.$$eval('#history-menu .history-item', (ns) => ns.map((n) => n.textContent));
      assert(labels.includes('移動統計'), JSON.stringify(labels));
      assert(labels.includes('2024-01-20 の1日ビュー'), JSON.stringify(labels));
      await page.keyboard.press('Escape');
      assert(await page.isHidden('#history-menu'));
    });

    await step('visited links: an opened stay point / day is marked, an unopened one is not', async () => {
      await page.click('#btn-back'); // leave the place for its prefecture ranking
      await page.waitForSelector('#detail-panel-content .place-item');
      const v = await getView(page);
      if (v.view !== 'prefecture') await goToPrefecture(page, TOKYO_CODE);
      const cls = (id) => page.$eval(`#detail-panel-content .place-item[data-href="place:${id}"]`, (n) => n.classList.contains('visited'));
      assert.strictEqual(await cls(rowA.clusterId), true, 'cluster A was opened');
      assert.strictEqual(await cls(rowB.clusterId), false, 'cluster B was not');
    });

    await step('hovering a link previews where it goes', async () => {
      await page.hover(`#detail-panel-content .place-item[data-href="place:${rowB.clusterId}"]`);
      await page.waitForSelector('#link-status:not([hidden])');
      const text = await page.textContent('#link-status');
      assert(/^→ 東京都 › .*千代田区/.test(text), text);
      await page.hover('#app-header h1');
      await page.waitForSelector('#link-status', { state: 'hidden' });
    });

    await step('back restores the map view a page was left with', async () => {
      await page.evaluate(() => window.__pathBrowserTest.setMapView(35.70, 139.70, 13));
      await settle(page);
      await goToPrefecture(page, OSAKA_CODE);
      assert.notStrictEqual((await page.evaluate(() => window.__pathBrowserTest.getMapZoom())).zoom, 13);
      await page.click('#btn-back');
      await settle(page);
      const state = await page.evaluate(() => window.__pathBrowserTest.getMapZoom());
      assert.strictEqual(state.zoom, 13);
      assert(Math.abs(state.center.lat - 35.7) < 0.001 && Math.abs(state.center.lng - 139.7) < 0.001, JSON.stringify(state.center));
    });

    await step('Ctrl+D opens the bookmark panel; in the day view it saves the day right away', async () => {
      await page.keyboard.press('Control+d');
      await page.waitForSelector('#bookmark-panel:not([hidden])');
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__pathBrowserTest.openDayView('2024-01-20'));
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      await page.keyboard.press('Control+d');
      await page.waitForSelector('#toast:not([hidden])');
      const saved = JSON.parse(fs.readFileSync(require('path').join(userDataDir, 'bookmarks.json'), 'utf-8'));
      const b = saved[saved.length - 1];
      assert.strictEqual(b.day, '2024-01-20');
      assert.strictEqual(b.name, '2024-01-20 の1日ビュー');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
    });

    await step('opening a day-view bookmark opens that day', async () => {
      await page.keyboard.press('Alt+Home');
      await page.click('#btn-bookmarks');
      await page.click('#bookmark-list .bookmark-open:has-text("2024-01-20 の1日ビュー")');
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      assert.strictEqual(await dayViewDate(page), '2024-01-20');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
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
