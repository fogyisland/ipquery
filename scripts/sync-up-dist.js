#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Sync the deployable copy of the build output into up/.
//
// up/dist/ is a committed, runnable copy of dist/. It exists so that
// the whole up/ directory can be copied to a server and run without
// a compiler, a TypeScript toolchain, or the source tree.
//
// The cost of that convenience is drift: dist/ is regenerated on every
// build, so up/dist/ is stale the moment anyone touches src/. A stale
// up/dist/ is worse than no up/dist/ — it deploys an older version of
// the application and reports success.
//
// So this script is not optional cleanup. It is the mechanism that
// keeps the committed copy honest:
//
//   1. it replaces up/dist/ wholesale (never merges — a merge leaves
//      stale files behind, which is the exact bug scripts/build.js
//      exists to prevent)
//   2. it writes a manifest of every file with its size and SHA-256,
//      so a verifier can prove a deployed copy matches the source
//   3. `npm run check:release` re-verifies the manifest and fails if
//      anything drifted
//
// Usage:
//   node scripts/sync-up-dist.js          # sync
//   node scripts/sync-up-dist.js --check  # verify only, exit 1 on drift

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const sourceDist = path.join(root, "dist");
const targetDist = path.join(root, "up", "dist");
const manifestPath = path.join(root, "up", "dist.manifest.json");

/** Every file under a directory, relative and sorted, so the listing
 *  is deterministic regardless of filesystem enumeration order. */
function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

/** True for files git treats as text and therefore normalizes. The
 *  manifest only needs to agree with git for those; binary files are
 *  stored byte-for-byte and are hashed as-is. */
function isProbablyText(absPath) {
  // A NUL byte in the first 8 KB is the standard heuristic.
  const fd = fs.openSync(absPath, "r");
  try {
    const buf = Buffer.alloc(8192);
    const read = fs.readSync(fd, buf, 0, 8192, 0);
    return buf.subarray(0, read).includes(0) === false;
  } finally {
    fs.closeSync(fd);
  }
}

/** The bytes as git stores them: text files normalized to LF, binary
 *  files unchanged. The manifest describes the repository, not the
 *  working copy. */
function storedBytes(absPath) {
  const raw = fs.readFileSync(absPath);
  if (isProbablyText(absPath)) {
    return Buffer.from(raw.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
  }
  return raw;
}

/** Builds the manifest for a dist/ directory. */
function buildManifest(distDir) {
  const files = listFiles(distDir);
  const entries = {};
  for (const rel of files) {
    const abs = path.join(distDir, rel);
    const bytes = storedBytes(abs);
    entries[rel] = {
      bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return {
    // Version is bumped by hand when the release layout changes, so a
    // manifest from an older layout is rejected rather than silently
    // accepted.
    formatVersion: 1,
    fileCount: files.length,
    totalBytes: Object.values(entries).reduce((sum, e) => sum + e.bytes, 0),
    files: entries,
  };
}

function sync() {
  if (!fs.existsSync(sourceDist)) {
    console.error("[sync-up-dist] dist/ does not exist — run `npm run build` first");
    process.exit(1);
  }

  // Replace wholesale. Copying over the top would leave files that
  // were deleted from src/ behind in the deployed copy.
  fs.rmSync(targetDist, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDist), { recursive: true });
  fs.cpSync(sourceDist, targetDist, { recursive: true });

  const manifest = buildManifest(targetDist);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(
    `[sync-up-dist] up/dist/ synced: ${manifest.fileCount} files, ` +
      `${(manifest.totalBytes / 1024 / 1024).toFixed(1)} MB`,
  );
  console.log(`[sync-up-dist] manifest: ${path.relative(root, manifestPath)}`);

  // The release's own `build` script lives in up/scripts/ and is
  // hand-maintained (like install.sh) rather than generated. This
  // script only syncs dist/, so a rename or a delete would leave
  // up/package.json pointing at a file that is not there — and the
  // release would fail with "Missing script" on the server. Check
  // that the pointer still resolves.
  const releaseManifestPath = path.join(root, "up", "package.json");
  if (fs.existsSync(releaseManifestPath)) {
    const release = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
    for (const [name, command] of Object.entries(release.scripts ?? {})) {
      const scriptFile = command.match(/node\s+(\S+\.js)/)?.[1];
      if (!scriptFile) continue;
      const abs = path.join(root, "up", scriptFile);
      if (!fs.existsSync(abs)) {
        console.error(
          `[sync-up-dist] up/package.json script "${name}" points at ${scriptFile}, ` +
            `which does not exist — the release would fail on the server`,
        );
        process.exit(1);
      }
    }
  }
}

function check() {
  if (!fs.existsSync(targetDist) || !fs.existsSync(manifestPath)) {
    console.error("[sync-up-dist] up/dist/ or its manifest is missing — run `npm run sync:release`");
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.formatVersion !== 1) {
    console.error(`[sync-up-dist] manifest format ${manifest.formatVersion} is not supported`);
    process.exit(1);
  }

  const actual = buildManifest(targetDist);
  const expectedFiles = Object.keys(manifest.files).sort();
  const actualFiles = Object.keys(actual.files).sort();

  const problems = [];

  const missing = expectedFiles.filter((f) => !actualFiles.includes(f));
  const extra = actualFiles.filter((f) => !expectedFiles.includes(f));
  const changed = expectedFiles.filter(
    (f) => actualFiles.includes(f) && actual.files[f].sha256 !== manifest.files[f].sha256,
  );

  for (const f of missing) problems.push(`missing: ${f}`);
  for (const f of extra) problems.push(`unexpected: ${f}`);
  for (const f of changed) problems.push(`modified: ${f}`);

  if (problems.length > 0) {
    console.error(`[sync-up-dist] up/dist/ has drifted from its manifest (${problems.length} problem(s)):`);
    for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
    if (problems.length > 40) {
      console.error(`  … and ${problems.length - 40} more`);
    }
    console.error("[sync-up-dist] run `npm run sync:release` to refresh it");
    process.exit(1);
  }

  console.log(`[sync-up-dist] up/dist/ verified: ${actual.fileCount} files match the manifest`);
}

const checkOnly = process.argv.includes("--check");
if (checkOnly) {
  check();
} else {
  sync();
}
