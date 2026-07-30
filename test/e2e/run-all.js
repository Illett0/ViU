'use strict';

// Runs every test/e2e/*.spec.js file in its own child process (each spec is
// a fully standalone script — see helpers.js/CLAUDE.md — with its own
// Electron launch/teardown), stopping at the first failure. `npm run test:e2e`
// invokes this instead of a single hardcoded spec file so new suites (issue
// #8: incrementally growing E2E coverage) just need to land as another
// test/e2e/*.spec.js file, no changes here or in package.json required.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const specs = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.spec.js'))
  .sort();

if (specs.length === 0) {
  console.error('no test/e2e/*.spec.js files found');
  process.exit(1);
}

for (const spec of specs) {
  console.log(`\n=== ${spec} ===`);
  const result = spawnSync(process.execPath, [path.join(DIR, spec)], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n${spec} FAILED (exit code ${result.status})`);
    process.exit(result.status || 1);
  }
}

console.log(`\nAll ${specs.length} E2E spec files passed.`);
