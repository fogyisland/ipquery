// SPDX-License-Identifier: MIT
// Integration test: the country / region shown on /try.
//
// `ip_ranges.country_name` is NULL for every row the ETL loads: DB-IP's
// free CSVs carry a country *code* only (the city-lite file is
// `start,end,continent,country,region,city,lat,lon` — there is no
// country-name column), and MaxMind, the one source with a name column,
// never runs through the pipeline because it needs a licence key this
// project doesn't have.
//
// The visible consequence was that a Hong Kong address answered "HK"
// under a heading that said "国家" (country). This pins the two halves
// of the fix: the label says "国家/地区", and the name comes from the
// ISO 3166-1 table rather than being absent.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { csrfTripleFrom } from "../helpers/csrf";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;

// A /24 in right-aligned 16-byte form — the shape parseIp() writes.
const RANGE_START = "000000000000000000000000cb007100";
const RANGE_END = "000000000000000000000000cb00717f";

beforeAll(async () => {
  td = await createTestDb("marketing_country");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

beforeEach(async () => {
  await td.pool.query(`DELETE FROM ip_ranges`);
});

/** Insert one range with the given country code and name. */
async function insertRange(countryCode: string, countryName: string | null): Promise<void> {
  await td.pool.query(
    `INSERT INTO ip_ranges
       (start_ip, end_ip, range_size, country_code, country_name, region, city,
        country_source, city_source)
     VALUES (UNHEX(?), UNHEX(?), 255, ?, ?, 'Central and Western', 'Central',
             'dbip', 'dbip')`,
    [RANGE_START, RANGE_END, countryCode, countryName],
  );
}

/** POST /try with a valid CSRF triple and return the response. */
async function tryIp(ip: string, lang?: string): Promise<request.Response> {
  const page = await request(app.server).get("/try");
  const pair = csrfTripleFrom(page.headers["set-cookie"] as string[]);
  const req = request(app.server)
    .post("/try")
    .set("Cookie", pair.cookie)
    .type("form")
    .send({ csrf: pair.token, ip });
  if (lang) req.set("Cookie", `${pair.cookie}; lang=${lang}`);
  return req;
}

describe("/try shows the country or region", () => {
  it("labels the field '国家/地区' rather than '国家'", async () => {
    await insertRange("HK", null);
    const r = await tryIp("203.0.113.10");
    expect(r.status).toBe(200);
    expect(r.text).toContain("国家/地区");
    // The old label is gone from this page.
    expect(r.text).not.toMatch(/<dt>国家<\/dt>/);
  });

  it("names Hong Kong in Chinese for a Chinese visitor", async () => {
    await insertRange("HK", null);
    const r = await tryIp("203.0.113.10");
    expect(r.status).toBe(200);
    // The Chinese name, not the bare code and not the English one.
    expect(r.text).toContain("香港");
    // The code stays visible alongside the name.
    expect(r.text).toContain("HK");
  });

  it("names Hong Kong in English for an English visitor", async () => {
    await insertRange("HK", null);
    const r = await tryIp("203.0.113.10", "en-US");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Hong Kong");
    expect(r.text).toContain("Country/Region");
    expect(r.text).not.toContain("香港");
  });

  it("names Macao and Taiwan as their own regions, not as China", async () => {
    await insertRange("MO", null);
    const mo = await tryIp("203.0.113.10");
    expect(mo.status).toBe(200);
    expect(mo.text).toContain("澳门");

    await td.pool.query(`DELETE FROM ip_ranges`);
    await insertRange("TW", null);
    const tw = await tryIp("203.0.113.10");
    expect(tw.status).toBe(200);
    expect(tw.text).toContain("台湾");
    expect(tw.text).not.toContain("中国");
  });

  it("prefers the name the data source supplied over the ISO fallback", async () => {
    await insertRange("HK", "Hong Kong SAR");
    const r = await tryIp("203.0.113.10");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Hong Kong SAR");
  });

  it("falls back to the code for a country it does not know", async () => {
    // "ZZ" is the ISO user-assigned code the ETL uses for unknown rows.
    await insertRange("ZZ", null);
    const r = await tryIp("203.0.113.10");
    expect(r.status).toBe(200);
    // The result still renders; the code is shown because that is all we know.
    expect(r.text).toContain("m-result-panel");
    expect(r.text).toContain("ZZ");
  });
});
