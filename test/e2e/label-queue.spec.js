'use strict';

// E2E suite for the on-demand detail-name queue (issue #26, renderer/labels.mjs):
// only ranking rows actually scrolled into view get fetched, scrolling queues
// the newly visible ones, leaving the panel discards what hasn't started yet,
// and already-fetched names are kept and reused without another request.
//
// Detail names come from main.js's PATHBROWSER_TEST_GEOCODE_STUB (never the
// real Nominatim/Overpass); this spec reads the stub's call log and changes
// its delay from the main process via app.evaluate.
//
// Needs a ranking far longer than the detail panel, so it writes its own
// throwaway fixture — 40 distinct places spread over central Tokyo — to a
// temp dir at startup instead of adding a large file to fixtures/.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TOKYO_CODE, settle, createStepRunner, launchApp, completeOnboarding, goToPrefecture } = require('./helpers');

const PLACE_COUNT = 40;

function writeFixture(dir) {
  const segments = [];
  let day = 1;
  for (let i = 0; i < PLACE_COUNT; i++) {
    const lat = 35.66 + 0.015 * (i % 5);
    const lng = 139.64 + 0.02 * Math.floor(i / 5);
    const latLng = `${lat.toFixed(7)}°, ${lng.toFixed(7)}°`;
    const date = new Date(Date.UTC(2024, 0, 1) + day++ * 86400000).toISOString().slice(0, 10);
    segments.push({
      startTime: `${date}T12:00:00.000+09:00`,
      endTime: `${date}T13:00:00.000+09:00`,
      startTimeTimezoneUtcOffsetMinutes: 540,
      visit: { probability: 0.9, topCandidate: { placeId: `fixture-label-${i}`, placeLocation: { latLng } } },
    });
  }
  const file = path.join(dir, 'timeline.labels.json');
  fs.writeFileSync(file, JSON.stringify({ semanticSegments: segments, userLocationProfile: {} }));
  return file;
}

async function main() {
  const { step, stepNames } = createStepRunner();
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viu-e2e-labels-'));
  const { app, page, userDataDir } = await launchApp({ PATHBROWSER_TEST_FILE: writeFixture(fixtureDir) });

  const stub = () => app.evaluate(() => ({ calls: globalThis.__viuGeocodeStub.calls.length, delayMs: globalThis.__viuGeocodeStub.delayMs }));
  const setDelay = (ms) => app.evaluate((_electron, v) => { globalThis.__viuGeocodeStub.delayMs = v; }, ms);
  const cache = () => page.evaluate(() => window.__pathBrowserTest.getPlaceLabelCache());
  const statuses = (c) => c.entries.map(([, e]) => e.status);
  const settled = () =>
    page.waitForFunction(() => {
      const c = window.__pathBrowserTest.getPlaceLabelCache();
      return c.queueLength === 0 && !c.running && c.entries.every(([, e]) => e.status !== 'pending');
    }, null, { timeout: 30000 });
  const rowTexts = () => page.$$eval('#detail-panel-content .detail-name[data-cluster-id]', (ns) => ns.map((n) => n.textContent));

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));

  try {
    await completeOnboarding(page, step);

    await step('the fixture produces a ranking much longer than the panel', async () => {
      const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
      assert(rows.length >= 20, `expected many Tokyo places, got ${rows.length}`);
      assert.strictEqual((await stub()).calls, 0, 'nothing fetched before a prefecture is opened');
    });

    await step('leaving the panel discards queued fetches; only the one in flight completes', async () => {
      await setDelay(1500);
      await goToPrefecture(page, TOKYO_CODE);
      await page.waitForFunction(() => window.__pathBrowserTest.getPlaceLabelCache().queueLength > 0);
      const before = await cache();
      assert(statuses(before).filter((s) => s === 'pending').length > 1, 'several visible rows should be queued');
      await page.click('#breadcrumb .crumb[data-index="0"]');
      const after = await cache();
      assert.strictEqual(after.queueLength, 0, 'the queue is emptied on leaving');
      await settled();
      const done = statuses(await cache());
      assert.strictEqual(done.length, 1, `only the in-flight fetch should be kept, cache: ${done}`);
      assert.strictEqual(done[0], 'done');
      assert.strictEqual((await stub()).calls, 1, 'discarded rows must never be requested');
    });

    let visibleFetched;
    await step('reopening fetches only the rows in view and shows "detail (municipality)"', async () => {
      await setDelay(50);
      await goToPrefecture(page, TOKYO_CODE);
      await page.waitForFunction(() => window.__pathBrowserTest.getPlaceLabelCache().size > 1);
      await settled();
      const c = await cache();
      visibleFetched = c.size;
      const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
      assert(visibleFetched < rows.length, `only visible rows should be fetched (${visibleFetched} of ${rows.length})`);
      assert.strictEqual((await stub()).calls, visibleFetched, 'the row fetched earlier is reused, not requested again');
      const texts = await rowTexts();
      assert(/^stub [\d.]+,[\d.]+（.+）$/.test(texts[0]), `first row should show the fetched name: ${texts[0]}`);
      assert(texts[texts.length - 1].endsWith('（取得中…）'), `an off-screen row stays unfetched: ${texts[texts.length - 1]}`);
    });

    await step('scrolling to the bottom queues the newly visible rows', async () => {
      await page.$eval('#detail-panel', (p) => { p.scrollTop = p.scrollHeight; });
      await page.waitForFunction((n) => window.__pathBrowserTest.getPlaceLabelCache().size > n, visibleFetched);
      await settled();
      const texts = await rowTexts();
      assert(texts[texts.length - 1].startsWith('stub '), `last row should now be fetched: ${texts[texts.length - 1]}`);
    });

    await step('revisiting shows cached names immediately without new requests', async () => {
      const { calls } = await stub();
      await page.click('#breadcrumb .crumb[data-index="0"]');
      await goToPrefecture(page, TOKYO_CODE);
      await settle(page);
      const texts = await rowTexts();
      assert(texts[0].startsWith('stub '), 'cached name is shown right away');
      assert.strictEqual((await stub()).calls, calls, 'no new requests for already-fetched rows');
    });

    assert.deepStrictEqual(pageErrors, [], 'uncaught renderer errors:\n' + pageErrors.join('\n'));
    console.log(`\nAll E2E checks passed (${stepNames.length} steps).`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
