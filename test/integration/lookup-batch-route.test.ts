// SPDX-License-Identifier: MIT
//
// The public API can look up one address per request.
//
// A caller reconciling a traffic batch — a log file, a CDN's origin list,
// an abuse report — pays one round trip per address. That is fine for a
// single lookup and miserable for a thousand, and the MCP server already
// answers up to a hundred at once. The HTTP API offered no equivalent, so
// the one client that speaks HTTP had no way to ask.
//
// The endpoint is a POST, not a GET with a query string: a hundred
// addresses do not fit in a URL, and a URL lands in every access log and
// proxy log along the way. A body does not.
//
// The batch never fails as a whole. One malformed address does not cost
// the caller the other ninety-nine answers — the bad one is marked and
// the rest land, which is the only shape that is useful for reconciliation.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import { buildServer } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import {
  createPool,
  runMigrations,
  truncateNew,
  insertIntoNew,
  atomicSwapRanges,
} from "../../src/storage/mysql";
import { markInitialized } from "../../src/storage/settings";

const TEST_DB = "ipquery_lookup_batch_test";
const cfg = loadConfig();
let app: Awaited<ReturnType<typeof buildServer>>;

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
  const pool = createPool(cfg);
  await runMigrations(pool);
  await markInitialized(pool);
  await truncateNew(pool);
  await insertIntoNew(pool, [
    {
      startIp: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 8, 8, 0]),
      endIp: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 8, 8, 255]),
      countryCode: "US",
      countryName: "United States",
      city: "Mountain View",
      latitude: 37.4056,
      longitude: -122.0775,
      timezone: "America/Los_Angeles",
      countrySource: "dbip",
      citySource: "dbip",
      geoSource: "dbip",
    },
  ]);
  await atomicSwapRanges(pool);
  await pool.end();
  app = await buildServer(cfg);
});

afterAll(async () => {
  await app.close();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.end();
});

describe("POST /lookup/batch", () => {
  it("answers every address in one response, in the order asked", async () => {
    const res = await request(app.server)
      .post("/lookup/batch")
      .send({ ips: ["8.8.8.8", "192.168.1.1"] });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    // The order is the caller's order: a caller reconciling two logs has
    // to be able to line the answers up with the lines it asked about.
    expect(res.body.results.map((r: { ip: string }) => r.ip)).toEqual([
      "8.8.8.8",
      "192.168.1.1",
    ]);
    expect(res.body.results[0].found).toBe(true);
    expect(res.body.results[0].result.country.code).toBe("US");
    expect(res.body.results[0].result.city.name).toBe("Mountain View");
    expect(res.body.found).toBe(1);
    expect(res.body.notFound).toBe(1);
  });

  it("marks a malformed address instead of failing the whole batch", async () => {
    // The batch is a reconciliation tool. One bad line in a log file must
    // not cost the caller the other ninety-nine answers — that would make
    // the endpoint worse than no endpoint at all.
    const res = await request(app.server)
      .post("/lookup/batch")
      .send({ ips: ["not.an.ip", "8.8.8.8"] });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.results[0].found).toBe(false);
    expect(res.body.results[0].error).toBe("invalid_ip");
    expect(res.body.results[1].found).toBe(true);
    expect(res.body.found).toBe(1);
  });

  it("answers an address the library does not know as a miss, not an error", async () => {
    // A miss is an answer. The library does not know this address; that
    // is a fact about the data, not a failure of the request.
    const res = await request(app.server)
      .post("/lookup/batch")
      .send({ ips: ["192.168.1.1"] });

    expect(res.status).toBe(200);
    expect(res.body.results[0].found).toBe(false);
    expect(res.body.results[0].error).toBe("not_found");
    expect(res.body.notFound).toBe(1);
  });

  it("refuses a body that is not a list of addresses", async () => {
    const res = await request(app.server).post("/lookup/batch").send({ ips: "8.8.8.8" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("refuses a body with no addresses at all", async () => {
    const res = await request(app.server).post("/lookup/batch").send({ ips: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("caps the batch, and says so rather than silently truncating", async () => {
    // The cap exists so one request cannot ask for an unbounded amount of
    // work. A caller who asks for more than the cap is told — a silently
    // truncated answer set would be read as "these are all the answers",
    // and a reconciliation built on that would quietly miss rows.
    const tooMany = Array.from({ length: 101 }, () => "8.8.8.8");
    const res = await request(app.server).post("/lookup/batch").send({ ips: tooMany });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("counts the batch against the public API's rate limit", async () => {
    // The rate limiter's allow-list is an exact set of paths. A new
    // public endpoint that is not in that set would be unlimited — and
    // this one asks the server to do up to a hundred lookups at once, so
    // being unlimited is exactly wrong.
    const { isPublicApiPath } = await import("../../src/api/server");
    expect(isPublicApiPath("/lookup/batch")).toBe(true);
  });
});
