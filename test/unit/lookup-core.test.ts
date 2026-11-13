// SPDX-License-Identifier: MIT
//
// Unit tests for the shared lookup core.
//
// doLookupCore is the single implementation behind BOTH the HTTP
// `/lookup` route and the MCP `ipquery_lookup` tool, so a regression
// here breaks both surfaces at once. The HTTP layer is covered by
// test/integration/lookup-route.test.ts and the MCP layer by
// test/unit/mcp-tools.test.ts, but the core's own contract — the
// error shape, the miss side effect, and the fire-and-forget queue
// write — had no direct coverage.
//
// The pool is mocked: findRange / lastSuccessfulEtl / insertOrIncrement
// all take a Pool, and this test is about the branching, not the SQL.
import { describe, it, expect, vi } from "vitest";
import { doLookupCore, type CoreLogger } from "../../src/lookup-core";
import { parseIp } from "../../src/ip";

/**
 * A pool stub whose query() returns whatever the test queues up.
 *
 * mysql2's query() resolves to [rows, fields] — the callers destructure
 * the first element — so each queued response must be a two-element
 * tuple, not a bare rows array.
 */
function stubPool(responses: Array<unknown>): { pool: unknown; queries: unknown[] } {
  const queries: unknown[] = [];
  let index = 0;
  const pool = {
    query: vi.fn(async (...args: unknown[]) => {
      queries.push(args);
      const next = responses[index++];
      return next ?? [[], []];
    }),
  };
  return { pool, queries };
}

/** A logger that records warnings instead of printing them. */
function stubLogger(): CoreLogger & { warnings: Array<[unknown, string]> } {
  const warnings: Array<[unknown, string]> = [];
  return {
    warn: (obj: unknown, msg: string) => {
      warnings.push([obj, msg]);
    },
    warnings,
  };
}

/**
 * The raw DB row findRange() selects, before its snake_case → camelCase
 * conversion. findRange() reads start_ip / end_ip / range_size itself
 * (it picks the smallest covering range), so the mock has to look like
 * a MySQL row, not like the IpRangeRow the function returns.
 */
function rawRangeRow(overrides: Record<string, unknown> = {}) {
  return {
    start_ip: parseIp("8.8.8.0"),
    end_ip: parseIp("8.8.8.255"),
    country_code: "US",
    country_name: "United States",
    region: "California",
    city: "Mountain View",
    postal_code: "94043",
    latitude: 37.4056,
    longitude: -122.0775,
    timezone: "America/Los_Angeles",
    isp: "Google LLC",
    asn: 15169,
    asn_org: "GOOGLE",
    country_source: "maxmind",
    city_source: "maxmind",
    isp_source: "maxmind",
    asn_source: "maxmind",
    geo_source: "maxmind",
    range_size: "256",
    ...overrides,
  };
}

describe("doLookupCore", () => {
  it("rejects an invalid IP with a 400 before touching the database", async () => {
    const { pool, queries } = stubPool([]);
    const log = stubLogger();

    const err = await doLookupCore(pool as never, log, "not-an-ip").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { statusCode?: number }).statusCode).toBe(400);
    expect((err as { code?: string }).code).toBe("invalid_ip");
    expect(queries).toHaveLength(0);
  });

  it("returns the geolocation fields for a hit and an etag from the last ETL run", async () => {
    const { pool } = stubPool([
      [[rawRangeRow()], []],
      [[{ finished_at: new Date("2026-11-01T00:00:00Z") }], []],
    ]);
    const log = stubLogger();

    const result = await doLookupCore(pool as never, log, "8.8.8.8");

    expect(result.ip).toBe("8.8.8.8");
    expect(result.country).toEqual({ code: "US", name: "United States", source: "maxmind" });
    expect(result.region).toBe("California");
    expect(result.city).toEqual({ name: "Mountain View", source: "maxmind" });
    expect(result.postalCode).toBe("94043");
    expect(result.location).toEqual({ lat: 37.4056, lon: -122.0775, source: "maxmind" });
    expect(result.timezone).toBe("America/Los_Angeles");
    expect(result.isp).toEqual({ name: "Google LLC", source: "maxmind" });
    expect(result.asn).toEqual({ number: 15169, org: "GOOGLE", source: "maxmind" });
    expect(result.etag).toBe("2026-11-01T00:00:00.000Z");
  });

  it("falls back to the ISO country name when the row has no country_name", async () => {
    // This is the real shape of the data: DB-IP's CSVs carry a country
    // code only, so `country_name` is NULL for every ETL-loaded row.
    // Without the fallback the API answers `"name": null`, and the web
    // UI shows a bare "HK" under a heading that says "country".
    const { pool } = stubPool([
      [[rawRangeRow({ country_code: "HK", country_name: null })], []],
      [[], []],
    ]);
    const log = stubLogger();

    const result = await doLookupCore(pool as never, log, "8.8.8.8");

    expect(result.country).toEqual({ code: "HK", name: "Hong Kong", source: "maxmind" });
  });

  it("keeps the name null for a country code it does not know", async () => {
    // "ZZ" is the ISO user-assigned code the ETL uses for unknown rows.
    // Inventing a name for it would be worse than admitting we don't
    // have one.
    const { pool } = stubPool([
      [[rawRangeRow({ country_code: "ZZ", country_name: null })], []],
      [[], []],
    ]);
    const log = stubLogger();

    const result = await doLookupCore(pool as never, log, "8.8.8.8");

    expect(result.country.code).toBe("ZZ");
    expect(result.country.name).toBeUndefined();
  });

  it("prefers the row's own country_name over the ISO fallback", async () => {
    // If a data source ever does supply a name, that wins — it is more
    // specific than the standard table.
    const { pool } = stubPool([
      [[rawRangeRow({ country_code: "HK", country_name: "Hong Kong SAR" })], []],
      [[], []],
    ]);
    const log = stubLogger();

    const result = await doLookupCore(pool as never, log, "8.8.8.8");

    expect(result.country.name).toBe("Hong Kong SAR");
  });

  it("uses 'never' as the etag when no ETL run has succeeded yet", async () => {
    const { pool } = stubPool([
      [[rawRangeRow()], []],
      [[], []],
    ]);
    const log = stubLogger();

    const result = await doLookupCore(pool as never, log, "8.8.8.8");

    expect(result.etag).toBe("never");
  });

  it("omits city / location / isp / asn when the row has no value for them", async () => {
    const { pool } = stubPool([
      [
        [
          rawRangeRow({
            city: null,
            postal_code: null,
            latitude: null,
            longitude: null,
            timezone: null,
            isp: null,
            asn: null,
            asn_org: null,
          }),
        ],
        [],
      ],
      [[], []],
    ]);
    const log = stubLogger();

    const result = await doLookupCore(pool as never, log, "8.8.8.8");

    expect(result.city).toBeUndefined();
    // postalCode and timezone are passed straight through from the row,
    // so a missing value stays null. city / isp / asn / location go
    // through a truthiness check and come back undefined.
    expect(result.postalCode).toBeNull();
    expect(result.timezone).toBeNull();
    expect(result.location).toBeUndefined();
    expect(result.isp).toBeUndefined();
    expect(result.asn).toBeUndefined();
    // country is always present.
    expect(result.country.code).toBe("US");
  });

  it("throws a 404 and queues the miss", async () => {
    const { pool, queries } = stubPool([[[], []]]);
    const log = stubLogger();

    const err = await doLookupCore(pool as never, log, "203.0.113.9").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { statusCode?: number }).statusCode).toBe(404);
    expect((err as { code?: string }).code).toBe("not_found");
    expect((err as { ip?: string }).ip).toBe("203.0.113.9");

    // Two queries: the range lookup, then the unknown_ip_queue insert.
    expect(queries).toHaveLength(2);
    expect(String((queries[1] as unknown[])[0])).toContain("unknown_ip_queue");
  });

  it("still throws the 404 when the queue insert fails", async () => {
    // The range lookup returns nothing; the queue insert blows up. The
    // caller asked for a 404 and must get one — the queue write is
    // fire-and-forget and must never mask the miss.
    const queries: unknown[] = [];
    let index = 0;
    const pool = {
      query: vi.fn(async (...args: unknown[]) => {
        queries.push(args);
        index++;
        if (index === 1) return [[], []];
        throw new Error("pool exhausted");
      }),
    };
    const log = stubLogger();

    const err = await doLookupCore(pool as never, log, "203.0.113.9").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { statusCode?: number }).statusCode).toBe(404);
    expect((err as { code?: string }).code).toBe("not_found");

    // The failure was logged rather than swallowed silently.
    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]![1]).toContain("unknown_ip_queue insert failed");
  });
});
