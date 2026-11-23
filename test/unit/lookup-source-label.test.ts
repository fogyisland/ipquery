// SPDX-License-Identifier: MIT
//
// The API must not name a data source that does not exist.
//
// The pipeline parses six file families and writes six row-level source
// labels: dbip, dbip-country, dbip-asn, metowolf-cn, runishiwo-cn and
// sapics-user. It has never written "maxmind" or "ipinfo" — neither
// source was ever wired into the pipeline.
//
// The lookup core used to fall back to "maxmind" for a row whose source
// column is empty, which is the case for a large part of the live table:
// 198,157 rows have no country_source and 8,152,112 have no isp_source.
// Every one of those answers said the data came from MaxMind, a source
// this project never fetched. A caller who trusts the field is told
// something false about where the data came from.
//
// The honest answer for a row with no recorded source is that the source
// is unknown. "unknown" is a real answer to "where did this come from?";
// "maxmind" is not.
import { describe, it, expect, vi } from "vitest";
import { doLookupCore, type CoreLogger } from "../../src/lookup-core";
import { parseIp } from "../../src/ip";

/**
 * A pool stub whose query() returns whatever the test queues up.
 */
function stubPool(responses: Array<unknown>): { pool: unknown } {
  let index = 0;
  const pool = {
    query: vi.fn(async () => {
      const next = responses[index++];
      return next ?? [[], []];
    }),
  };
  return { pool };
}

/** A logger that records warnings instead of printing them. */
function stubLogger(): CoreLogger {
  return { warn: () => undefined };
}

/**
 * A row with every source column empty — the shape of a row inserted
 * before the source columns existed, or by a backfill that did not
 * record one.
 */
function rowWithoutSources(overrides: Record<string, unknown> = {}) {
  return {
    start_ip: parseIp("8.8.8.0"),
    end_ip: parseIp("8.8.8.255"),
    country_code: "US",
    country_name: null,
    region: "California",
    city: "Mountain View",
    postal_code: "94043",
    latitude: 37.4056,
    longitude: -122.0775,
    timezone: "America/Los_Angeles",
    isp: "Google LLC",
    asn: 15169,
    asn_org: "GOOGLE",
    country_source: null,
    city_source: null,
    isp_source: null,
    asn_source: null,
    geo_source: null,
    range_size: "256",
    ...overrides,
  };
}

describe("The source label on a row with no recorded source", () => {
  it("does not claim the data came from a source the pipeline never ran", async () => {
    const { pool } = stubPool([[[rowWithoutSources()], []], [[], []]]);
    const log = stubLogger();

    const result = await doLookupCore(pool as never, log, "8.8.8.8");

    // Every source field must be absent of the dead sources.
    const sources = [
      result.country.source,
      result.city?.source,
      result.location?.source,
      result.isp?.source,
      result.asn?.source,
    ].filter((s): s is string => typeof s === "string");

    for (const source of sources) {
      expect(source).not.toBe("maxmind");
      expect(source).not.toBe("ipinfo");
    }
  });

  it("says the source is unknown instead of naming one", async () => {
    const { pool } = stubPool([[[rowWithoutSources()], []], [[], []]]);
    const log = stubLogger();

    const result = await doLookupCore(pool as never, log, "8.8.8.8");

    expect(result.country.source).toBe("unknown");
    expect(result.city?.source).toBe("unknown");
    expect(result.location?.source).toBe("unknown");
    expect(result.isp?.source).toBe("unknown");
    expect(result.asn?.source).toBe("unknown");
  });

  it("keeps the real source when the row has one", async () => {
    // The fallback must not overwrite what the row actually records.
    const { pool } = stubPool([
      [
        [
          rowWithoutSources({
            country_source: "dbip",
            city_source: "dbip",
            geo_source: "dbip",
            isp_source: "dbip",
            asn_source: "dbip-asn",
          }),
        ],
        [],
      ],
      [[], []],
    ]);
    const log = stubLogger();

    const result = await doLookupCore(pool as never, log, "8.8.8.8");

    expect(result.country.source).toBe("dbip");
    expect(result.city?.source).toBe("dbip");
    expect(result.asn?.source).toBe("dbip-asn");
  });

  it("keeps the manual tags the project itself writes", async () => {
    // 'multi-provider' (the unknown-IP backfill), 'import' (the range
    // importer) and 'seed' (the demo loader) are written by this
    // project, not by the ETL — and each of them is the only record
    // of who wrote the row. Reporting "unknown" for them would say
    // the origin was not recorded when it was.
    for (const tag of ["multi-provider", "import", "seed"]) {
      const { pool } = stubPool([
        [
          [
            rowWithoutSources({
              country_source: tag,
              city_source: tag,
              geo_source: tag,
              isp_source: tag,
              asn_source: tag,
            }),
          ],
          [],
        ],
        [[], []],
      ]);
      const log = stubLogger();

      const result = await doLookupCore(pool as never, log, "8.8.8.8");

      expect(result.country.source, `${tag} was normalized away`).toBe(tag);
      expect(result.city?.source, `${tag} was normalized away`).toBe(tag);
      expect(result.isp?.source, `${tag} was normalized away`).toBe(tag);
    }
  });
});
