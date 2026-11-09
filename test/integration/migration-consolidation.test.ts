// SPDX-License-Identifier: MIT
//
// Migrations 020 and 022 were rewritten to add their columns in ONE
// ALTER TABLE instead of one per column. This test pins two things
// about that rewrite:
//
//  1. On a database that already applied the OLD per-column form, the
//     new file must be a no-op — every column is already there, so the
//     prepared statement assembles an empty column list and the
//     migration does nothing rather than failing on "Duplicate column".
//     (This is the upgrade path: an existing database has version
//     "020"/"022" recorded and skips the file entirely, but the CLI's
//     --force re-run and any hand-applied file must also behave.)
//
//  2. On a database where only SOME of the columns exist — the partial
//     state a crashed run leaves behind, since DDL commits implicitly
//     while the schema_migrations INSERT rolls back — the migration
//     must add exactly the missing ones and leave the existing ones
//     untouched.
//
// Both are the behaviour the per-column INFORMATION_SCHEMA guards
// provided; consolidating them into one ALTER must not lose it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../../src/config";
import { createPool, runMigrations } from "../../src/storage/mysql";

const TEST_DB = "ipquery_test_mig_consolidation";

describe("consolidated ALTER migrations", () => {
  let pool: mysql.Pool;
  const cfg = loadConfig();

  beforeAll(async () => {
    cfg.db.database = TEST_DB;
    const root = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
    });
    await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await root.query(`CREATE DATABASE ${TEST_DB}`);
    await root.end();
    pool = createPool(cfg);
    await runMigrations(pool);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    const root = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
    });
    await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await root.end();
  });

  /** Run one migration file's SQL directly, as the runner would. */
  async function runMigrationFile(name: string): Promise<void> {
    const sqlPath = path.join(__dirname, "..", "..", "src", "storage", "migrations", name);
    const sql = await fs.readFile(sqlPath, "utf8");
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(sql);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw new Error(`${name} failed: ${(err as Error).message}`);
    } finally {
      conn.release();
    }
  }

  async function columnsOf(table: string): Promise<string[]> {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return rows.map((r) => String(r.COLUMN_NAME)).sort();
  }

  it("adds all six etl_runs columns on a fresh database", async () => {
    const cols = await columnsOf("etl_runs");
    for (const expected of [
      "download_bytes_done",
      "download_bytes_total",
      "insert_rows_done",
      "insert_rows_total",
      "current_stage",
      "progress_updated_at",
    ]) {
      expect(cols, `etl_runs.${expected}`).toContain(expected);
    }
  });

  it("adds both ingest_providers columns on a fresh database", async () => {
    const cols = await columnsOf("ingest_providers");
    expect(cols).toContain("auto_reenable_at");
    expect(cols).toContain("auto_disabled_reason");
  });

  it("is a no-op when every column is already present", async () => {
    // The state an existing database is in: the migration already ran.
    // Re-applying the consolidated file must not fail on a duplicate
    // column.
    const before022 = await columnsOf("etl_runs");
    const before020 = await columnsOf("ingest_providers");

    await runMigrationFile("022_etl_run_progress.sql");
    await runMigrationFile("020_provider_call_counter.sql");

    expect(await columnsOf("etl_runs")).toEqual(before022);
    expect(await columnsOf("ingest_providers")).toEqual(before020);
  });

  it("adds only the missing columns when a previous run was partial", async () => {
    // The state a crashed run leaves: DDL commits implicitly, so the
    // first ALTER landed while the schema_migrations INSERT rolled back.
    // Drop two of the six columns to reproduce it.
    await pool.query("ALTER TABLE etl_runs DROP COLUMN download_bytes_total");
    await pool.query("ALTER TABLE ingest_providers DROP COLUMN auto_disabled_reason");

    await runMigrationFile("022_etl_run_progress.sql");
    await runMigrationFile("020_provider_call_counter.sql");

    const etlCols = await columnsOf("etl_runs");
    expect(etlCols).toContain("download_bytes_total");
    expect(etlCols).toContain("download_bytes_done");
    expect(etlCols).toContain("progress_updated_at");

    const providerCols = await columnsOf("ingest_providers");
    expect(providerCols).toContain("auto_disabled_reason");
    expect(providerCols).toContain("auto_reenable_at");
  });
});
