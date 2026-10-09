'use strict';

// E2E regression suite for the post-install launch (build/installer.nsh +
// main.js consumeQuietLaunchMarker): a launch right after installing/updating
// must come up minimized and unfocused so it doesn't interrupt whatever app
// the user is working in, while a normal launch still shows the window.
// PATHBROWSER_TEST_QUIET_LAUNCH stands in for the installer's marker file.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { _electron: electron } = require('playwright');
const { ROOT, createStepRunner } = require('./helpers');

async function launch(extraEnv) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathbrowser-e2e-'));
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, PATHBROWSER_TEST_USERDATA: userDataDir, ...extraEnv } });
  const page = await app.firstWindow();
  await page.waitForSelector('#btn-open-file-main', { state: 'attached', timeout: 30000 });
  return { app, userDataDir };
}

async function windowState(app) {
  // ready-to-show fires shortly after first paint; poll until the window has been shown/minimized.
  for (let i = 0; i < 50; i++) {
    const s = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused() };
    });
    if (s.visible || s.minimized) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('window never became visible or minimized');
}

async function main() {
  const { step, stepNames } = createStepRunner();

  await step('a post-install launch starts minimized without taking focus', async () => {
    const { app, userDataDir } = await launch({ PATHBROWSER_TEST_QUIET_LAUNCH: '1' });
    try {
      const s = await windowState(app);
      assert(s.minimized, `expected a minimized window, got ${JSON.stringify(s)}`);
      assert(!s.focused, `the window must not take focus, got ${JSON.stringify(s)}`);
    } finally {
      await app.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  await step('a normal launch still shows the window normally', async () => {
    const { app, userDataDir } = await launch({});
    try {
      const s = await windowState(app);
      assert(s.visible && !s.minimized, `expected a normally shown window, got ${JSON.stringify(s)}`);
    } finally {
      await app.close().catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  console.log(`\nAll E2E checks passed (${stepNames.length} steps).`);
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err && err.stack ? err.stack : err);
  process.exit(1);
});
