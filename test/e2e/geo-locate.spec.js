'use strict';

// E2E regression suite for prefecture/municipality judging (lib/locate.js)
// and the 通過のみ (passed-through-only) municipality tier:
//   - the prefecture is always derived from the municipality, so a point
//     can never be filed under one prefecture while its municipality belongs
//     to another (the two boundary datasets used to be judged independently
//     and disagreed near borders, e.g. 和歌山県紀の川市 judged 大阪府)
//   - coastline/reclaimed-land points that fall outside every simplified
//     municipality polygon snap to the nearest municipality
//   - a municipality touched only by timelinePath points counts as 通過のみ,
//     shown separately, never toward 制覇/制覇率
// The fixture's single timelinePath runs Tokyo -> (35.4, 137.5, 岐阜県中津川市,
// no visits there) -> Osaka.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { ROOT, createStepRunner, launchApp, completeOnboarding } = require('./helpers');

const { locate } = require(path.join(ROOT, 'lib', 'locate'));
const { findPrefecture } = require(path.join(ROOT, 'lib', 'prefectures'));

const PASS_ONLY_POINT = { lat: 35.4, lng: 137.5 };

async function main() {
  const { step, stepNames } = createStepRunner();

  await step('locate(): border point gets the municipality\'s own prefecture, not the other dataset\'s', async () => {
    // Known disagreement between the two boundary datasets (found by random sampling).
    const pt = { lat: 34.34811547154007, lng: 135.4356402320022 };
    const r = locate(pt.lat, pt.lng);
    assert.strictEqual(r.muniCode, '30208', `expected 紀の川市 (30208), got ${r.muniCode}`);
    assert.strictEqual(r.prefCode, 30, 'prefecture must be derived from the municipality (和歌山県=30)');
    const prefPolygon = findPrefecture(pt.lat, pt.lng);
    assert(prefPolygon && prefPolygon.code === 27, 'sanity: the raw prefecture polygon alone still says 大阪府 here, which is the bug being guarded against');
  });

  await step('locate(): reclaimed-land / airport points resolve to a municipality', async () => {
    for (const [name, lat, lng, prefCode] of [
      ['神戸空港', 34.6328, 135.2239, 28],
      ['関西空港', 34.4347, 135.244, 27],
    ]) {
      const r = locate(lat, lng);
      assert(r.muniCode, `${name} should resolve to some municipality`);
      assert.strictEqual(r.prefCode, prefCode, `${name} should be in prefecture ${prefCode}`);
    }
    assert.deepStrictEqual(locate(30.0, 140.0), { muniCode: null, prefCode: 0 }, 'open ocean should stay unresolved');
  });

  const { app, page, userDataDir } = await launchApp();
  try {
    await completeOnboarding(page, step);

    await step('every visit and path point has a prefecture consistent with its municipality', async () => {
      const { visits, pathPoints } = await page.evaluate(() => window.__pathBrowserTest.getRawLocations());
      for (const loc of [...visits, ...pathPoints]) {
        if (!loc.muniCode) continue;
        assert.strictEqual(loc.prefCode, Number(loc.muniCode.slice(0, 2)), `prefCode ${loc.prefCode} disagrees with muniCode ${loc.muniCode}`);
      }
      assert(pathPoints.every((p) => p.muniCode), 'every fixture path point is on land and should resolve to a municipality');
    });

    await step('a municipality only passed through is 通過のみ, not 制覇', async () => {
      const expected = locate(PASS_ONLY_POINT.lat, PASS_ONLY_POINT.lng).muniCode;
      const passOnly = await page.evaluate(() => window.__pathBrowserTest.getPassOnlyMunicipalities());
      const codes = passOnly.map((m) => m.code);
      assert(codes.includes(expected), `expected ${expected} among 通過のみ municipalities, got ${JSON.stringify(codes)}`);
      const visited = await page.evaluate(() => window.__pathBrowserTest.getMunicipalityAggregates());
      assert(!visited.some((m) => m.code === expected), '通過のみ municipality must not count as visited');
      const rates = await page.evaluate(() => window.__pathBrowserTest.getConquestRates());
      const gifu = rates.find((r) => r.code === 21);
      assert.strictEqual(gifu.visited, 0, '岐阜県 has no stays in the fixture, so its 制覇率 numerator must stay 0');
      assert(gifu.passOnly >= 1, '岐阜県 should report at least one 通過のみ municipality');
    });

    await step('the municipality badge shows the 通過のみ count', async () => {
      await page.evaluate(() => window.__pathBrowserTest.setGranularity('municipality'));
      const text = await page.textContent('#prefecture-count-badge');
      assert(/通過のみ\s*\d+/.test(text), `badge should mention 通過のみ, got "${text}"`);
    });

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
