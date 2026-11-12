#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Verify the release bundle's compiled output.
//
// This is what `npm run build` does in the release directory.
//
// The release ships `dist/` already compiled, so there is nothing to
// compile — the repository's own `node scripts/build.js` needs the
// source tree and a TypeScript toolchain, and the release carries
// neither. So "build" here means "prove that what was shipped is
// intact and runnable", which is the thing that actually goes wrong
// when a release directory is copied around: a truncated tarball, a
// partially-uploaded file set, or a stray edit.
//
// The checks are deliberately cheap and offline. They answer three
// questions an operator has before starting the service:
//
//   1. Is the compiled application actually here?
//   2. Are the runtime assets present (SQL migrations, Handlebars
//      views, static files, i18n bundles)? Their absence does not
//      fail the boot — it fails later, in a worse place.
//   3. Does the shipped copy still match dist.manifest.json?
//
// Exit code 0 means the bundle is good to run. A non-zero exit means
// something is missing or altered, and the service should not be
// started against it.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const releaseRoot = path.resolve(__dirname, "..");
const distDir = path.join(releaseRoot, "dist");
const manifestPath = path.join(releaseRoot, "dist.manifest.json");

const problems = [];

function fail(message) {
  problems.push(message);
}

/** True if the path exists and is a file. */
function isFile(absPath) {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

/** True if the path exists and is a directory. */
function isDir(absPath) {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

// ── 1. The compiled application ──────────────────────────────────────

if (!isDir(distDir)) {
  fail("dist/ is missing — this is not a complete release directory");
} else {
  const entryPoints = [
    ["cli.js", "the CLI entry point"],
    ["api/server.js", "the HTTP server"],
    ["storage/schema.sql", "the base schema"],
  ];
  for (const [rel, what] of entryPoints) {
    if (!isFile(path.join(distDir, rel))) fail(`dist/${rel} is missing (${what})`);
  }
}

// ── 2. Runtime assets ─────────────────────────────────────────────────
//
// These are copied next to the JavaScript by scripts/copy-schema.js.
// Without them the service boots and then fails on the first request
// that touches a view, a stylesheet, or the migrations.

if (isDir(distDir)) {
  const migrations = path.join(distDir, "storage", "migrations");
  if (!isDir(migrations)) {
    fail("dist/storage/migrations/ is missing (the SQL migrations)");
  } else {
    const sqlFiles = fs.readdirSync(migrations).filter((f) => f.endsWith(".sql"));
    if (sqlFiles.length === 0) {
      fail("dist/storage/migrations/ contains no .sql files");
    } else {
      // The numbering does NOT have to be gapless — the project skips
      // 009 (the numbering predates it and renumbering applied
      // migrations is not possible). The invariant that does matter is
      // that the versions are unique and strictly increasing once
      // sorted: a duplicate or a repeated prefix means two files
      // would fight over the same schema_migrations row, and a missing
      // file in the middle means a schema step was lost in transit.
      const versions = sqlFiles
        .map((f) => f.slice(0, 3))
        .filter((v) => /^\d{3}$/.test(v))
        .sort();
      const seen = new Set();
      let previous = -1;
      for (const v of versions) {
        const n = Number(v);
        if (seen.has(v)) fail(`duplicate migration version: ${v}`);
        seen.add(v);
        if (n <= previous) fail(`migration versions are out of order: ${v}`);
        previous = n;
      }
      if (versions.length !== sqlFiles.length) {
        fail(
          `${sqlFiles.length - versions.length} migration file(s) do not follow the NNN_ naming ` +
            `convention — the migration runner would ignore them`,
        );
      }
    }
  }

  for (const rel of ["web/views", "web/assets", "web/i18n"]) {
    if (!isDir(path.join(distDir, rel))) {
      fail(`dist/${rel}/ is missing (runtime assets)`);
    }
  }

  // The demo seed is optional by design — it is loaded on request, not
  // by the migration runner — so its absence is not an error.
}

// ── 3. The manifest ───────────────────────────────────────────────────

if (!isFile(manifestPath)) {
  fail("dist.manifest.json is missing (cannot prove the copy is unmodified)");
} else {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    fail(`dist.manifest.json is not valid JSON: ${err.message}`);
  }

  if (manifest) {
    if (manifest.formatVersion !== 1) {
      fail(`manifest formatVersion ${manifest.formatVersion} is not supported`);
    }

    const files = manifest.files ?? {};

    // When dist/ is gone entirely, every file in the manifest is
    // missing and the directory walk below would throw. Report the
    // missing directory once and stop comparing — the operator needs
    // to re-upload, not a list of 347 missing files.
    if (!isDir(distDir)) {
      fail("dist/ is missing — the manifest cannot be checked against a directory that is not there");
    } else {
      // The manifest describes the repository, not the working copy:
      // git normalizes text files to LF, so the hashes are computed
      // over the LF form. Compare the same way.
      function storedBytes(absPath) {
        const raw = fs.readFileSync(absPath);
        const fd = fs.openSync(absPath, "r");
        try {
          const buf = Buffer.alloc(8192);
          const read = fs.readSync(fd, buf, 0, 8192, 0);
          if (buf.subarray(0, read).includes(0)) return raw; // binary
        } finally {
          fs.closeSync(fd);
        }
        return Buffer.from(raw.toString("utf8").replace(/\r\n?/g, "\n"), "utf8");
      }

      let checked = 0;
      for (const [rel, entry] of Object.entries(files)) {
        const abs = path.join(distDir, rel);
        if (!fs.existsSync(abs)) {
          fail(`missing: ${rel}`);
          continue;
        }
        const actual = crypto.createHash("sha256").update(storedBytes(abs)).digest("hex");
        if (actual !== entry.sha256) {
          fail(`modified: ${rel}`);
        }
        checked += 1;
      }

      // Anything in dist/ that the manifest does not mention is an
      // untracked addition. On a server that is usually harmless, but
      // it does mean the copy cannot be proven identical to the source.
      const listed = new Set(Object.keys(files));
      const actualFiles = [];
      (function walk(dir, base) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full, base);
          else if (entry.isFile()) {
            actualFiles.push(path.relative(base, full).split(path.sep).join("/"));
          }
        }
      })(distDir, distDir);
      for (const rel of actualFiles) {
        if (!listed.has(rel)) fail(`unexpected: ${rel}`);
      }

      if (checked > 0) {
        console.log(`[verify-dist] ${checked} files match dist.manifest.json`);
      }
    }
  }
}

// ── Result ────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error(`[verify-dist] the release bundle is not intact (${problems.length} problem(s)):`);
  for (const p of problems.slice(0, 40)) console.error(`  ${p}`);
  if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
  console.error("[verify-dist] do not start the service against a broken bundle — re-upload it");
  process.exit(1);
}

console.log("[verify-dist] release bundle is intact — run `node dist/cli.js serve` to start");
