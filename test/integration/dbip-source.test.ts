import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { parseDbipCsv, parseDbipCountryCsv, parseDbipAsnCsv } from "../../src/etl/sources/dbip";

const fixtures = path.join(__dirname, "..", "..", "fixtures");

describe("dbip city-lite source", () => {
  it("parses fixture CSV.gz into NormalizedRecords with country/region/city", async () => {
    const records = await parseDbipCsv(path.join(fixtures, "dbip-sample.csv.gz"));
    expect(records).toHaveLength(3);
    expect(records[0]?.source).toBe("dbip");
    // Real DB-IP city-lite column order is start, end, continent, country,
    // region, city, lat, lon — the country is cols[3], NOT cols[2].
    expect(records[0]?.countryCode).toBe("US");
    expect(records[0]?.region).toBe("California");
    expect(records[0]?.city).toBe("Mountain View");
    expect(records[2]?.startIp.length).toBe(16); // IPv6 stored in 16-byte buffer
  });

  it("attaches source = dbip to every record", async () => {
    const records = await parseDbipCsv(path.join(fixtures, "dbip-sample.csv.gz"));
    for (const r of records) expect(r.source).toBe("dbip");
  });
});

describe("dbip country-lite source", () => {
  it("parses only the country code (no region/city)", async () => {
    const records = await parseDbipCountryCsv(path.join(fixtures, "dbip-country-sample.csv.gz"));
    expect(records).toHaveLength(3);
    expect(records[0]?.countryCode).toBe("US");
    expect(records[0]?.region).toBeUndefined();
    expect(records[0]?.city).toBeUndefined();
    expect(records[1]?.countryCode).toBe("AU");
  });
});

describe("dbip asn-lite source", () => {
  it("parses ASN number and organization (no country)", async () => {
    const records = await parseDbipAsnCsv(path.join(fixtures, "dbip-asn-sample.csv.gz"));
    expect(records).toHaveLength(3);
    expect(records[0]?.asn).toBe(15169);
    expect(records[0]?.asnOrg).toBe("Google LLC");
    expect(records[1]?.asn).toBe(13335);
    expect(records[1]?.asnOrg).toBe("Cloudflare, Inc.");
    // quoted orgs with embedded commas should round-trip cleanly
    expect(records[0]?.countryCode).toBeUndefined();
  });
});
