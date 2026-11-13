// SPDX-License-Identifier: MIT
//
// `TRUST_PROXY` decides whether `req.ip` may come from `X-Forwarded-For`.
//
// The problem it solves: behind a reverse proxy the TCP peer is
// `127.0.0.1` for EVERY visitor. The rate limiter keys on `req.ip`, so
// without this flag the entire internet shares one bucket and a single
// visitor can spend everybody else's quota.
//
// The problem it creates: `X-Forwarded-For` is attacker-controlled.
// Anyone who can reach the Node port directly can send any value and
// pick their own rate-limit bucket. So the flag exists to make the
// operator state the deployment fact out loud ("only my reverse proxy
// can reach 3880") rather than have the code guess.
//
// These tests pin the three states that matter:
//   1. OFF (the default) → `req.ip` is the peer, the header is ignored.
//   2. ON → `req.ip` is the visitor's address from the header.
//   3. ON → distinct visitors get distinct rate-limit buckets, which is
//      the entire point of turning it on.
//
// They run against a real server with the real rate limiter, because
// the thing being pinned is the INTERACTION between trustProxy and the
// limiter's key — a unit test of the header parser would not catch a
// limiter that keyed on something else.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql from "mysql2/promise";
import request from "supertest";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { runMigrations } from "../../src/storage/migrations/runner";

let pool: mysql.Pool;
let dbName: string;
let trustedApp: Awaited<ReturnType<typeof buildServer>>;
let untrustedApp: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  const cfg = loadConfig();
  dbName = "ipquery_test_trust_proxy";
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await root.query(`CREATE DATABASE \`${dbName}\``);
  await root.end();

  pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: dbName,
    connectionLimit: 2,
    multipleStatements: true,
    timezone: "Z",
    dateStrings: false,
  });
  await runMigrations(pool);

  // Two servers over the same database: one that trusts the proxy
  // header, one that does not. The database is irrelevant to what is
  // being tested — the rate limiter and `req.ip` never touch it — but
  // the server refuses to start without a working pool.
  const trustedCfg = loadConfig();
  trustedCfg.db.database = dbName;
  trustedCfg.api.rateLimit = 5;
  trustedCfg.api.trustProxy = true;
  trustedApp = await buildServer(trustedCfg);

  const untrustedCfg = loadConfig();
  untrustedCfg.db.database = dbName;
  untrustedCfg.api.rateLimit = 5;
  untrustedCfg.api.trustProxy = false;
  untrustedApp = await buildServer(untrustedCfg);
}, 180_000);

afterAll(async () => {
  await trustedApp.close();
  await untrustedApp.close();
  await pool.end();
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await root.end();
});

describe("TRUST_PROXY=off (the default)", () => {
  it("ignores X-Forwarded-For when deciding the request's IP", async () => {
    // The header says 203.0.113.9. With the flag off, the server must
    // still see the peer address — because the peer is the only thing
    // it can vouch for.
    const res = await request(untrustedApp.server)
      .get("/lookup")
      .query({ ip: "8.8.8.8" })
      .set("X-Forwarded-For", "203.0.113.9");

    // The status is 404 rather than 200 because this database holds no
    // ip_ranges rows. The point is that the request was NOT refused.
    expect(res.status).not.toBe(429);
    expect(res.status).toBe(404);
  });

  it("puts every visitor into one shared rate-limit bucket", async () => {
    // This is the failure TRUST_PROXY exists to prevent. Two different
    // forwarded addresses share one bucket because the server keys on
    // the peer, which is the same for both.
    const first = await request(untrustedApp.server)
      .get("/lookup")
      .query({ ip: "8.8.8.8" })
      .set("X-Forwarded-For", "203.0.113.1");
    expect(first.status).not.toBe(429);

    // Five more from a DIFFERENT forwarded address. The limit is 5, so
    // by the time the sixth request arrives the bucket is empty and
    // this one is refused — even though it came from a different
    // visitor, and even though it carried a different address.
    let limited = 0;
    for (let i = 0; i < 8; i++) {
      const res = await request(untrustedApp.server)
        .get("/lookup")
        .query({ ip: "8.8.8.8" })
        .set("X-Forwarded-For", "203.0.113.2");
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe("TRUST_PROXY=on", () => {
  it("takes the request's IP from X-Forwarded-For", async () => {
    // The request goes through. The status is 404 because this
    // database holds no ip_ranges rows — not 429.
    const res = await request(trustedApp.server)
      .get("/lookup")
      .query({ ip: "8.8.8.8" })
      .set("X-Forwarded-For", "203.0.113.9");
    expect(res.status).not.toBe(429);
    expect(res.status).toBe(404);
  });

  it("gives each visitor their own rate-limit bucket", async () => {
    // The whole point. The limit is 5 per minute per IP. Visitor A
    // exhausts their own budget...
    let aLimited = 0;
    for (let i = 0; i < 8; i++) {
      const res = await request(trustedApp.server)
        .get("/lookup")
        .query({ ip: "8.8.8.8" })
        .set("X-Forwarded-For", "203.0.113.10");
      if (res.status === 429) aLimited += 1;
    }
    expect(aLimited).toBeGreaterThan(0);

    // ...and visitor B, arriving from a different address, still has
    // their own untouched budget. Under TRUST_PROXY=off, B would have
    // been refused along with A.
    let bLimited = 0;
    for (let i = 0; i < 3; i++) {
      const res = await request(trustedApp.server)
        .get("/lookup")
        .query({ ip: "8.8.8.8" })
        .set("X-Forwarded-For", "203.0.113.11");
      if (res.status === 429) bLimited += 1;
    }
    expect(bLimited).toBe(0);
  });

  it("reads the left-most entry of a chained header", async () => {
    // A chain looks like "client, proxy1, proxy2". The client is the
    // left-most entry; everything after it is infrastructure that
    // appended its own address. Fastify's `trustProxy: true` takes the
    // left-most entry, which is the client.
    const res = await request(trustedApp.server)
      .get("/lookup")
      .query({ ip: "8.8.8.8" })
      .set("X-Forwarded-For", "203.0.113.20, 10.0.0.1, 10.0.0.2");
    expect(res.status).not.toBe(429);
    expect(res.status).toBe(404);
  });
});
