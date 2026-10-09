'use strict';

// E2E suite for the README 動作確認 items that need more than one year of
// data or a deliberately lopsided count-vs-dwell ranking (issue #8):
// year filter + 「この年に初めて訪れた県」, movement stats totals, the
// 回数順/滞在時間順 ranking toggle, chronology (dates, year headings,
// municipality toggle, click-through), back/forward drill-down history,
// cluster-threshold re-ranking, and what privacy mode changes (HOME-area
// exclusion, municipality roll-up, route tab, zoom cap).
//
// Runs against its own fixture, fixtures/timeline.history.json (generated
// for this suite — see the coordinate notes below), not the shared
// timeline.sample.json, so the other specs' exact counts stay untouched.
//
// Several visits deliberately start before 09:00 JST: their UTC date is the
// previous day (and for 2024-01-01 06:00, the previous *year*), which is
// exactly what a UTC-based date formatter gets wrong.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { settle, createStepRunner, launchApp, completeOnboarding, goToPrefecture, goToPlace, getView, near } = require('./helpers');

const HISTORY_FILE = path.join(__dirname, 'fixtures', 'timeline.history.json');

// Must match fixtures/timeline.history.json.
const X = { lat: 35.6812, lng: 139.7671 }; // Tokyo Station (千代田区) — 5 short visits, first one 2024-01-01 06:00 JST
const X2 = { lat: 35.682098, lng: 139.7671 }; // ~100m N of X — 1 visit; merges into X at a 200m cluster distance
const Y = { lat: 35.6896, lng: 139.7006 }; // Shinjuku (新宿区) — 2 long (5h) visits, labelled HOME
const TOKYO = 13;
const OSAKA = 27;

async function statsText(page) {
  await page.click('.tab-btn[data-tab="stats"]');
  await page.waitForSelector('#stats-screen:not([hidden])');
  return page.evaluate(() => {
    const root = document.getElementById('stats-content');
    const cards = [...root.querySelectorAll('.stat-card')].map((c) => ({
      value: c.querySelector('.big-number').textContent,
      caption: c.querySelector('.caption').textContent,
    }));
    const newly = [...root.querySelectorAll('.newly-visited-list li')].map((li) => li.textContent);
    const modes = [...root.querySelectorAll('.mode-table')][0];
    const modeRows = modes ? [...modes.querySelectorAll('tbody tr')].map((tr) => [...tr.cells].map((td) => td.textContent)) : [];
    const lists = [...root.querySelectorAll('ul.rank-list')];
    const ranking = lists[lists.length - 1];
    const rankingRows = [...ranking.querySelectorAll('li')].map((li) => li.textContent);
    return { cards, newly, modeRows, rankingRows };
  });
}

async function selectYear(page, year) {
  await page.selectOption('#filter-year', year == null ? '' : String(year));
}

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp({ PATHBROWSER_TEST_FILE: HISTORY_FILE });

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));

  try {
    await completeOnboarding(page, step);

    await step('the year filter offers both years in the data', async () => {
      const years = await page.$$eval('#filter-year option', (opts) => opts.map((o) => o.value).filter(Boolean));
      assert(years.includes('2023') && years.includes('2024'), `expected 2023 and 2024 in the year filter, got ${years}`);
    });

    await step('movement stats over the whole period: total distance and per-mode breakdown', async () => {
      const s = await statsText(page);
      assert.strictEqual(s.cards[0].value, '380 km');
      assert.strictEqual(s.cards[1].value, '3', 'three activities in total');
      assert.deepStrictEqual(
        s.modeRows.map((r) => [r[0], r[1], r[2]]),
        [['電車', '370 km', '1'], ['バス', '6 km', '1'], ['徒歩', '4 km', '1']]
      );
      assert.strictEqual(s.newly.length, 0, 'no 「初めて訪れた県」 card without a year filter');
    });

    await step('year filter 2024: stats recompute and only Tokyo/Osaka are newly visited (local-time year)', async () => {
      await selectYear(page, 2024);
      const s = await statsText(page);
      assert.strictEqual(s.cards[0].value, '10 km');
      assert.deepStrictEqual(s.newly, ['東京都', '大阪府'], 'Tokyo was first visited 2024-01-01 06:00 JST — that is 2024, not 2023');
    });

    await step('year filter 2023: only Kyoto is newly visited', async () => {
      await selectYear(page, 2023);
      const s = await statsText(page);
      assert.strictEqual(s.cards[0].value, '370 km');
      assert.deepStrictEqual(s.newly, ['京都府']);
      await selectYear(page, null);
    });

    await step('place ranking: 回数順 and 滞在時間順 put different places first', async () => {
      let s = await statsText(page);
      assert(/^1\. 千代田区/.test(s.rankingRows[0]) && s.rankingRows[0].includes('5 回'), `count order: ${s.rankingRows[0]}`);
      await page.click('#stats-content .sort-toggle [data-sort="dwellMs"]');
      s = await statsText(page);
      assert(/^1\. 新宿区/.test(s.rankingRows[0]) && s.rankingRows[0].includes('10時間0分'), `dwell order: ${s.rankingRows[0]}`);
      await page.click('#stats-content .sort-toggle [data-sort="count"]');
    });

    await step('chronology: prefecture first visits in order, dated in local time, under year headings', async () => {
      await page.click('.tab-btn[data-tab="chronology"]');
      await page.waitForSelector('#chronology-screen:not([hidden])');
      if (await page.isChecked('#chronology-include-muni')) await page.click('#chronology-include-muni');
      const c = await page.evaluate(() => ({
        years: [...document.querySelectorAll('#chronology-content .chronology-year-heading')].map((n) => n.textContent),
        items: [...document.querySelectorAll('#chronology-content .chronology-item')].map((n) => n.textContent),
      }));
      assert.deepStrictEqual(c.years, ['2023年', '2024年']);
      assert.strictEqual(c.items.length, 3);
      assert(c.items[0].startsWith('2023-04-10') && c.items[0].includes('京都府'), c.items[0]);
      assert(c.items[1].startsWith('2024-01-01') && c.items[1].includes('東京都'), c.items[1]);
      assert(c.items[2].startsWith('2024-04-05') && c.items[2].includes('大阪府'), c.items[2]);
    });

    await step('chronology: including municipalities adds their first visits', async () => {
      await page.click('#chronology-include-muni');
      const items = await page.$$eval('#chronology-content .chronology-item', (ns) => ns.map((n) => n.textContent));
      for (const name of ['千代田区', '新宿区']) {
        assert(items.some((t) => t.includes('市区町村') && t.includes(name)), `expected a municipality event for ${name}`);
      }
      assert(items.some((t) => t.startsWith('2024-01-01') && t.includes('千代田区')), '千代田区 first visit is 2024-01-01 local time');
      await page.click('#chronology-include-muni');
    });

    await step('chronology: clicking a prefecture event opens that prefecture on the map', async () => {
      await page.click('#chronology-content .chronology-item:has-text("大阪府")');
      await page.waitForSelector('#map-screen:not([hidden])');
      const v = await getView(page);
      assert.strictEqual(v.view, 'prefecture');
      assert.strictEqual(v.params.code, OSAKA);
    });

    let clusterX;
    await step('back/forward walk the drill-down history national → prefecture → place', async () => {
      await page.click('#breadcrumb .crumb[data-index="0"]');
      await goToPrefecture(page, TOKYO);
      const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
      clusterX = rows.find((r) => near(r.lat, X.lat) && near(r.lng, X.lng));
      assert(clusterX && clusterX.count === 5, 'expected the Tokyo Station cluster with 5 visits');
      await goToPlace(page, { clusterId: clusterX.clusterId, muniCode: null, code: TOKYO });

      await page.click('#btn-back');
      let v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.code], ['prefecture', TOKYO]);
      await page.click('#btn-back');
      v = await getView(page);
      assert.strictEqual(v.view, 'national');
      await page.click('#btn-forward');
      await page.click('#btn-forward');
      v = await getView(page);
      assert.deepStrictEqual([v.view, v.params.clusterId], ['place', clusterX.clusterId]);
      assert(await page.isDisabled('#btn-forward'), 'forward should be disabled at the end of history');
    });

    await step('place detail lists stay days, and the prefecture detail first/last visit, in local time', async () => {
      await settle(page);
      const days = await page.$$eval('#detail-panel-content .day-item[data-date]', (ns) => ns.map((n) => n.dataset.date));
      assert.strictEqual(days[0], '2024-01-01', `stay days: ${days}`);
      await page.click('#btn-back');
      await settle(page);
      const text = await page.textContent('#detail-panel-content');
      assert(/最初に訪れた日\s*2024-01-01/.test(text), `expected first visit 2024-01-01, panel says: ${text}`);
      assert(/最後に訪れた日\s*2024-03-17/.test(text), `expected last visit 2024-03-17, panel says: ${text}`);
    });

    await step('raising the cluster distance to 200m merges the nearby spot into the same ranking row', async () => {
      const setThreshold = async (m) => {
        await page.$eval('#cluster-threshold', (input, value) => {
          input.value = String(value);
          input.dispatchEvent(new Event('change'));
        }, m);
        await page.waitForFunction((value) => document.getElementById('cluster-threshold-label').textContent === value + 'm', m);
      };
      const countAt = async (p) => {
        const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
        return rows.filter((r) => near(r.lat, p.lat, 0.002) && near(r.lng, p.lng, 0.002)).map((r) => r.count).sort((a, b) => b - a);
      };
      assert.deepStrictEqual(await countAt(X), [5, 1], 'at 50m Tokyo Station and the spot 100m north are separate');
      await setThreshold(200);
      await page.waitForFunction(() => window.__pathBrowserTest.getClusterRanking().some((r) => r.count === 6));
      assert.deepStrictEqual(await countAt(X), [6]);
      await setThreshold(50);
      await page.waitForFunction(() => window.__pathBrowserTest.getClusterRanking().some((r) => r.count === 5));
    });

    await step('privacy mode: HOME area dropped, ranking rolled up per municipality, route tab off, zoom capped', async () => {
      await page.click('#btn-privacy');
      assert(await page.isDisabled('#tab-route'), 'route tab should be disabled');
      assert.strictEqual(await page.evaluate(() => window.__pathBrowserTest.getMaxZoom()), 12);

      const rows = await page.evaluate(() => window.__pathBrowserTest.getClusterRanking());
      assert(!rows.some((r) => near(r.lat, Y.lat, 0.01) && near(r.lng, Y.lng, 0.01)), 'visits near HOME must not appear');
      const chiyoda = rows.filter((r) => r.muniName === '千代田区');
      assert.strictEqual(chiyoda.length, 1, 'both Tokyo Station spots roll up into one 千代田区 row');
      assert.strictEqual(chiyoda[0].count, 6);

      const s = await statsText(page);
      assert.strictEqual(s.cards[0].value, '370 km', 'the bus/walk legs touching HOME are excluded from stats');
      assert(!s.rankingRows.some((t) => t.includes('新宿区')), 'no 新宿区 row in the privacy ranking');
    });

    await step('turning privacy back off restores the HOME-area data', async () => {
      await page.click('#btn-privacy');
      const s = await statsText(page);
      assert.strictEqual(s.cards[0].value, '380 km');
      assert(await page.isEnabled('#tab-route'));
      assert.strictEqual(await page.evaluate(() => window.__pathBrowserTest.getMaxZoom()), 18);
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
