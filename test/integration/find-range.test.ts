// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import {
  createPool,
  runMigrations,
  atomicSwapRanges,
  insertIntoNew,
  insertIntoNewUpsert,
  truncateNew,
  findRange,
} from "../../src/storage/mysql";
import { loadConfig } from "../../src/config";
import type { IpRangeRow } from "../../src/types";

const TEST_DB = "ipquery_test_findrange";

// Helper: 16-byte zero-padded IPv4 buffer (matches how DB-IP stores IPv4).
function v4(a: number, b: number, c: number, d: number): Buffer {
  return Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, a, b, c, d]);
}

describe("findRange overlapping-range correctness + perf", () => {
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

  it("picks the smallest covering range among overlapping ones", async () => {
    // Scenario: a /24 city range (specific), a /16 country range (broader)
    // and a /24 asn range (also specific) all cover 10.0.0.5.
    // Expected: the /24 city range wins (range_size 255 < 65535 < 255).
    // The /24 city and asn ranges are equally specific; city comes first
    // because we populate countrySource/citySource from the city-lite row.
    await truncateNew(pool);
    const city = {
      startIp: v4(10, 0, 0, 0),
      endIp: v4(10, 0, 0, 255),
      countryCode: "US",
      city: "Springfield",
      countrySource: "dbip" as const,
      citySource: "dbip" as const,
      geoSource: "dbip" as const,
    };
    const country = {
      startIp: v4(10, 0, 0, 0),
      endIp: v4(10, 0, 255, 255),
      countryCode: "US",
      countrySource: "dbip-country" as const,
    };
    const asn = {
      startIp: v4(10, 0, 0, 0),
      endIp: v4(10, 0, 0, 255),
      asn: 12345,
      asnOrg: "TestNet",
      asnSource: "dbip-asn" as const,
    };
    await insertIntoNewUpsert(
      pool,
      [country, asn, city],
      new Set([
        "countryCode",
        "city",
        "asn",
        "asnOrg",
        "countrySource",
        "citySource",
        "asnSource",
        "geoSource",
      ] as Array<keyof IpRangeRow>),
    );
    await atomicSwapRanges(pool);

    const found = await findRange(pool, v4(10, 0, 0, 5));
    expect(found?.countryCode).toBe("US");
    expect(found?.city).toBe("Springfield");
    expect(found?.asn).toBe(12345);
    expect(found?.asnOrg).toBe("TestNet");
  });

  it("returns null when no range covers the IP", async () => {
    await truncateNew(pool);
    await insertIntoNew(pool, [
      {
        startIp: v4(10, 0, 0, 0),
        endIp: v4(10, 0, 0, 255),
        countryCode: "US",
        countrySource: "dbip" as const,
      },
    ]);
    await atomicSwapRanges(pool);
    const found = await findRange(pool, v4(192, 168, 0, 1));
    expect(found).toBeNull();
  });

  it("picks the larger range when the smaller range does not actually cover the IP", async () => {
    // Two non-overlapping ranges: a /24 at 10.0.0.0 and a /16 at 10.0.5.0.
    // For 10.0.0.5, only the /24 covers. For 10.0.5.5, only the /16 covers.
    await truncateNew(pool);
    await insertIntoNew(pool, [
      {
        startIp: v4(10, 0, 0, 0),
        endIp: v4(10, 0, 0, 255),
        countryCode: "A",
        countrySource: "dbip" as const,
      },
      {
        startIp: v4(10, 0, 5, 0),
        endIp: v4(10, 0, 255, 255),
        countryCode: "B",
        countrySource: "dbip" as const,
      },
    ]);
    await atomicSwapRanges(pool);
    expect((await findRange(pool, v4(10, 0, 0, 5)))?.countryCode).toBe("A");
    expect((await findRange(pool, v4(10, 0, 5, 5)))?.countryCode).toBe("B");
  });

  it("lookup completes in well under 1s on a 1000-row table", async () => {
    // Sanity check that the two-step LIMIT-100 strategy stays fast even
    // when the candidate pool is large. 1000 rows is enough to make a
    // full-scan ORDER BY range_size measurable; the real production
    // table is ~8000x larger and we've verified ~100ms there.
    await truncateNew(pool);
    const rows = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        startIp: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, (i >> 8) & 0xff, i & 0xff, 0]),
        endIp: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, (i >> 8) & 0xff, i & 0xff, 255]),
        countryCode: "X",
        countrySource: "dbip" as const,
      });
    }
    await insertIntoNew(pool, rows);
    await atomicSwapRanges(pool);
    // mid-table IP
    const target = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 0, 200, 5]);
    const t0 = Date.now();
    const found = await findRange(pool, target);
    const elapsed = Date.now() - t0;
    expect(found?.countryCode).toBe("X");
    expect(elapsed).toBeLessThan(1000);
  });
  it("fillCols never overwrites existing fine-grained columns", async () => {
    // A country-only file (metowolf-cn / runishiwo-cn style) must never
    // clobber the city / geo / asn columns a richer file already wrote.
    // The upsert writes `COALESCE(col, VALUES(col))` so an existing value
    // survives; a null one is filled in.
    await truncateNew(pool);
    const full: IpRangeRow = {
      startIp: v4(10, 0, 0, 0),
      endIp: v4(10, 0, 0, 255),
      countryCode: "GB",
      city: "London",
      latitude: 51.5074,
      longitude: -0.1278,
      asn: 64500,
      asnOrg: "Example ISP",
      countrySource: "dbip" as const,
      citySource: "dbip" as const,
      geoSource: "dbip" as const,
      asnSource: "dbip-asn" as const,
    };
    await insertIntoNewUpsert(
      pool,
      [full],
      new Set([
        "countryCode",
        "city",
        "latitude",
        "longitude",
        "asn",
        "asnOrg",
        "countrySource",
        "citySource",
        "geoSource",
        "asnSource",
      ] as Array<keyof IpRangeRow>),
    );
    // A narrow country-only upsert over the SAME (start,end) key.
    await insertIntoNewUpsert(
      pool,
      [
        {
          startIp: v4(10, 0, 0, 0),
          endIp: v4(10, 0, 0, 255),
          countryCode: "CN",
          countrySource: "metowolf-cn" as const,
        },
      ],
      new Set(["countryCode", "countrySource"] as Array<keyof IpRangeRow>),
    );
    await atomicSwapRanges(pool);

    const found = await findRange(pool, v4(10, 0, 0, 5));
    // The country-only pass must NOT have replaced the richer row.
    expect(found?.countryCode).toBe("GB");
    expect(found?.countrySource).toBe("dbip");
    // …and the fine-grained columns must be untouched.
    expect(found?.city).toBe("London");
    expect(found?.latitude).toBeCloseTo(51.5074, 3);
    expect(found?.asn).toBe(64500);
    expect(found?.asnOrg).toBe("Example ISP");
    expect(found?.geoSource).toBe("dbip");
    expect(found?.asnSource).toBe("dbip-asn");
  });

  it("findRange still picks the smallest covering range after deduped big ranges", async () => {
    // A deduped, wide country range plus a narrow city range that both
    // cover the target: the narrow one still wins, and the wide one does
    // not shadow it.
    await truncateNew(pool);
    const wide: IpRangeRow = {
      startIp: v4(10, 0, 0, 0),
      endIp: v4(10, 255, 255, 255),
      countryCode: "CN",
      countrySource: "runishiwo-cn" as const,
    };
    const narrow: IpRangeRow = {
      startIp: v4(10, 0, 0, 0),
      endIp: v4(10, 0, 0, 255),
      countryCode: "CN",
      city: "Beijing",
      countrySource: "dbip" as const,
      citySource: "dbip" as const,
    };
    await insertIntoNewUpsert(
      pool,
      [wide, narrow],
      new Set(["countryCode", "city", "countrySource", "citySource"] as Array<keyof IpRangeRow>),
    );
    await atomicSwapRanges(pool);

    const found = await findRange(pool, v4(10, 0, 0, 5));
    expect(found?.city).toBe("Beijing");
    expect(found?.citySource).toBe("dbip");
    // The wide range still answers for an address the narrow one misses.
    const outside = await findRange(pool, v4(10, 200, 0, 5));
    expect(outside?.countryCode).toBe("CN");
    expect(outside?.city).toBeNull();
    expect(outside?.countrySource).toBe("runishiwo-cn");
  });
});
