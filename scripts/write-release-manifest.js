#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Generate the release package.json for up/.
//
// The release directory is not a development tree. It carries the
// compiled application and the dependency manifest, and that is all.
// A verbatim copy of the repo's package.json would drag along dev-only
// scripts (build, test, lint) that cannot work there — there is no
// TypeScript source and no test runner in a release — and would name
// devDependencies the installer never installs.
//
// So the release manifest declares only what the server actually runs.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const srcPath = path.join(root, "package.json");
const outPath = path.join(root, "up", "package.json");

const src = JSON.parse(fs.readFileSync(srcPath, "utf8"));

const release = {
  name: src.name,
  version: src.version,
  description: src.description,
  license: src.license,
  type: src.type,
  engines: src.engines,
  // The release's own entry points, plus a `build` that is a no-op here.
  //
  // `build` exists because the workflow "copy the files, npm install,
  // npm run build, start it" is what people expect, and a missing
  // script fails with a bare "Missing script" that gives no hint about
  // what to do instead. In the release directory `dist/` is ALREADY
  // compiled and shipped, so there is nothing to compile — the script
  // verifies the shipped output instead of regenerating it, and fails
  // loudly if the copy is broken.
  //
  // It is NOT the repo's `node scripts/build.js`: that needs the source
  // tree and a TypeScript toolchain, neither of which the release
  // carries. See docs/source-deploy.md for the source-tree workflow.
  scripts: {
    start: "node dist/cli.js",
    serve: "node dist/cli.js serve",
    build: "node scripts/verify-dist.js",
    migrate: "node dist/cli.js migrate",
    "migrate:status": "node dist/cli.js migrate:status",
    init: "node dist/cli.js init",
    update: "node dist/cli.js update",
    status: "node dist/cli.js status",
    // Development convenience: loads the 50 demo IP ranges. Never run
    // this on a production server — a real install loads the DB-IP
    // library with `update`.
    "seed:demo": "node dist/cli.js seed:demo",
  },
  dependencies: src.dependencies,
};

fs.writeFileSync(outPath, JSON.stringify(release, null, 2) + "\n", "utf8");
console.log(
  `[release-manifest] up/package.json written: ` +
    `${Object.keys(release.dependencies).length} runtime dependencies, ` +
    `${Object.keys(release.scripts).length} scripts`,
);
