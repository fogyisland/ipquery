// SPDX-License-Identifier: MIT
//
// The migration manifest has exactly one source of truth: the `.sql`
// files on disk.
//
// It used to have two. The runner carried an inline `MIGRATION_SQL` map —
// roughly two thousand lines of SQL, one entry per migration, duplicated
// from the files — plus a `MIGRATION_FILES` list of names. The map's
// comment claimed it existed so a release bundle that shipped only
// `dist/` would still know the SQL.
//
// It never did that job. The module loads the on-disk manifest at import
// time, and the load REPLACES the map: `MIGRATION_SQL.clear()` followed by
// a refill from the files. So the inline copy was dead the moment the
// runner was imported — and the fallback it advertised could never fire,
// because an unreadable directory produced an empty manifest, not the
// inline one.
//
// The cost of the dead copy was not zero. It drifted: migration 035 was
// registered by name but its SQL never made it into the map, and nobody
// noticed because nothing reads the map before it is cleared.
//
// These tests pin the two properties that make the on-disk manifest
// trustworthy:
//
//   1. The report path waits for the manifest to load. The report is what
//      the health check and the admin console show, and a report that
//      says "no migrations" because it ran a millisecond too early is
//      worse than no report.
//   2. The runner's own view of the manifest is the files on disk — not a
//      hand-maintained list that can rot.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import {
  runMigrations,
  getSchemaReport,
  listMigrationEntries,
} from "../../src/storage/migrations/runner";

const TEST_DB = "ipquery_manifest_race_test";
let pool: mysql.Pool;

beforeAll(async () => {
  const cfg = loadConfig();
  cfg.db.database = TEST_DB;
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.query(`CREATE DATABASE \`${TEST_DB}\``);
  await root.end();
  pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: TEST_DB,
    connectionLimit: 2,
    multipleStatements: true,
    timezone: "Z",
  });
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.end();
});

/** The `.sql` files this build ships, in the order they apply. */
function migrationsOnDisk(): string[] {
  const dir = path.join(__dirname, "..", "..", "src", "storage", "migrations");
  return fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
}

describe("the migration manifest", () => {
  it("is the files on disk, with no hand-maintained list beside it", () => {
    // The runner must not carry a second copy of the manifest. A second
    // copy is a thing that can be one file behind, and the one place it
    // already was.
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "storage", "migrations", "runner.ts"),
      "utf8",
    );
    // The inline SQL map is the duplicated copy. Its absence is the point.
    expect(source).not.toMatch(/const\s+MIGRATION_SQL\s*=\s*new\s+Map/);
    // And no hand-maintained name list either: the names come from the
    // files, so a new migration cannot be forgotten. The declaration may
    // exist and start out empty — that is the state before the loader has
    // read anything — but a literal with NAMES in it is a second copy.
    expect(source).not.toMatch(/MIGRATION_FILES[^=]*=\s*\[[^\]]*["']/);
  });

  it("names every shipped migration, in file order", async () => {
    const entries = await listMigrationEntries();
    expect(entries.map((e) => `${e.version}_${e.name}.sql`)).toEqual(migrationsOnDisk());
  });

  it("waits for the manifest before the report reads it", async () => {
    // The report is what `/healthz` and the admin console show. If it
    // reads the manifest before the directory listing has settled, it
    // reports "no migrations" — which reads as "this build has nothing to
    // apply" and, on a database that is thirty steps behind, as "you are
    // current".
    //
    // The window is real: the manifest is loaded asynchronously at import
    // time, and a health probe can arrive before it settles.
    const report = await getSchemaReport(pool);
    expect(report.latest).not.toBeNull();
    expect(report.latest!.file).toBe(migrationsOnDisk().at(-1));
    // Every shipped migration must be in the report's view of the world.
    expect(report.applied.length).toBeGreaterThan(20);
  });

  it("reports the same latest migration the files name", async () => {
    // The report and the file list have to agree on which migration is
    // the newest. They are read through different paths — one from the
    // report's own view, one from the directory — so they could drift.
    const report = await getSchemaReport(pool);
    const newest = migrationsOnDisk().at(-1)!;
    expect(report.latest?.file).toBe(newest);
  });

  it("sees the manifest even when it is called before the read settles", async () => {
    // The race, made deterministic.
    //
    // The runner reads the manifest from the disk at module load, so for
    // a moment after import the module knows nothing about the files. A
    // reader that does not WAIT for that read sees an empty manifest — and
    // "empty" is exactly what "this build ships no migrations" looks like.
    // The report would then say "nothing to check" about a database that
    // is thirty steps behind.
    //
    // `vi.resetModules()` gives the runner a fresh module instance, whose
    // `manifestReady` is a brand-new pending `readdir`. Calling into it
    // immediately reproduces the window a health probe can land in.
    vi.resetModules();
    const fresh = await import("../../src/storage/migrations/runner");

    // No await between the import and the call: this is the race window.
    const entries = await fresh.listMigrationEntries();

    expect(entries.length).toBeGreaterThan(20);
    expect(entries.map((e) => `${e.version}_${e.name}.sql`)).toEqual(migrationsOnDisk());
  });
});
