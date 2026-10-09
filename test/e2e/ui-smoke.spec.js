'use strict';

// Broad smoke test over the UI paths the more targeted specs don't touch —
// added when renderer/app.mjs was split into feature modules, to catch a
// missing import / unmigrated variable anywhere a click can reach. Drives
// everything through real DOM clicks (not __pathBrowserTest shortcuts) and
// fails on any uncaught renderer error along the way.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CLUSTER_A, TOKYO_CODE, near, settle, createStepRunner, launchApp, completeOnboarding, goToPlace } = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const exportPath = path.join(os.tmpdir(), `viu-e2e-export-${process.pid}.png`);
  const { app, page, userDataDir } = await launchApp({ PATHBROWSER_TEST_EXPORT_PATH: exportPath });

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));
  const assertNoErrors = () => assert.deepStrictEqual(pageErrors, [], 'uncaught renderer errors:\n' + pageErrors.join('\n'));

  try {
    await completeOnboarding(page, step);

    await step('layout: no window-level scrollbars, zoom buttons clear of the map badges', async () => {
      const overlaps = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      for (const tab of ['map', 'route']) {
        await page.click(`.tab-btn[data-tab="${tab}"]`);
        await settle(page);
        const m = await page.evaluate(() => {
          const d = document.documentElement;
          const rect = (sel) => {
            const n = document.querySelector(sel);
            if (!n || n.offsetParent === null) return null;
            const r = n.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
          };
          return {
            scrollW: d.scrollWidth, clientW: d.clientWidth, scrollH: d.scrollHeight, clientH: d.clientHeight,
            zoom: rect('#leaflet-map .leaflet-control-zoom'),
            countBadge: rect('#prefecture-count-badge'),
            islandBadge: rect('#island-badge'),
          };
        });
        assert(m.scrollW <= m.clientW && m.scrollH <= m.clientH, `${tab} tab: the window must not scroll (${JSON.stringify(m)})`);
        if (tab === 'map') {
          assert(m.zoom, 'the main map should have zoom buttons');
          assert(!overlaps(m.zoom, m.countBadge), 'zoom buttons must not overlap the count badge');
          assert(!overlaps(m.zoom, m.islandBadge), 'zoom buttons must not overlap the 離島 badge');
        }
      }
      assertNoErrors();
    });

    await step('route tab renders with a legend; clicking a mode toggles it off and on', async () => {
      await page.click('.tab-btn[data-tab="route"]');
      await page.waitForSelector('#route-screen:not([hidden])');
      const item = await page.waitForSelector('#route-legend .legend-item-mode');
      await item.click();
      await page.waitForSelector('#route-legend .legend-item-mode.mode-hidden');
      await page.click('#route-legend .legend-item-mode.mode-hidden');
      assert.strictEqual(await page.$('#route-legend .legend-item-mode.mode-hidden'), null);
      assertNoErrors();
    });

    await step('chronology tab renders and its include-municipalities toggle works', async () => {
      await page.click('.tab-btn[data-tab="chronology"]');
      await page.waitForSelector('#chronology-screen:not([hidden])');
      await page.click('#chronology-include-muni');
      assert((await page.textContent('#chronology-content')).length > 0);
      assertNoErrors();
    });

    await step('stats tab renders; clicking a conquest-rate row jumps to that prefecture map', async () => {
      await page.click('.tab-btn[data-tab="stats"]');
      await page.waitForSelector('#stats-screen:not([hidden])');
      await page.click('#stats-content .rank-list li.place-item[data-code]');
      await page.waitForSelector('#map-screen:not([hidden])');
      const view = await page.evaluate(() => window.__pathBrowserTest.getView());
      assert.strictEqual(view.view, 'prefecture');
      assertNoErrors();
    });

    await step('granularity buttons, back/forward, and breadcrumb navigate without errors', async () => {
      await page.click('.granularity-btn[data-granularity="prefecture"]');
      await page.click('#btn-back');
      await page.click('#btn-forward');
      await page.click('#breadcrumb .crumb[data-index="0"]');
      const view = await page.evaluate(() => window.__pathBrowserTest.getView());
      assert.strictEqual(view.view, 'national');
      assertNoErrors();
    });

    await step('a place detail lists its stay days; clicking one opens the day route view', async () => {
      const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
      const rowA = rows.find((r) => near(r.lat, CLUSTER_A.lat) && near(r.lng, CLUSTER_A.lng));
      await goToPlace(page, { clusterId: rowA.clusterId, muniCode: null, code: TOKYO_CODE });
      await page.click('#detail-panel-content .day-item[data-date]');
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      await page.click('#btn-day-view-close');
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
      assertNoErrors();
    });

    await step('changing the cluster distance re-clusters and returns to the national view', async () => {
      await page.$eval('#cluster-threshold', (input) => {
        input.value = '100';
        input.dispatchEvent(new Event('change'));
      });
      await page.waitForFunction(() => document.getElementById('cluster-threshold-label').textContent === '100m');
      const view = await page.evaluate(() => window.__pathBrowserTest.getView());
      assert.strictEqual(view.view, 'national');
      assertNoErrors();
    });

    await step('PNG export writes a file', async () => {
      await page.click('.tab-btn[data-tab="map"]');
      await page.click('#btn-export-png');
      await page.waitForFunction(() => document.getElementById('btn-export-png').textContent.includes('✅'), null, { timeout: 15000 });
      assert(fs.existsSync(exportPath) && fs.statSync(exportPath).size > 0, 'expected an exported PNG');
      assertNoErrors();
    });

    await step('settings: clicking the zone map then 追加 adds an exclusion zone', async () => {
      await page.click('#btn-settings');
      await page.waitForSelector('#settings-screen:not([hidden])');
      await settle(page);
      // A raw mouse click only lands inside the viewport — on a small screen
      // (CI's macOS runner) the zone map starts below the fold.
      const zoneMap = await page.$('#zone-map');
      await zoneMap.scrollIntoViewIfNeeded();
      await settle(page);
      const box = await zoneMap.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForSelector('#zone-pending:not([hidden])');
      await page.click('#btn-zone-confirm');
      await page.waitForFunction(() => document.querySelectorAll('#zone-list li').length === 1);
      await page.click('#btn-settings-close');
      await page.waitForSelector('#map-screen:not([hidden])');
      assertNoErrors();
    });

    await step('the privacy button toggles privacy mode back on', async () => {
      await page.click('#btn-privacy');
      assert.strictEqual(await page.textContent('#privacy-label'), 'プライバシーモード ON');
      assert(await page.isDisabled('#tab-route'), 'route tab should be disabled under privacy mode');
      assertNoErrors();
    });

    console.log(`\nAll E2E checks passed (${stepNames.length} steps).`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(exportPath, { force: true });
  }
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
