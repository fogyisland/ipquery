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
  // The MCP server is installed as a command, so an operator can point
  // any MCP client at `ipquery-mcp` without knowing where the release
  // directory lives. Without this the release ships a working MCP
  // server that no client can name.
  //
  // The target is the compiled entry, and it carries a `#!/usr/bin/env
  // node` shebang so npm can link it directly.
  bin: src.bin,
  dependencies: src.dependencies,
};

fs.writeFileSync(outPath, JSON.stringify(release, null, 2) + "\n", "utf8");
console.log(
  `[release-manifest] up/package.json written: ` +
    `${Object.keys(release.dependencies).length} runtime dependencies, ` +
    `${Object.keys(release.scripts).length} scripts`,
);

// ── The release lockfile ──────────────────────────────────────────────
//
// `install.sh` runs `npm ci --omit=dev`, and `npm ci` refuses to proceed
// when package.json and package-lock.json disagree about the dependency
// set. The release lockfile used to be a hand-copied snapshot of some
// earlier repo state, so it kept drifting: it still listed `maxmind`
// (dropped from the manifest when the MaxMind parser was removed) and
// lacked `@fastify/multipart` (added for the chunked range upload). The
// result was a release that could not be installed at all — `npm ci`
// exited with EUSAGE before installing anything, so the server never ran
// on a fresh host.
//
// The lockfile is therefore generated here, from the repo's own lock, with
// the root entry's devDependencies removed. One source of truth: the same
// resolved tree the repo builds against, minus the packages the release
// never loads.
const srcLockPath = path.join(root, "package-lock.json");
const outLockPath = path.join(root, "up", "package-lock.json");

const lock = JSON.parse(fs.readFileSync(srcLockPath, "utf8"));
const rootEntry = lock.packages?.[""];
if (!rootEntry) {
  throw new Error(`package-lock.json has no root entry — cannot build the release lock`);
}
// Keep dll entries the release does need: name/version/license/bin/engines
// describe the package itself; only the dev dependency list is dropped
// (npm ci --omit=dev would skip them anyway, but leaving them in the root
// entry invites the "why is esbuild in the lock of a release?" question).
delete rootEntry.devDependencies;

// The manifest above is authoritative for the SET of runtime dependencies.
// A lock entry that disagrees means the two files would fail `npm ci` on a
// fresh host — the exact failure this block exists to prevent — so check
// rather than assume.
const locked = Object.keys(rootEntry.dependencies ?? {}).sort();
const declared = Object.keys(release.dependencies).sort();
const lockedOnly = locked.filter((name) => !declared.includes(name));
const declaredOnly = declared.filter((name) => !locked.includes(name));
if (lockedOnly.length > 0 || declaredOnly.length > 0) {
  throw new Error(
    `the repo lock and package.json disagree: ` +
      `lock-only [${lockedOnly.join(", ")}], package-only [${declaredOnly.join(", ")}] — ` +
      `run \`npm install\` in the repo root and rebuild`,
  );
}

fs.writeFileSync(outLockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
console.log(
  `[release-manifest] up/package-lock.json written: ${locked.length} direct dependencies, ` +
    `${Object.keys(lock.packages).length} packages pinned`,
);
