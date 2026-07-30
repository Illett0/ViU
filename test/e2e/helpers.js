'use strict';

// Shared setup for the test/e2e/*.spec.js suite (issue #25, expanded per
// issue #8) — launching the real Electron app against the synthetic
// timeline.sample.json/fixtures/photos fixture, driving it through
// onboarding to the map screen, and small helpers every spec needs
// (near-equality, real lat/lng -> page-pixel conversion, a step runner).
// Each *.spec.js file is still its own independently-runnable plain Node
// script (assert + non-zero exit on failure, see CLAUDE.md) — this module
// only removes the boilerplate duplication between them.

const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { _electron: electron } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE_FILE = path.join(__dirname, 'fixtures', 'timeline.sample.json');
const PHOTO_FOLDER = path.join(__dirname, 'fixtures', 'photos');

// Must match test/e2e/fixtures/timeline.sample.json and fixtures/photos/*.json exactly.
const CLUSTER_A = { lat: 35.6812000, lng: 139.7671000 }; // Tokyo Station area — 10 visits, also a GPS photo (issue #23)
const CLUSTER_B = { lat: 35.6820980, lng: 139.7671000 }; // ~100m N of A — 2 visits, distinct cluster (>50m threshold) that visually overlaps A at prefecture zoom
const OSAKA = { lat: 34.7024850, lng: 135.4959510 }; // Osaka Station area — 3 visits. The fixture's 3-photo cluster (issue #24) sits ~6km away, not on this point — see fixtures/photos/osaka_*.jpg.json.
const TOKYO_BACKDROP = { lat: 35.6896, lng: 139.6917 }; // Shinjuku — well inside Tokyo, several km from either cluster marker

const TOKYO_CODE = 13;
const OSAKA_CODE = 27;

function near(a, b, eps = 0.0005) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < eps;
}

// Plain haversine, mirroring renderer/aggregate.mjs's distanceMeters — spec
// files have no access to renderer internals beyond page.evaluate, so this
// keeps its own tiny copy just for sanity-checking real-world distances.
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Leaflet's default zoom/pan animation runs ~250ms. `latLngToContainerPoint`
// (what latLngToPoint below wraps) reflects the map's *target* state
// immediately/synchronously on setView/panTo, but the visual DOM position a
// real mouse click needs to land on takes that long to catch up. This is a
// bounded wait tied to that known, documented animation duration (plus
// margin) — not a blind arbitrary sleep — so a click computed from the
// settled coordinates doesn't race a still-animating marker/pane.
async function settle(page) {
  await page.waitForTimeout(400);
}

async function goToPrefecture(page, code) {
  await page.evaluate((c) => window.__pathBrowserTest.goToPrefecture(c), code);
  await settle(page);
}

async function goToPlace(page, params) {
  await page.evaluate((p) => window.__pathBrowserTest.goToPlace(p), params);
  await settle(page);
}

async function latLngToPoint(page, coords) {
  const pt = await page.evaluate(({ lat, lng }) => window.__pathBrowserTest.latLngToPoint(lat, lng), coords);
  assert(pt, `latLngToPoint(${coords.lat}, ${coords.lng}) returned null — map not ready?`);
  return pt;
}

async function getView(page) {
  return page.evaluate(() => window.__pathBrowserTest.getView());
}

function createStepRunner() {
  const stepNames = [];
  async function step(name, fn) {
    process.stdout.write('- ' + name + ' ... ');
    await fn();
    stepNames.push(name);
    console.log('OK');
  }
  return { step, stepNames };
}

// Launches the real app against the shared fixture in an isolated userData
// dir. Caller owns cleanup (app.close() + rmSync(userDataDir)) in a finally
// block — see any *.spec.js's main() for the pattern.
async function launchApp(extraEnv = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathbrowser-e2e-'));
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      PATHBROWSER_TEST_FILE: FIXTURE_FILE,
      PATHBROWSER_TEST_PHOTO_FOLDER: PHOTO_FOLDER,
      PATHBROWSER_TEST_USERDATA: userDataDir,
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('#btn-open-file-main', { state: 'visible', timeout: 30000 });

  // Nice-to-have (issue #25): keep the real Electron window from visibly
  // popping up on screen during the run. Best-effort — not fatal if it
  // fails on some platform/window-manager combination.
  try {
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) win.setPosition(-32000, -32000);
    });
  } catch (err) {
    console.warn('  (could not reposition window off-screen, continuing anyway: ' + err.message + ')');
  }

  return { app, page, userDataDir };
}

// Drives the shared onboarding flow (file already "picked" via the
// PATHBROWSER_TEST_FILE env var) through to the map screen with privacy mode
// off — every spec needs this same sequence before its own scenario-specific
// steps. Takes the caller's own `step` so each spec's console output stays
// self-contained.
async function completeOnboarding(page, step) {
  await step('open the sample timeline file', async () => {
    await page.click('#btn-open-file-main');
    await page.waitForSelector('#btn-privacy-notice-continue', { state: 'visible', timeout: 30000 });
  });

  await step('continue past the privacy notice into settings', async () => {
    await page.click('#btn-privacy-notice-continue');
    await page.waitForSelector('#btn-link-photo-folder', { state: 'visible' });
  });

  await step('link the fixture photo folder and wait for the scan to finish', async () => {
    await page.click('#btn-link-photo-folder');
    await page.waitForFunction(
      () => {
        const el = document.getElementById('photo-scan-summary');
        return !!(el && el.textContent && el.textContent.includes('枚中'));
      },
      { timeout: 30000 }
    );
  });

  await step('close settings, land on the map, and disable privacy mode', async () => {
    await page.click('#btn-settings-goto-map');
    await page.waitForSelector('#map-screen:not([hidden])');
    // Privacy mode defaults ON (state.mjs) and rolls the ranking up to
    // one row per municipality — most scenarios need the per-cluster
    // rows/pins/exact coordinates instead.
    await page.evaluate(() => window.__pathBrowserTest.setPrivacy(false));
  });
}

module.exports = {
  ROOT,
  FIXTURE_FILE,
  PHOTO_FOLDER,
  CLUSTER_A,
  CLUSTER_B,
  OSAKA,
  TOKYO_BACKDROP,
  TOKYO_CODE,
  OSAKA_CODE,
  near,
  distanceMeters,
  settle,
  goToPrefecture,
  goToPlace,
  latLngToPoint,
  getView,
  createStepRunner,
  launchApp,
  completeOnboarding,
};
