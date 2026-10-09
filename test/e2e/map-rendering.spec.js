'use strict';

// E2E suite for the README 動作確認 map-rendering items (issue #8):
// prefectures with remote islands fit to their mainland only (Tokyo /
// Kagoshima / Okinawa), and the choropleth/pin coloring — fill opacity
// dropping once pins are on top, only the selected prefecture getting the
// thick orange border (checked both on the Leaflet style options and on the
// actual SVG attributes), and pins drawn orange with a white outline.

const assert = require('assert');
const fs = require('fs');
const { TOKYO_CODE, OSAKA_CODE, createStepRunner, launchApp, completeOnboarding, goToPrefecture } = require('./helpers');

const KAGOSHIMA_CODE = 46;
const OKINAWA_CODE = 47;
const ORANGE = '#ff7f0e';
const DEFAULT_BORDER = '#151820';

async function svgPaths(page, paneSelector) {
  return page.$$eval(`${paneSelector} path`, (paths) =>
    paths.map((p) => ({
      stroke: p.getAttribute('stroke'),
      strokeWidth: p.getAttribute('stroke-width'),
      fill: p.getAttribute('fill'),
      fillOpacity: p.getAttribute('fill-opacity'),
    }))
  );
}

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));

  try {
    await completeOnboarding(page, step);

    await step('national view: every prefecture has the default border at full fill opacity; visited ones are filled differently', async () => {
      const styles = await page.evaluate(() => window.__pathBrowserTest.getPrefectureStyles());
      assert.strictEqual(Object.keys(styles).length, 47);
      for (const [code, s] of Object.entries(styles)) {
        assert.deepStrictEqual([s.color, s.weight, s.fillOpacity], [DEFAULT_BORDER, 1, 0.7], `prefecture ${code}: ${JSON.stringify(s)}`);
      }
      assert.notStrictEqual(styles[TOKYO_CODE].fillColor, styles[OKINAWA_CODE].fillColor, 'visited Tokyo vs unvisited Okinawa');

      const paths = await svgPaths(page, '#leaflet-map .leaflet-overlay-pane');
      assert(paths.length >= 47, `expected the choropleth SVG paths, got ${paths.length}`);
      assert(!paths.some((p) => p.stroke === ORANGE), 'no orange border before a prefecture is selected');
      assert(paths.every((p) => p.fillOpacity === '0.7'));
    });

    await step('prefecture view: only the selected prefecture gets the thick orange border; fill dims under pins', async () => {
      await goToPrefecture(page, TOKYO_CODE);
      const styles = await page.evaluate(() => window.__pathBrowserTest.getPrefectureStyles());
      assert.deepStrictEqual([styles[TOKYO_CODE].color, styles[TOKYO_CODE].weight], [ORANGE, 3]);
      const others = Object.entries(styles).filter(([code]) => Number(code) !== TOKYO_CODE);
      assert(others.every(([, s]) => s.color === DEFAULT_BORDER && s.weight === 1));
      assert(Object.values(styles).every((s) => s.fillOpacity === 0.4));

      const paths = await svgPaths(page, '#leaflet-map .leaflet-overlay-pane');
      const orange = paths.filter((p) => p.stroke === ORANGE);
      assert.strictEqual(orange.length, 1, 'exactly one SVG path has the orange border');
      assert.strictEqual(orange[0].strokeWidth, '3');
      assert(paths.every((p) => p.fillOpacity === '0.4'));
    });

    await step('stay-point pins are orange with a white outline', async () => {
      const pins = await svgPaths(page, '#leaflet-map .leaflet-clusterMarker-pane');
      assert(pins.length >= 2, `expected the Tokyo cluster pins, got ${pins.length}`);
      for (const p of pins) assert.deepStrictEqual([p.fill, p.stroke], [ORANGE, '#ffffff']);
    });

    await step('switching prefecture moves the orange border with it', async () => {
      await goToPrefecture(page, OSAKA_CODE);
      const styles = await page.evaluate(() => window.__pathBrowserTest.getPrefectureStyles());
      assert.strictEqual(styles[OSAKA_CODE].color, ORANGE);
      assert.strictEqual(styles[TOKYO_CODE].color, DEFAULT_BORDER);
    });

    // Remote islands sit far outside each mainland bbox (Ogasawara ~27°N,
    // Amami ~28°N, Ishigaki ~24°N) — fitting to the whole multipolygon would
    // pull the view's southern edge down to them.
    for (const [code, name, minSouth, island] of [
      [TOKYO_CODE, 'Tokyo', 35.0, { lat: 27.09, lng: 142.19 }],
      [KAGOSHIMA_CODE, 'Kagoshima', 30.0, { lat: 28.37, lng: 129.49 }],
      [OKINAWA_CODE, 'Okinawa', 25.5, { lat: 24.34, lng: 124.16 }],
    ]) {
      await step(`${name} fits to its mainland, not its remote islands`, async () => {
        await goToPrefecture(page, code);
        const b = await page.evaluate(() => window.__pathBrowserTest.getMapBounds());
        assert(b.south > minSouth, `${name} view reaches down to ${b.south}°N`);
        const containsIsland = island.lat >= b.south && island.lat <= b.north && island.lng >= b.west && island.lng <= b.east;
        assert(!containsIsland, `${name} view should not include the remote island at ${island.lat},${island.lng}`);
      });
    }

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
