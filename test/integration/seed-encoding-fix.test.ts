// SPDX-License-Identifier: MIT
//
// migration 023 repairs the seeded rows written by the ORIGINAL
// migration 012.
//
// The original 012 stored each seeded IPv4 address as
// UNHEX('08080808') — four bytes, left-aligned inside the BINARY(16)
// column — while every runtime path (parseIp(), the DB-IP and MaxMind
// parsers, findRange()'s query parameter) stores an IPv4 address as
// sixteen bytes with the address in the LAST four positions.
//
// MySQL compares the zero-padded values, so the left-aligned form
// sorted BELOW the right-aligned form and no query could ever match
// it: every seeded IP was unreachable through /lookup. 8.8.8.8 was in
// the seed data and still returned "not found".
//
// migration 012 has been corrected for fresh installs; 023 fixes the
// databases that already ran the old one. This test reproduces the
// upgrade path: it puts the rows back into the old encoding, runs
// 023's SQL, and checks that they become findable again.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createPool, runMigrations, findRange } from "../../src/storage/mysql";
import { parseIp } from "../../src/ip";
import { loadConfig } from "../../src/config";

const TEST_DB = "ipquery_test_seedfix";
const MIGRATION_FILE = "023_fix_seed_ip_encoding.sql";

/** The original, buggy encoding: four address bytes, left-aligned. */
const BUGGY_ENCODING: Array<{ start: string; end: string; ip: string }> = [
  { start: "08080808", end: "08080808", ip: "8.8.8.8" },
  { start: "01010101", end: "01010101", ip: "1.1.1.1" },
  { start: "72727272", end: "72727272", ip: "114.114.114.114" },
  { start: "C0A80000", end: "C0A800FF", ip: "192.168.0.0" },
];

describe("migration 023 repairs the seed encoding", () => {
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
  });

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

  /** Put the seeded rows back into the pre-023 (left-aligned) form. */
  async function restoreBuggyEncoding(): Promise<void> {
    for (const row of BUGGY_ENCODING) {
      await pool.query(
        `UPDATE ip_ranges
            SET start_ip = CONCAT(UNHEX(?), REPEAT(UNHEX('00'), 12)),
                end_ip   = CONCAT(UNHEX(?), REPEAT(UNHEX('00'), 12))
          WHERE country_source = 'seed'
            AND HEX(start_ip) = ?`,
        [row.start, row.end, row.start.toLowerCase().padStart(32, "0")],
      );
    }
  }

  /** Run migration 023's SQL directly. */
  async function runFixMigration(): Promise<void> {
    const sqlPath = path.join(__dirname, "..", "..", "src", "storage", "migrations", MIGRATION_FILE);
    const sql = await fs.readFile(sqlPath, "utf8");
    await pool.query(sql);
  }

  it("moves the address bytes from the front of the column to the back", async () => {
    await restoreBuggyEncoding();

    // Sanity: the rows are unreachable in this state, which is the bug.
    const before = await findRange(pool, parseIp("8.8.8.8")!);
    expect(before).toBeNull();

    await runFixMigration();

    const [rows] = await pool.query<Array<{ start_hex: string }>>(
      `SELECT HEX(start_ip) AS start_hex FROM ip_ranges WHERE country_source = 'seed'`,
    );
    for (const row of rows) {
      expect(row.start_hex.length).toBe(32);
      // The right-aligned form puts the address in the last 8 hex
      // characters and leaves the first 24 as zero.
      expect(row.start_hex.slice(0, 24)).toBe("0".repeat(24));
    }
  });

  it("makes the repaired rows findable again", async () => {
    await restoreBuggyEncoding();
    await runFixMigration();

    for (const row of BUGGY_ENCODING) {
      const found = await findRange(pool, parseIp(row.ip)!);
      expect(found, `expected ${row.ip} to be found after the fix`).not.toBeNull();
    }
  });

  it("is a no-op when the rows are already correct", async () => {
    // Fresh installs get the right bytes from migration 012, so 023 must
    // not disturb them.
    const [before] = await pool.query<Array<{ start_hex: string; end_hex: string }>>(
      `SELECT HEX(start_ip) AS start_hex, HEX(end_ip) AS end_hex
         FROM ip_ranges WHERE country_source = 'seed'`,
    );

    await runFixMigration();

    const [after] = await pool.query<Array<{ start_hex: string; end_hex: string }>>(
      `SELECT HEX(start_ip) AS start_hex, HEX(end_ip) AS end_hex
         FROM ip_ranges WHERE country_source = 'seed'`,
    );
    expect(after).toEqual(before);
  });

  it("leaves ETL-sourced rows untouched", async () => {
    // A row in the right-aligned form (the way parseIp() writes every
    // ETL and backfill row) must not be touched by the repair — the
    // migration is scoped to country_source = 'seed'.
    await pool.query(
      `INSERT INTO ip_ranges
         (start_ip, end_ip, country_code, country_source, city_source, isp_source, geo_source)
       VALUES (UNHEX('0000000000000000000000000A0B0C0D'),
               UNHEX('0000000000000000000000000A0B0C0D'),
               'XX', 'maxmind', 'maxmind', 'maxmind', 'maxmind')`,
    );
    try {
      await runFixMigration();
      const [rows] = await pool.query<Array<{ start_hex: string }>>(
        `SELECT HEX(start_ip) AS start_hex FROM ip_ranges WHERE country_source = 'maxmind'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.start_hex).toBe("0000000000000000000000000A0B0C0D");
    } finally {
      await pool.query(`DELETE FROM ip_ranges WHERE country_source = 'maxmind'`);
    }
  });
});
