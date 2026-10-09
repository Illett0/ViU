'use strict';

// E2E suite for issue #37 (browsing UI): the calendar at the top of
// the chronology tab — a per-year heatmap whose recorded days open the day
// view, 「去年の今日」 (the recorded day nearest to one year ago, within a
// week; disabled when there is none) and 「ランダムな1日へ」, all switched off
// under privacy mode where route views are disabled.

const assert = require('assert');
const fs = require('fs');
const { settle, createStepRunner, launchApp, completeOnboarding } = require('./helpers');

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp();

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));

  const recordedDays = () => page.$$eval('#calendar-section button.cal-day', (ns) => ns.map((n) => n.dataset.day));
  const closeDayView = async () => {
    await page.keyboard.press('Escape');
    await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
  };

  try {
    await completeOnboarding(page, step);

    await step('the chronology tab opens with a calendar of the recorded days', async () => {
      await page.click('.tab-btn[data-tab="chronology"]');
      await page.waitForSelector('#calendar-section .cal-grid');
      assert.deepStrictEqual(await page.$$eval('#calendar-section .cal-year h4', (ns) => ns.map((n) => n.textContent)), ['2024年']);
      const days = await recordedDays();
      for (const d of ['2024-01-05', '2024-01-20', '2024-03-20']) assert(days.includes(d), `${d} should be clickable: ${days}`);
      assert(!days.includes('2024-01-06'), 'a day with no records is not clickable');
      // 2024-01-01 is a Monday: second row of the first week column.
      const jan1 = await page.$eval('#calendar-section .cal-grid > :first-child', (n) => n.getAttribute('style'));
      assert(/grid-column:\s*1;\s*grid-row:\s*2/.test(jan1), jan1);
    });

    await step('clicking a recorded day opens its route view', async () => {
      await page.click('#calendar-section .cal-day[data-day="2024-01-20"]');
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      assert((await page.textContent('#day-view-title')).includes('2024年1月20日'));
      await closeDayView();
    });

    await step('「去年の今日」 opens the recorded day nearest to one year ago', async () => {
      await page.evaluate(() => window.__pathBrowserTest.setToday('2025-01-21'));
      const label = await page.textContent('#btn-cal-anniversary');
      assert(label.includes('2024-01-20'), `2024-01-21 has no record; 01-20 is one day off: ${label}`);
      await page.click('#btn-cal-anniversary');
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      assert((await page.textContent('#day-view-title')).includes('2024年1月20日'));
      await closeDayView();
    });

    await step('「去年の今日」 is disabled with no record within a week of it', async () => {
      await page.evaluate(() => window.__pathBrowserTest.setToday('2025-06-15'));
      assert(await page.isDisabled('#btn-cal-anniversary'));
    });

    await step('「ランダムな1日へ」 opens one of the recorded days', async () => {
      const days = await recordedDays();
      await page.click('#btn-cal-random');
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      await settle(page);
      const title = await page.textContent('#day-view-title');
      const m = title.match(/(\d{4})年(\d+)月(\d+)日/);
      const shown = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      assert(days.includes(shown), `${shown} should be a recorded day`);
      await closeDayView();
    });

    await step('privacy mode: the calendar stays but nothing opens a route view', async () => {
      await page.click('#btn-privacy');
      await page.click('.tab-btn[data-tab="chronology"]');
      assert.strictEqual((await recordedDays()).length, 0, 'no clickable days');
      assert(await page.isDisabled('#btn-cal-random'));
      assert(await page.isDisabled('#btn-cal-anniversary'));
      assert((await page.textContent('#calendar-section')).includes('プライバシーモード中'));
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
