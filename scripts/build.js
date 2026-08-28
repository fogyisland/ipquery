#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Single-step build: clean stale dist, then tsc emit, then copy runtime assets.
//
// Why: `tsc` doesn't delete files from its outDir that no longer exist in the
// source tree (e.g. when a partial moves from views/marketing/ to
// views/partials/marketing/, the old dist copy lingers). Handlebars'
// `{{> name}}` resolver silently falls back to reading files from the view
// root, so a stale dist copy can mask the new partial and render the wrong
// template. Cleaning dist/ before each build prevents that whole class of
// stale-file regressions.

const { execSync } = require('node:child_process');
const { rmSync, existsSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

if (existsSync(dist)) {
  rmSync(dist, { recursive: true, force: true });
  console.log('[build] cleaned dist/');
}

execSync('npx tsc -p tsconfig.json', { stdio: 'inherit', cwd: root });
execSync('node scripts/copy-schema.js', { stdio: 'inherit', cwd: root });
console.log('[build] OK');
