'use strict';

// E2E suite for the English UI (issue #22): launches with the language
// pinned to English, walks every main screen checking that no Japanese is left
// in the visible UI apart from municipality names (Japanese by design),
// checks a few key translations including English prefecture names, then
// switches to Japanese and back from the settings screen and checks the
// choice is persisted to userData/settings.json.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { TOKYO_CODE, settle, createStepRunner, launchApp, completeOnboarding, goToPrefecture } = require('./helpers');

// Any CJK left after removing municipality names and OpenStreetMap detail
// names (both stay Japanese by design) is an untranslated string.
const JAPANESE = /[぀-ヿ㐀-鿿！-｠]/;

async function visibleJapanese(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const t = window.__pathBrowserTest;
    const loaded = !document.getElementById('btn-settings').hidden; // shown once a timeline is loaded
    const munis = loaded ? [...t.getMunicipalityAggregates(), ...t.getPassOnlyMunicipalities()] : [];
    // Detail place names fetched from OpenStreetMap are external data too.
    const placeLabels = loaded ? t.getPlaceLabelCache().entries.map(([, e]) => e && e.label).filter(Boolean) : [];
    const muniNames = [...munis.map((m) => m.name), ...placeLabels].sort((a, b) => b.length - a.length);
    const strip = (text) => muniNames.reduce((acc, name) => acc.split(name).join(''), text);
    const texts = [
      ...document.body.innerText.split('\n'),
      ...[...document.querySelectorAll('[title], [aria-label]')]
        .filter((n) => n.offsetParent !== null)
        .flatMap((n) => [n.getAttribute('title'), n.getAttribute('aria-label')]),
    ].filter(Boolean);
    // The language picker names each language in itself on purpose.
    return texts.filter((v) => re.test(strip(v).replace('日本語', '').replace('表示言語 / Language', '')));
  }, JAPANESE.source);
}

async function openTab(page, tab) {
  await page.click(`.tab-btn[data-tab="${tab}"]`);
  await page.waitForSelector(`#${tab === 'map' ? 'map' : tab}-screen:not([hidden])`);
  await settle(page);
}

async function main() {
  const { step, stepNames } = createStepRunner();
  const { app, page, userDataDir } = await launchApp({ PATHBROWSER_TEST_LANG: 'en' });

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));

  try {
    await step('the welcome screen is in English', async () => {
      assert.strictEqual(await page.getAttribute('html', 'lang'), 'en');
      assert.strictEqual((await page.textContent('#btn-open-file-main')).trim(), 'Choose file');
      assert.deepStrictEqual(await visibleJapanese(page), []);
    });

    await completeOnboarding(page, step);

    await step('coverage map: English tabs, badge and prefecture names', async () => {
      assert.strictEqual((await page.textContent('.tab-btn[data-tab="map"]')).trim(), 'Coverage Map');
      assert(/\/ 47 prefectures/.test(await page.textContent('#prefecture-count-badge')));
      await goToPrefecture(page, TOKYO_CODE);
      assert((await page.textContent('#breadcrumb')).includes('Tokyo'));
      const tops = await page.evaluate(() => ['.header-left', '#address-bar', '.header-right'].map((q) => Math.round(document.querySelector(q).getBoundingClientRect().top)));
      assert(Math.max(...tops) - Math.min(...tops) < 10, `the longer English labels must not wrap the header (tops: ${tops})`);
      const panel = await page.textContent('#detail-panel-content');
      assert(panel.includes('Tokyo') && panel.includes('First visit'), panel);
      assert.deepStrictEqual(await visibleJapanese(page), []);
    });

    for (const tab of ['route', 'chronology', 'stats']) {
      await step(`${tab} tab has no untranslated text`, async () => {
        await openTab(page, tab);
        if (tab === 'chronology' && !(await page.isChecked('#chronology-include-muni'))) await page.click('#chronology-include-muni');
        assert.deepStrictEqual(await visibleJapanese(page), []);
      });
    }

    await step('stats and chronology use English labels', async () => {
      const stats = await page.textContent('#stats-content');
      for (const s of ['Total distance', 'Train', 'Most visited places', 'By visits']) assert(stats.includes(s), `missing "${s}"`);
      await openTab(page, 'chronology');
      assert((await page.textContent('#chronology-content')).includes('First visit to Tokyo'));
    });

    await step('the day route dialog is in English', async () => {
      await page.evaluate(() => window.__pathBrowserTest.openDayView('2024-01-20'));
      await page.waitForSelector('#day-view-overlay:not([hidden])');
      await settle(page);
      assert.strictEqual(await page.textContent('#day-view-title'), 'Route for Sat, Jan 20, 2024');
      assert((await page.textContent('#day-view-timeline')).includes('By Train'));
      assert.deepStrictEqual(await visibleJapanese(page), []);
      await page.keyboard.press('Escape');
      await page.waitForSelector('#day-view-overlay', { state: 'hidden' });
    });

    await step('the timelapse overlay is in English', async () => {
      await openTab(page, 'map');
      await page.evaluate(() => window.__pathBrowserTest.startTimelapse());
      await page.waitForSelector('#timelapse-overlay:not([hidden])');
      assert(/^\d{4}-\d{2}$/.test(await page.textContent('#timelapse-period')));
      assert(/prefectures$/.test(await page.textContent('#timelapse-count')));
      await page.evaluate(() => window.__pathBrowserTest.stopTimelapse());
    });

    await step('the history menu, bookmark panel and address bar are in English', async () => {
      await page.click('#btn-history');
      await page.waitForSelector('#history-menu:not([hidden])');
      assert.deepStrictEqual(await visibleJapanese(page), []);
      await page.keyboard.press('Escape');
      await page.click('#btn-bookmarks');
      await page.waitForSelector('#bookmark-panel:not([hidden])');
      assert.deepStrictEqual(await visibleJapanese(page), []);
      await page.keyboard.press('Escape');
      await page.click('#btn-search');
      await page.fill('#address-input', 'to');
      await page.waitForSelector('#address-results:not([hidden])');
      assert((await page.textContent('#address-results')).includes('Tokyo'));
      assert.deepStrictEqual(await visibleJapanese(page), []);
      await page.keyboard.press('Escape');
    });

    await step('the settings screen has no untranslated text', async () => {
      await page.click('#btn-settings');
      await page.waitForSelector('#settings-screen:not([hidden])');
      assert.strictEqual(await page.inputValue('#language-select'), 'en');
      assert.deepStrictEqual(await visibleJapanese(page), []);
    });

    await step('switching to Japanese updates the UI live and is saved', async () => {
      await page.selectOption('#language-select', 'ja');
      await page.waitForFunction(() => document.documentElement.lang === 'ja');
      assert.strictEqual((await page.textContent('#btn-settings-close')).trim(), '閉じる');
      await page.click('#btn-settings-close');
      await openTab(page, 'map');
      assert.strictEqual((await page.textContent('.tab-btn[data-tab="map"]')).trim(), '県制覇マップ');
      await goToPrefecture(page, TOKYO_CODE);
      assert((await page.textContent('#breadcrumb')).includes('東京都'));
      assert((await visibleJapanese(page)).length > 0, 'sanity: the Japanese-text detector must fire on the Japanese UI');
      const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf-8'));
      assert.strictEqual(saved.language, 'ja');
    });

    await step('switching back to English restores the English names', async () => {
      await page.click('#btn-settings');
      await page.selectOption('#language-select', 'en');
      await page.waitForFunction(() => document.documentElement.lang === 'en');
      await page.click('#btn-settings-close');
      await goToPrefecture(page, TOKYO_CODE);
      assert((await page.textContent('#breadcrumb')).includes('Tokyo'));
      assert.deepStrictEqual(await visibleJapanese(page), []);
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
