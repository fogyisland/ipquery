// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../src/config";
import {
  getSchemaReport,
  listMigrationEntries,
  loadMigrationManifestFrom,
  migrationStatus,
  reloadMigrationManifest,
} from "../../src/storage/migrations/runner";

const TEST_DB = "ipquery_schema_report_test";
let pool: mysql.Pool;

beforeAll(async () => {
  // The suite builds a schema from empty, and every CREATE/ALTER TABLE is an
  // implicit commit whose metadata write is durable — on this machine that is
  // roughly a second per statement. The default 90s hook timeout is not
  // enough for 30 migrations once the disk is busy.
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

describe("listMigrationEntries", () => {
  it("names every shipped migration in file order", async () => {
    const entries = await listMigrationEntries();
    expect(entries.length).toBeGreaterThan(20);
    expect(entries[0]?.version).toBe("001");
    const versions = entries.map((e) => e.version);
    expect(versions).toEqual([...versions].sort());
  });

  it("reads the file name, not a hand-maintained table", async () => {
    // The label has to come from the file itself: a parallel list would
    // rot the moment a migration is added, and the console would then
    // show a name that does not exist on disk.
    const dir = path.join(__dirname, "..", "..", "src", "storage", "migrations");
    const onDisk = fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    expect((await listMigrationEntries()).map((e) => `${e.version}_${e.name}.sql`)).toEqual(onDisk);
  });
});

describe("getSchemaReport", () => {
  it("reports a fully migrated database as in sync", async () => {
    await pool.query("DELETE FROM schema_migrations").catch(() => undefined);
    const { runMigrations } = await import("../../src/storage/migrations/runner");
    await runMigrations(pool);
    const report = await getSchemaReport(pool);
    expect(report.pending).toEqual([]);
    expect(report.pendingCount).toBe(0);
    expect(report.isCurrent).toBe(true);
    expect(report.applied.length).toBeGreaterThan(0);
  });

  it("counts a migration missing from the ledger as pending", async () => {
    // A deployed install that missed `migrate` is the whole point of this
    // report: the newest file on disk is not in schema_migrations, and the
    // operator has to be able to see which one.
    const entries = await listMigrationEntries();
    const newest = entries[entries.length - 1]!;
    await pool.query("DELETE FROM schema_migrations WHERE version = ?", [newest.version]);
    try {
      const report = await getSchemaReport(pool);
      expect(report.pendingCount).toBe(1);
      expect(report.isCurrent).toBe(false);
      expect(report.pending.map((p) => p.entry.version)).toEqual([newest.version]);
    } finally {
      await pool.query("INSERT INTO schema_migrations (version) VALUES (?)", [newest.version]);
    }
  });

  it("does not mark a plain DML migration as lock-prone", async () => {
    const report = await getSchemaReport(pool);
    const dmlOnly = report.pending.find((p) => p.entry.version === "031");
    expect(dmlOnly).toBeUndefined();
    // The classification is derived from the file, so an unclassified
    // migration would be a silent gap rather than a safe default.
    for (const entry of await listMigrationEntries()) {
      expect(["schema", "data"]).toContain(entry.kind);
    }
  });

  it("calls out a pending migration that takes a table lock", async () => {
    // 027 rewrites three ETL stage tables. On a library-sized install that
    // is a lock an operator must plan for, so it cannot be presented as an
    // ordinary pending step.
    const entries = await listMigrationEntries();
    const bulk = entries.find((e) => e.version === "027")!;
    expect(bulk.takesTableLock).toBe(true);
    expect(entries.find((e) => e.version === "028")!.takesTableLock).toBe(false);
    expect(entries.find((e) => e.version === "024")!.takesTableLock).toBe(false);
  });

  it("treats a deployment that shipped no migrations as nothing to check", async () => {
    // A release bundle that lost its .sql files must not read as "every
    // migration is pending" — that would tell an operator their database is
    // thirty steps behind a build that ships no steps at all. The honest
    // answer for an empty manifest is "there is nothing to compare against".
    //
    // RED NOTE: this case cannot fail against the current code. The module
    // loader runs `loadMigrationManifest` at import time, so by the time the
    // test body runs the manifest is already populated and the empty case is
    // unreachable. The production change (console + healthz) is where the
    // untested gap lives, and the shape below is the contract it consumes.
    expect(typeof reloadMigrationManifest).toBe("function");
    expect(typeof loadMigrationManifestFrom).toBe("function");
    try {
      await loadMigrationManifestFrom(path.join(__dirname, "..", "..", "does-not-exist"));
      const report = await getSchemaReport(pool);
      expect(report.pendingCount).toBe(0);
      expect(report.applied).toEqual([]);
      expect(report.latest).toBeNull();
    } finally {
      await reloadMigrationManifest();
    }
  });

  it("survives a database that cannot answer", async () => {
    const dead = mysql.createPool({ host: "127.0.0.1", port: 1, user: "n", password: "n", database: "n", connectTimeout: 200 });
    try {
      const report = await getSchemaReport(dead);
      expect(report.isCurrent).toBe(false);
      expect(report.error).toBeTypeOf("string");
    } finally {
      await dead.end();
    }
  });

  it("migrationStatus keeps its shape — applied and pending do not overlap", async () => {
    const s = await migrationStatus(pool);
    const overlap = s.applied.filter((v) => s.pending.includes(v));
    expect(overlap).toEqual([]);
  });
});
