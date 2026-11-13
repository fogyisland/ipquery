// SPDX-License-Identifier: MIT
// Integration test: the /try result renders a map for the looked-up IP.
//
// The coordinates were already in the database (ip_ranges.latitude /
// longitude) and already in the lookup core (LookupResult.location) —
// nothing ever rendered them. This pins the rendering, and the two
// properties that make the map safe to ship:
//
//   1. It is an inline SVG drawn by the server. No tile server, no
//      client-side map library, no request that would hand the
//      visitor's IP address to a third party.
//   2. The marker lands on the right spot — the projection is
//      arithmetic, so the expected position can be computed here and
//      compared against what the page emits.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { csrfTripleFrom } from "../helpers/csrf";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;

// A /24 in right-aligned 16-byte form — the shape parseIp() writes
// (an IPv4 address occupies the LAST four bytes), covering
// 203.0.113.0 — TEST-NET-3, reserved for documentation, so it can
// never collide with real traffic.
const RANGE_START = "000000000000000000000000cb007100";
const RANGE_END = "000000000000000000000000cb00717f";
// Mount Fuji-ish coordinates, well inside the map.
const LATITUDE = 35.6762;
const LONGITUDE = 139.6503;

beforeAll(async () => {
  td = await createTestDb("marketing_map");
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
  await td.pool.query(
    `INSERT INTO ip_ranges
       (start_ip, end_ip, range_size, country_code, country_name, region, city,
        latitude, longitude, geo_source, country_source, city_source)
     VALUES (UNHEX(?), UNHEX(?), 255, 'JP', 'Japan', 'Tokyo', 'Tokyo',
             ?, ?, 'maxmind', 'maxmind', 'maxmind')`,
    [RANGE_START, RANGE_END, LATITUDE, LONGITUDE],
  );
});

/** POST /try with a valid CSRF triple and return the response. */
async function tryIp(ip: string): Promise<request.Response> {
  const page = await request(app.server).get("/try");
  const pair = csrfTripleFrom(page.headers["set-cookie"] as string[]);
  return request(app.server)
    .post("/try")
    .set("Cookie", pair.cookie)
    .type("form")
    .send({ csrf: pair.token, ip });
}

describe("/try renders a map for the looked-up IP", () => {
  it("draws the map when the record has coordinates", async () => {
    const r = await tryIp("203.0.113.10");
    expect(r.status).toBe(200);
    // The map container and the inline SVG.
    expect(r.text).toContain("m-result-map");
    expect(r.text).toContain("<svg");
    expect(r.text).toContain('class="m-map-svg"');
    // The land outline is present — the map is not an empty frame.
    expect(r.text).toContain("m-map-land");
    expect(r.text).toContain("m-map-marker-dot");
  });

  it("places the marker at the projected position", async () => {
    const r = await tryIp("203.0.113.10");
    expect(r.status).toBe(200);
    // Equirectangular: x = (lon + 180) / 360 * 720,
    //                y = (90 - lat) / 180 * 360.
    const expectedX = ((LONGITUDE + 180) / 360) * 720;
    const expectedY = ((90 - LATITUDE) / 180) * 360;
    const dot = /<circle cx="([\d.]+)" cy="([\d.]+)" r="3\.5"/.exec(r.text);
    expect(dot).not.toBeNull();
    expect(Number(dot![1])).toBeCloseTo(expectedX, 1);
    expect(Number(dot![2])).toBeCloseTo(expectedY, 1);
  });

  it("shows the coordinates as readable text with a source tag", async () => {
    const r = await tryIp("203.0.113.10");
    expect(r.status).toBe(200);
    expect(r.text).toContain("35.68°N");
    expect(r.text).toContain("139.65°E");
    expect(r.text).toContain("maxmind");
  });

  it("keeps the map free of any third-party request", async () => {
    const r = await tryIp("203.0.113.10");
    expect(r.status).toBe(200);
    // No tile server, no external map host, no CDN.
    expect(r.text).not.toMatch(/tile\.openstreetmap|maps\.googleapis|mapbox|leaflet/i);
    // No inline script — the CSP forbids it, and the map does not need it.
    expect(r.text).not.toMatch(/<script(?![^>]*src=)[^>]*>[^<]*\S/);
  });

  it("omits the map when the record has no coordinates", async () => {
    await td.pool.query(`UPDATE ip_ranges SET latitude = NULL, longitude = NULL`);
    const r = await tryIp("203.0.113.10");
    expect(r.status).toBe(200);
    // The result still renders — the map is an addition, not a
    // precondition for showing the lookup result at all.
    expect(r.text).toContain("m-result-panel");
    expect(r.text).not.toContain("m-map-svg");
  });
});
