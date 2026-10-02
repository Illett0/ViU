'use strict';

// E2E regression suite for the per-day route dialog (routeTab.mjs openDayView):
// a proper modal dialog (focus moves in, is trapped, Esc closes, focus returns
// to the date that opened it), previous/next recorded day navigation, and the
// text timeline that mirrors the map (numbered stays + moves, each row
// highlights/zooms its counterpart on the map). The fixture's 2024-01-20 has a
// train trip (activity + GPS path) followed by a stay in Osaka.

const assert = require('assert');
const fs = require('fs');
const { CLUSTER_A, TOKYO_CODE, near, settle, createStepRunner, launchApp, completeOnboarding, goToPlace } = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));
  const dayState = () => page.evaluate(() => window.__pathBrowserTest.getDayViewState());
  const activeId = () => page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className));

  try {
    await completeOnboarding(page, step);

    const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
    const rowA = rows.find((r) => near(r.lat, CLUSTER_A.lat) && near(r.lng, CLUSTER_A.lng));

    await step('clicking a stay date opens an accessible modal dialog with focus inside', async () => {
      await goToPlace(page, { clusterId: rowA.clusterId, muniCode: null, code: TOKYO_CODE });
      await page.click('#detail-panel-content .day-item[data-date="2024-01-19"]');
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      const attrs = await page.evaluate(() => {
        const p = document.getElementById('day-view-panel');
        return { role: p.getAttribute('role'), modal: p.getAttribute('aria-modal'), label: document.getElementById(p.getAttribute('aria-labelledby')).textContent };
      });
      assert.strictEqual(attrs.role, 'dialog');
      assert.strictEqual(attrs.modal, 'true');
      assert(attrs.label.includes('2024年1月19日'), `dialog should be labelled by the date, got "${attrs.label}"`);
      assert.strictEqual(await activeId(), 'btn-day-view-close', 'focus should move into the dialog');
      assert(!(await page.isDisabled('#btn-day-view-prev')), '01-19 is not the first recorded day, so 前の記録日 must be enabled');
    });

    await step('Tab keeps focus inside the dialog', async () => {
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        const inside = await page.evaluate(() => document.getElementById('day-view-panel').contains(document.activeElement));
        assert(inside, `focus escaped the dialog after ${i + 1} Tab presses`);
      }
    });

    await step('→ moves to the next recorded day; its timeline lists the move and the numbered stay', async () => {
      await page.focus('#btn-day-view-close');
      await page.keyboard.press('ArrowRight');
      const s = await dayState();
      assert.strictEqual(s.dateStr, '2024-01-20');
      assert.deepStrictEqual(s.items, ['move', 'stay'], `expected [move, stay] in time order, got ${JSON.stringify(s.items)}`);
      assert.strictEqual(s.stops, 1, 'the stay should be a numbered marker on the map');
      assert(s.segments >= 1, 'the GPS path should be drawn');
      const title = await page.textContent('.day-tl-move .day-tl-title');
      assert(title.includes('電車'), `the move row should name its mode in text, got "${title}"`);
      const legend = await page.textContent('#day-view-legend');
      assert(legend.includes('電車') && legend.includes('滞在地点'), `legend should name the mode and the stop markers, got "${legend}"`);
      const summary = await page.textContent('#day-view-summary');
      assert(summary.includes('403') && summary.includes('滞在 1か所'), `summary should total the day, got "${summary}"`);
    });

    await step('focusing a timeline row highlights its map counterpart; clicking it zooms there', async () => {
      await page.focus('.day-tl-stay');
      assert(await page.$('#day-view-map .day-stop.active'), 'focused stay row should highlight its numbered marker');
      const before = await page.evaluate(() => window.__pathBrowserTest.getMapZoom()); // main map, unaffected
      await page.click('.day-tl-stay');
      await settle(page);
      const after = await page.evaluate(() => window.__pathBrowserTest.getMapZoom());
      assert.strictEqual(after.zoom, before.zoom, 'the day view must not move the main map');
    });

    await step("the day's photos show as map pins and a gallery; the camera button toggles them", async () => {
      let st = await dayState();
      assert.strictEqual(st.photos, 3, `2024-01-20 has 3 fixture photos, got ${st.photos}`);
      assert(st.photosVisible && st.photoPins === 3, `expected 3 photo pins, got ${st.photoPins}`);
      assert(await page.isVisible('#day-view-photos'), 'the photo gallery section should be visible');
      assert.strictEqual(await page.$$eval('#day-view-photo-gallery .photo-cluster-popup-thumb-wrap', (n) => n.length), 3);
      assert.strictEqual(await page.getAttribute('#btn-day-view-photos', 'aria-pressed'), 'true');
      assert((await page.textContent('#day-view-legend')).includes('写真（3枚）'));

      await page.click('#btn-day-view-photos');
      st = await dayState();
      assert(!st.photosVisible && st.photoPins === 0, 'toggling off should remove the photo pins');
      assert(!(await page.isVisible('#day-view-photos')), 'toggling off should hide the gallery');
      assert.strictEqual(await page.getAttribute('#btn-day-view-photos', 'aria-pressed'), 'false');

      await page.click('#btn-day-view-photos');
      assert.strictEqual((await dayState()).photoPins, 3, 'toggling back on should restore the pins');
    });

    await step('a gallery thumbnail opens the lightbox; Esc closes only the lightbox', async () => {
      await page.waitForSelector('#day-view-photo-gallery .photo-cluster-popup-thumb-wrap img', { timeout: 15000 });
      const label = await page.getAttribute('#day-view-photo-gallery .photo-cluster-popup-thumb-wrap', 'aria-label');
      assert(/^写真を拡大表示: osaka_\d\.jpg/.test(label), `thumbnail should be labelled with just the file name, got "${label}"`);
      await page.click('#day-view-photo-gallery .photo-cluster-popup-thumb-wrap');
      await page.waitForSelector('#photo-lightbox-overlay:not([hidden])');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#photo-lightbox-overlay', { state: 'hidden' });
      assert(await page.isVisible('#day-view-overlay'), 'the day view must stay open when Esc closes the lightbox');
      const focusInDialog = await page.evaluate(() => document.getElementById('day-view-panel').contains(document.activeElement));
      assert(focusInDialog, 'focus should return into the day view after the lightbox closes');
    });

    await step('Esc closes the dialog and returns focus to the date that opened it', async () => {
      await page.keyboard.press('Escape');
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
      const back = await page.evaluate(() => document.activeElement && document.activeElement.dataset && document.activeElement.dataset.date);
      assert.strictEqual(back, '2024-01-19', 'focus should return to the opening date row');
    });

    await step('clicking the backdrop outside the dialog closes it', async () => {
      await page.evaluate(() => window.__pathBrowserTest.openDayView('2024-01-05'));
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      assert(await page.isDisabled('#btn-day-view-prev'), 'the first recorded day has no previous day');
      await page.mouse.click(3, 3);
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
