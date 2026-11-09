// SPDX-License-Identifier: MIT
//
// The seeded rows must be reachable through findRange().
//
// migration 012 seeds a handful of well-known IPs so that /lookup
// answers something before the first ETL run. Those rows were written
// as UNHEX('08080808') — four bytes, left-aligned inside a BINARY(16)
// column — while every runtime path (parseIp(), the DB-IP and MaxMind
// parsers, findRange()'s query parameter) stores an IPv4 address as
// sixteen bytes with the address in the LAST four positions.
//
// MySQL compares the zero-padded values, so the left-aligned form
// sorted below the right-aligned form and no query could ever match:
// every seeded IP was unreachable through /lookup. The MCP smoke test
// is what surfaced it — ipquery_lookup returned "not found" for
// 8.8.8.8 even though 8.8.8.8 was in the seed data.
//
// This test runs the real migrations against a fresh database and
// checks that the seeded addresses are actually findable, so the byte
// order can't silently drift again.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { createPool, runMigrations, findRange } from "../../src/storage/mysql";
import { parseIp } from "../../src/ip";
import { loadConfig } from "../../src/config";

const TEST_DB = "ipquery_test_seedranges";

describe("seeded ranges are reachable", () => {
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

  it("finds a seeded public DNS address", async () => {
    const found = await findRange(pool, parseIp("8.8.8.8")!);
    expect(found).not.toBeNull();
    expect(found!.countryCode).toBe("US");
    expect(found!.city).toBe("Mountain View");
    expect(found!.isp).toBe("Google Public DNS");
  });

  it("finds a seeded address in every region", async () => {
    const cases: Array<{ ip: string; country: string | null; isp: string }> = [
      { ip: "1.1.1.1", country: "US", isp: "Cloudflare DNS" },
      { ip: "114.114.114.114", country: "CN", isp: "114DNS" },
      { ip: "9.9.9.9", country: "CH", isp: "Quad9 DNS" },
    ];
    for (const c of cases) {
      const found = await findRange(pool, parseIp(c.ip)!);
      expect(found, `expected ${c.ip} to be found`).not.toBeNull();
      expect(found!.countryCode).toBe(c.country);
      expect(found!.isp).toBe(c.isp);
    }
  });

  it("finds a seeded RFC 1918 range by its start address", async () => {
    // The reserved rows are ranges, not single addresses, so the start
    // of the range has to match too.
    const found = await findRange(pool, parseIp("192.168.0.0")!);
    expect(found).not.toBeNull();
    expect(found!.countryName).toBe("Reserved (RFC 1918)");
    expect(found!.isp).toBe("Private Network");
  });

  it("finds a seeded RFC 1918 range by an address inside it", async () => {
    const found = await findRange(pool, parseIp("192.168.0.42")!);
    expect(found).not.toBeNull();
    expect(found!.countryName).toBe("Reserved (RFC 1918)");
  });

  it("stores every seeded address in the 16-byte right-aligned form", async () => {
    // The direct check: no seeded row may keep the old 4-byte
    // left-aligned encoding.
    const [rows] = await pool.query<Array<{ start_hex: string; end_hex: string }>>(
      `SELECT HEX(start_ip) AS start_hex, HEX(end_ip) AS end_hex
         FROM ip_ranges WHERE country_source = 'seed'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.start_hex.length, `start_ip ${row.start_hex}`).toBe(32);
      expect(row.end_hex.length, `end_ip ${row.end_hex}`).toBe(32);
    }
  });

  it("does not find an address the seed data does not cover", async () => {
    // Guards against the opposite failure: an over-broad range that
    // swallows the whole address space.
    const found = await findRange(pool, parseIp("203.0.113.77")!);
    expect(found).toBeNull();
  });
});
