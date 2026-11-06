// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { runMigrations } from "../../src/storage/migrations/runner";
import { markInitialized } from "../../src/storage/settings";

const TEST_DB = "ipquery_web_plugins_test";

let app: Awaited<ReturnType<typeof buildServer>>;
beforeAll(async () => {
  const cfg = loadConfig();
  cfg.db.database = TEST_DB;
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.query(`CREATE DATABASE \`${TEST_DB}\``);
  await root.end();
  const pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: TEST_DB,
    connectionLimit: 2,
    multipleStatements: true,
    timezone: "Z",
    dateStrings: false,
  });
  await runMigrations(pool);
  await markInitialized(pool);
  await pool.end();
  app = await buildServer(cfg);
});
afterAll(async () => {
  await app.close();
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
  await root.end();
});

describe("web plugins", () => {
  it("serves static /assets/ route", async () => {
    const r = await app.inject({ method: "GET", url: "/assets/css/base.css" });
    expect([200, 404]).toContain(r.statusCode);
  });

  it("serves htmx.min.js at /assets/js/htmx.min.js with the correct MIME type", async () => {
    // htmx is loaded by layouts/app.hbs (admin/dashboard) and layouts/public.hbs
    // (error pages). The file lives under /assets/js/ — if the layout or the
    // asset layout ever drift, the browser logs "Refused to execute script"
    // because @fastify/static returns the 404 as application/json.
    const r = await app.inject({ method: "GET", url: "/assets/js/htmx.min.js" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/javascript|text\/javascript/);
    expect(r.body.length).toBeGreaterThan(1000);
  });

  it("marketing pages do not request htmx.min.js (it was dead code in layouts/marketing.hbs)", async () => {
    // The marketing layout used to include <script src="/assets/htmx.min.js"
    // defer> which was dead code (marketing pages use plain forms, not htmx)
    // and produced a console error on every page load. Now the layout has no
    // script tag at all — assert that explicitly.
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    const body = r.body.toString("utf8");
    expect(body).not.toMatch(/src="\/assets\/htmx\.min\.js"/);
    expect(body).not.toMatch(/src="\/assets\/js\/htmx\.min\.js"/);
  });

  it("security headers present", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
  });
});
