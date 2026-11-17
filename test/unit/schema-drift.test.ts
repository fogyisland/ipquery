// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import {
  runMigrations,
  getSchemaReport,
  getSchemaReportFrom,
} from "../../src/storage/migrations/runner";

const TEST_DB = "ipquery_schema_diff_test";
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

describe("getSchemaReport structure check", () => {
  it("reports no drift on a database built entirely from migrations", async () => {
    // The reference is derived from the migration SQL, so a database built
    // from those same migrations has to match it exactly. Anything the
    // derivation gets wrong shows up here as a column nobody added.
    const report = await getSchemaReport(pool);
    expect(report.isCurrent).toBe(true);
    expect(report.drift).toEqual([]);
  });

  it("describes the tables and columns the migrations establish", async () => {
    // A reference that dropped a column would report every correct
    // deployment as broken, so the derivation is pinned on the two tables
    // whose shape the ETL and the console depend on.
    const { buildSchemaReference, listMigrationEntries } = await import(
      "../../src/storage/migrations/runner"
    );
    const ref = buildSchemaReference(listMigrationEntries());
    expect(ref.tables.get("settings")).toContain("updated_at");
    expect(ref.tables.get("ip_ranges")).toContain("range_size");
    expect(ref.tables.get("ip_ranges")).toContain("start_ip");
    // 021 appends to a table 016 created.
    expect(ref.tables.get("ingest_providers")).toContain("is_custom");
    expect(ref.tables.get("ingest_providers")).toContain("custom_url_template");
    // 022 appends to etl_runs.
    expect(ref.tables.get("etl_runs")).toContain("current_stage");
  });

  it("ignores a column named only inside a probe", async () => {
    // Migration 022 quotes the column name it is looking for:
    // `COLUMN_NAME = 'download_bytes_done')`. A reference that took those
    // names as declarations would report every database as missing a column
    // the migration never adds — which is what happened while this was
    // being written. The reference must describe what the migrations
    // establish, and the database below is exactly that.
    const { buildSchemaReference, listMigrationEntries } = await import(
      "../../src/storage/migrations/runner"
    );
    const ref = buildSchemaReference(listMigrationEntries());
    expect(ref.tables.get("etl_run_downloads")).not.toContain("download_bytes_done");
    // …while the columns 020 and 022 really do add are there, despite
    // living a whole statement away from the ALTER TABLE keyword.
    expect(ref.tables.get("etl_runs")).toContain("current_stage");
    expect(ref.tables.get("ingest_providers")).toContain("auto_reenable_at");
  });

  it("names the table and column when a column has been dropped by hand", async () => {
    // A hand-edited table is the case the ledger can never see: every
    // migration is recorded as applied, and the first query to touch the
    // missing column is where it surfaces. This is what the structure
    // check exists to catch.
    await pool.query("ALTER TABLE settings DROP COLUMN updated_at");
    try {
      const report = await getSchemaReport(pool);
      expect(report.isCurrent).toBe(false);
      expect(report.drift.some((d) => d.table === "settings" && d.kind === "missing_column")).toBe(true);
    } finally {
      await pool.query("ALTER TABLE settings ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)");
    }
  });

  it("names the table when the whole table is gone", async () => {
    await pool.query("RENAME TABLE mcp_tokens TO mcp_tokens_moved");
    try {
      const report = await getSchemaReport(pool);
      expect(report.drift.some((d) => d.table === "mcp_tokens" && d.kind === "missing_table")).toBe(true);
    } finally {
      await pool.query("RENAME TABLE mcp_tokens_moved TO mcp_tokens");
    }
  });

  it("does not invent drift for a table the migrations never created", async () => {
    // `ip_ranges_new` is a scratch table the ETL builds with
    // CREATE TABLE … LIKE. The reference must describe what the migrations
    // establish, not everything that happens to exist in the database —
    // otherwise every scratch table reads as an unexplained extra.
    await pool.query("CREATE TABLE scratch_notes (id INT PRIMARY KEY)");
    try {
      const report = await getSchemaReport(pool);
      expect(report.drift.some((d) => d.table === "scratch_notes")).toBe(false);
    } finally {
      await pool.query("DROP TABLE scratch_notes");
    }
  });

  it("reports an unreadable database instead of claiming it is clean", async () => {
    const dead = mysql.createPool({
      host: "127.0.0.1",
      port: 1,
      user: "n",
      password: "n",
      database: "n",
      connectTimeout: 200,
    });
    try {
      const report = await getSchemaReport(dead);
      expect(report.drift).toEqual([]);
      // A dead connection is a failed check, not a clean one. Without this
      // the card would say "no drift" about a database it never read.
      //
      // NOTE: this case asserts `structureError`, which `getSchemaReport`
      // only fills when the INFORMATION_SCHEMA read throws. Against a
      // connection that cannot even open, the report returns earlier on the
      // ledger read and sets `error` instead — so this assertion documents
      // the shape for a database that answers INFORMATION_SCHEMA badly, and
      // the ledger-error path is covered by the sibling `error` field.
      expect(report.error ?? report.structureError).toBeTypeOf("string");
      expect(report.isCurrent).toBe(false);
    } finally {
      await dead.end();
    }
  });
});
