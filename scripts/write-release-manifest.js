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
  // The release's own entry points. The repo's scripts assume a source
  // tree and a toolchain, so they are not carried over.
  scripts: {
    start: "node dist/cli.js",
    serve: "node dist/cli.js serve",
    migrate: "node dist/cli.js migrate",
    "migrate:status": "node dist/cli.js migrate:status",
    init: "node dist/cli.js init",
    update: "node dist/cli.js update",
    status: "node dist/cli.js status",
  },
  dependencies: src.dependencies,
};

fs.writeFileSync(outPath, JSON.stringify(release, null, 2) + "\n", "utf8");
console.log(
  `[release-manifest] up/package.json written: ` +
    `${Object.keys(release.dependencies).length} runtime dependencies, ` +
    `${Object.keys(release.scripts).length} scripts`,
);
