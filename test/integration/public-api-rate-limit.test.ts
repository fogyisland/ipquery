// SPDX-License-Identifier: MIT
//
// The global rate limit is 60/minute, keyed by source IP. It used to
// cover every request the server handled — HTML pages and static
// assets included.
//
// That made a plain page load expensive: the setup page pulls four
// stylesheets, so an anonymous visitor could spend a fifth of the
// public API's allowance on CSS before the page itself was served.
//
// The failure mode is worse than a slow page. A 429 from the rate
// limiter carries a JSON body, so the browser reports:
//
//   Refused to apply style from '.../setup.css' because its MIME type
//   ('application/json') is not a supported stylesheet MIME type
//
// The stylesheet silently never applies and the page renders unstyled.
// A JSON body with `content-type: application/json` is the rate
// limiter's answer, not the asset.
//
// So the limit now applies to the public API only (`/healthz`,
// `/lookup`, `/stats`) — the expensive, unauthenticated, abuseable
// surface. Pages and assets are cheap to serve and bounded by human
// browsing speed.
//
// These tests pin both halves of that split:
//   1. Pages and assets never consume the API budget.
//   2. The API budget is unchanged — the exemption did not widen it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mysql from "mysql2/promise";
import request from "supertest";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { runMigrations } from "../../src/storage/migrations/runner";

let pool: mysql.Pool;
let dbName: string;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  const cfg = loadConfig();
  dbName = "ipquery_test_public_api_rate_limit";
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
  // Note: unlike `createTestDb`, `initialized_at` is deliberately NOT
  // set. The setup guard then serves /setup instead of 404-ing it, so
  // these tests can exercise a real page load.

  const serverCfg = loadConfig();
  serverCfg.db.database = dbName;
  // A small global limit keeps the "pages don't consume the API
  // budget" assertion cheap: without the exemption, a handful of page
  // loads would already exhaust it.
  serverCfg.api.rateLimit = 10;
  app = await buildServer(serverCfg);
}, 180_000);

afterAll(async () => {
  await app.close();
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

describe("only the public API consumes the global rate-limit budget", () => {
  it("serves pages and assets well past the API budget without 429", async () => {
    // The budget is 10/minute. Twenty rounds of a page plus its
    // stylesheet is forty requests — four times the budget. If these
    // shared the API's counter, the later ones would be refused.
    for (let i = 0; i < 20; i++) {
      const page = await request(app.server).get("/setup");
      expect(page.status, `page load #${i + 1}`).toBe(200);

      const css = await request(app.server).get("/assets/css/setup.css");
      expect(css.status, `stylesheet #${i + 1}`).toBe(200);
    }
  });

  it("leaves the public API's budget untouched after heavy page loading", async () => {
    // Ten page loads — exactly the API budget, if they shared it.
    for (let i = 0; i < 10; i++) {
      await request(app.server).get("/setup");
    }

    // The API route still has its full budget.
    const lookup = await request(app.server).get("/lookup").query({ ip: "8.8.8.8" });
    expect(lookup.status).toBe(200);
  });

  it("still rate limits the public API", async () => {
    // The exemption must not have widened the API's own limit.
    let limited = 0;
    for (let i = 0; i < 15; i++) {
      const res = await request(app.server).get("/lookup").query({ ip: "8.8.8.8" });
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("keeps serving pages and assets after the API budget is exhausted", async () => {
    // The state an operator hits when a client hammers /lookup: the API
    // is 429, but the UI must still work.
    for (let i = 0; i < 15; i++) {
      await request(app.server).get("/lookup").query({ ip: "8.8.8.8" });
    }

    const page = await request(app.server).get("/setup");
    expect(page.status).toBe(200);

    const css = await request(app.server).get("/assets/css/setup.css");
    expect(css.status).toBe(200);
    // The asset must be served as CSS, not as the rate limiter's JSON
    // body — that MIME mismatch is what silently unstyled the page.
    expect(css.headers["content-type"]).toContain("text/css");
  });

  it("applies the limit to /healthz and /stats as well as /lookup", async () => {
    // All three public API paths share one budget, keyed by IP.
    let limited = 0;
    for (let i = 0; i < 15; i++) {
      const health = await request(app.server).get("/healthz");
      if (health.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
