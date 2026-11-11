// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { runMigrations } from "../../src/storage/migrations/runner";
import { loadDemoSeed } from "../../src/storage/seed/demoSeed";

let td: TestDb;
beforeAll(async () => {
  td = await createTestDb("seed");
  // The demo rows are opt-in: migration 012 only adds the index now, so
  // the rows have to be loaded explicitly — the same way the CLI's
  // `seed:demo` command and the setup wizard's demo option do it.
  await loadDemoSeed(td.pool);
});
afterAll(async () => {
  await dropTestDb(td);
});

// Helper: read the row whose start_ip matches the given 4-byte packed IPv4
// hex string, zero-padded on the LEFT (twelve 00 bytes, address last) —
// the encoding migration 023 standardized. The column is BINARY(16) so we
// compare via HEX() — MySQL's BINARY = BINARY equality does not auto-pad.
async function findSeedByIp(startIpHex4: string) {
  const padded = ("000000000000000000000000" + startIpHex4).toUpperCase();
  const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
    `SELECT HEX(start_ip) AS start_hex, HEX(end_ip) AS end_hex,
            country_code, country_name, region, city, isp, asn, asn_org,
            country_source, city_source, isp_source, geo_source
       FROM ip_ranges
      WHERE country_source = 'seed' AND HEX(start_ip) = ?
      LIMIT 1`,
    [padded],
  );
  return rows[0];
}

describe("demo seed rows", () => {
  it("seeds exactly 50 rows", async () => {
    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = 'seed'`,
    );
    expect(Number(rows[0].n)).toBe(50);
  });

  it("Google Public DNS 8.8.8.8 → US, Mountain View, Google", async () => {
    const row = await findSeedByIp("08080808");
    expect(row).toBeDefined();
    expect(row.start_hex).toBe("00000000000000000000000008080808");
    expect(row.end_hex).toBe("00000000000000000000000008080808");
    expect(row.country_code).toBe("US");
    expect(row.city).toBe("Mountain View");
    expect(row.isp).toBe("Google Public DNS");
    expect(row.asn).toBe(15169);
    expect(row.country_source).toBe("seed");
  });

  it("114DNS 114.114.114.114 → CN, Nanjing", async () => {
    const row = await findSeedByIp("72727272");
    expect(row).toBeDefined();
    expect(row.country_code).toBe("CN");
    expect(row.city).toBe("Nanjing");
  });

  it("RFC 1918 192.168.0.0/24 has country_code NULL and reserved country_name", async () => {
    const row = await findSeedByIp("C0A80000");
    expect(row).toBeDefined();
    expect(row.start_hex).toBe("000000000000000000000000C0A80000");
    expect(row.end_hex).toBe("000000000000000000000000C0A800FF");
    expect(row.country_code).toBeNull();
    expect(row.country_name).toBe("Reserved (RFC 1918)");
  });

  it("runMigrations is idempotent — count stays 50 on re-run", async () => {
    const r = await runMigrations(td.pool);
    expect(r.applied).toEqual([]);
    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = 'seed'`,
    );
    expect(Number(rows[0].n)).toBe(50);
  });

  it("a migrated database has no demo rows until they are asked for", async () => {
    // The regression this change exists to prevent: migration 012 used
    // to insert the demo rows, so every production database carried
    // them whether the operator wanted them or not.
    const fresh = await createTestDb("seed_fresh");
    try {
      const [rows] = await fresh.pool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = 'seed'`,
      );
      expect(Number(rows[0].n)).toBe(0);
    } finally {
      await dropTestDb(fresh);
    }
  });

  it("uniq_seed index exists on (start_ip, end_ip, country_source)", async () => {
    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SHOW INDEX FROM ip_ranges WHERE Key_name = 'uniq_seed'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const cols = rows.map((r) => r.Column_name as string).sort();
    expect(cols).toEqual(["country_source", "end_ip", "start_ip"]);
  });
});
