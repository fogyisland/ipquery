// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import {
  runMigrations,
  getAppliedVersions,
  listMigrationFiles,
} from "../../src/storage/migrations/runner";

const TEST_DB = "ipquery_mig_test";
let pool: mysql.Pool;

/** Every migration version the runner knows about, in order.
 *
 *  Derived from the runner's own manifest rather than written out by
 *  hand. A hardcoded list has to be edited every time a migration is
 *  added, and the day somebody forgets, the test fails for a reason that
 *  has nothing to do with the migration it was meant to cover. */
async function expectedVersions(): Promise<string[]> {
  const files = await listMigrationFiles();
  return files.map((file) => file.slice(0, 3)).sort();
}

beforeAll(async () => {
  const cfg = loadConfig();
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
  pool = mysql.createPool({ ...cfg.db, database: TEST_DB, connectionLimit: 2, multipleStatements: true });
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
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.end();
});

describe("migrations", () => {
  it("applies all versions on fresh DB", async () => {
    const r = await runMigrations(pool);
    expect(r.applied.sort()).toEqual(await expectedVersions());
  });

  it("is idempotent on second run", async () => {
    const r = await runMigrations(pool);
    expect(r.applied).toEqual([]);
    expect(r.skipped.sort()).toEqual(await expectedVersions());
  });

  it("all expected tables exist", async () => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SHOW TABLES");
    const tables = rows.map((r) => Object.values(r)[0] as string).sort();
    expect(tables).toContain("ip_ranges");
    expect(tables).toContain("etl_runs");
    expect(tables).toContain("users");
    expect(tables).toContain("api_keys");
    expect(tables).toContain("sessions");
    expect(tables).toContain("email_verifications");
    expect(tables).toContain("password_resets");
    expect(tables).toContain("query_log");
    expect(tables).toContain("schema_migrations");
    expect(tables).toContain("provider_call_counter");
    expect(tables).toContain("provider_call_counter_minute");
    expect(tables).toContain("mcp_tokens");
    expect(tables).toContain("etl_run_dedupe");
  });

  it("skips versions already marked applied", async () => {
    const before = await getAppliedVersions(pool);
    expect(before.has("003")).toBe(true);
    const r = await runMigrations(pool);
    expect(r.skipped.length).toBe((await expectedVersions()).length);
  });

  it("records apply timestamps", async () => {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT applied_at FROM schema_migrations WHERE version = ?",
      ["003"],
    );
    expect(rows[0]?.applied_at).toBeInstanceOf(Date);
  });
});
