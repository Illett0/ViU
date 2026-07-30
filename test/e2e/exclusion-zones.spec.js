'use strict';

// E2E regression suite for exclusion zones (renderer/aggregate.mjs's
// applyExclusionZones + isInAnyZone, wired up in renderer/app.mjs) — the
// privacy feature that lets a user "pretend a place never happened" for
// rankings/pins/routes without disturbing prefecture/municipality
// visited-status or aggregate totals. See test/e2e/helpers.js for the
// shared launch/onboarding/fixture setup this builds on.
//
// Uses the __pathBrowserTest.addZone/clearZones hooks directly rather than
// drawing a circle via the real settings-screen map click — unlike the
// click-handling suite, what's under test here is the *filtering logic*
// (does an excluded visit disappear from ranking while the aggregate count
// stays put), not map click/pane z-order, so driving it through the hook is
// the more direct and less flaky way to set up the scenario.

const assert = require('assert');
const fs = require('fs');
const { CLUSTER_A, CLUSTER_B, OSAKA, TOKYO_CODE, near, createStepRunner, launchApp, completeOnboarding } = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();

  try {
    await completeOnboarding(page, step);

    const rowsBefore = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
    const rowA = rowsBefore.find((r) => near(r.lat, CLUSTER_A.lat) && near(r.lng, CLUSTER_A.lng));
    const rowB = rowsBefore.find((r) => near(r.lat, CLUSTER_B.lat) && near(r.lng, CLUSTER_B.lng));
    const rowOsaka = rowsBefore.find((r) => near(r.lat, OSAKA.lat) && near(r.lng, OSAKA.lng));
    assert(rowA && rowA.count === 10, 'expected cluster A (count 10) in ranking before any zone is added');
    assert(rowB && rowB.count === 2, 'expected cluster B (count 2) in ranking before any zone is added');
    assert(rowOsaka && rowOsaka.count === 3, 'expected the Osaka cluster (count 3) in ranking before any zone is added');

    const tokyoBefore = (await page.evaluate(() => window.__pathBrowserTest.getVisitedPrefectures())).find((p) => p.code === TOKYO_CODE);
    assert(tokyoBefore && tokyoBefore.stayCount > 0, 'expected Tokyo to already show visits before any zone is added');

    // ---- Adding a zone over cluster A removes exactly that cluster from
    // the ranking — a 50m radius covers A (0m away) but not B (~100m away,
    // a distinct cluster per lib/cluster.js's own >50m clustering threshold)
    // or the unrelated Osaka cluster ----
    await step('adding an exclusion zone over cluster A removes only that cluster from the ranking', async () => {
      await page.evaluate(({ lat, lng }) => window.__pathBrowserTest.addZone(lat, lng, 50), CLUSTER_A);

      const rowsAfter = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
      const stillA = rowsAfter.find((r) => near(r.lat, CLUSTER_A.lat) && near(r.lng, CLUSTER_A.lng));
      const stillB = rowsAfter.find((r) => near(r.lat, CLUSTER_B.lat) && near(r.lng, CLUSTER_B.lng));
      const stillOsaka = rowsAfter.find((r) => near(r.lat, OSAKA.lat) && near(r.lng, OSAKA.lng));

      assert(!stillA, 'cluster A should have disappeared from the ranking once zoned out');
      assert(stillB && stillB.count === 2, 'cluster B (a distinct, ~100m-away cluster) should be unaffected by a zone centered on cluster A');
      assert(stillOsaka && stillOsaka.count === 3, 'the unrelated Osaka cluster should be unaffected');
    });

    // ---- ...but the prefecture's own visited-status/aggregate stayCount
    // must NOT change — exclusion zones are spec'd to only touch display
    // surfaces (ranking/pins/routes/visit lists), not the totals, so a
    // zoned-out visit doesn't leave an unexplained gap in the stats ----
    await step("the zoned-out visit still counts toward Tokyo's aggregate stayCount", async () => {
      const tokyoAfter = (await page.evaluate(() => window.__pathBrowserTest.getVisitedPrefectures())).find((p) => p.code === TOKYO_CODE);
      assert(tokyoAfter, 'expected Tokyo to still be present in the visited-prefectures aggregate');
      assert.strictEqual(
        tokyoAfter.stayCount,
        tokyoBefore.stayCount,
        `Tokyo's aggregate stayCount should be unchanged by the exclusion zone (before=${tokyoBefore.stayCount}, after=${tokyoAfter.stayCount})`
      );
    });

    // ---- Removing the zone restores the ranking exactly ----
    await step('clearing zones restores cluster A to the ranking', async () => {
      await page.evaluate(() => window.__pathBrowserTest.clearZones());
      const rowsRestored = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
      const restoredA = rowsRestored.find((r) => near(r.lat, CLUSTER_A.lat) && near(r.lng, CLUSTER_A.lng));
      assert(restoredA && restoredA.count === 10, 'expected cluster A back in the ranking with its full count after clearing zones');
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
