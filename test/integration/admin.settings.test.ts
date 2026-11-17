// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("admin-settings");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  // Force non-empty secrets so the redacted path is exercised and so that
  // accidental leakage of raw values would be detectable in the HTML body.
  // NOTE: do not mutate cfg.db.password — it is used by createPool to connect.
  cfg.web.sessionSecret = "super-secret-session-key-abcdefgh";
  cfg.web.csrfSecret = "csrf-secret-key-1234567890";
  cfg.smtp.pass = "smtp-pass-secret-ABC";
  cfg.maxmind.licenseKey = "mm-license-key-9999";
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "admin@x",
    passwordHash: "h",
    displayName: "A",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
});
afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

describe("admin settings", () => {
  it("renders without exposing raw secrets", async () => {
    const r = await request(app.server)
      .get("/admin/settings")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    // Raw secret strings must not appear anywhere in the rendered HTML.
    expect(r.text).not.toMatch(/super-secret-session-key-abcdefgh/);
    expect(r.text).not.toMatch(/csrf-secret-key-1234567890/);
    expect(r.text).not.toMatch(/smtp-pass-secret-ABC/);
    expect(r.text).not.toMatch(/mm-license-key-9999/);
    // redactSecret outputs "••••1234" pattern (first 4 + … + last 4) when the
    // value is > 8 chars. Assert the redacted form is present for at least
    // sessionSecret so we didn't accidentally render the literal "(unset)".
    expect(r.text).toMatch(/super&#8230;|super…|…cdefgh|…efgh|cdefgh|efgh/);
  });

  it("reports which migrations the database is missing", async () => {
    // The schema report is the difference between "this deployment runs"
    // and "this deployment runs the schema this code was written against".
    // A page that shows the connection but not the version leaves an
    // operator guessing after every upgrade.
    await td.pool.query("DELETE FROM schema_migrations WHERE version = '031'");
    try {
      const r = await request(app.server)
        .get("/admin/settings")
        .set("Cookie", "sid=" + adminSid);
      expect(r.status).toBe(200);
      // The pending step is named, not just counted.
      expect(r.text).toMatch(/031_retire_ipinfo/);
    } finally {
      await td.pool.query("INSERT INTO schema_migrations (version) VALUES ('031')");
    }
  });

  it("says which pending steps rebuild a table", async () => {
    // 027 rewrites three ETL stage tables. On a library-sized install that
    // is a lock an operator has to plan a window for, so it cannot be
    // presented as an ordinary pending step.
    const before = await td.pool.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    const recorded = (before[0] as Array<{ version: string }>).map((r) => r.version);
    await td.pool.query(
      `DELETE FROM schema_migrations WHERE version IN ('027', '028')`,
    );
    try {
      const r = await request(app.server)
        .get("/admin/settings")
        .set("Cookie", "sid=" + adminSid);
      expect(r.status).toBe(200);
      // Only 027 rebuilds a table; 028 deletes rows.
      const flagged = r.text.split("schema-migration-item").filter((c) => /takes-table-lock/.test(c));
      expect(flagged.join("|")).toMatch(/027_multi_source_etl/);
      expect(flagged.join("|")).not.toMatch(/028_retire_dead_providers/);
    } finally {
      for (const v of ["027", "028"]) {
        if (recorded.includes(v)) {
          await td.pool.query("INSERT INTO schema_migrations (version) VALUES (?)", [v]);
        }
      }
    }
  });

  it("surfaces a table whose structure the migrations cannot account for", async () => {
    // The ledger and the table can disagree. Every migration recorded as
    // applied, and a column somebody dropped by hand — `migrate` will not
    // bring it back, so the page has to say which table is wrong rather
    // than report "in step".
    await td.pool.query("ALTER TABLE settings DROP COLUMN updated_at");
    try {
      const r = await request(app.server)
        .get("/admin/settings")
        .set("Cookie", "sid=" + adminSid);
      expect(r.status).toBe(200);
      expect(r.text).toMatch(/schema-drift/);
      expect(r.text).toMatch(/settings\.updated_at/);
    } finally {
      await td.pool.query(
        "ALTER TABLE settings ADD COLUMN updated_at DATETIME(3) NOT NULL " +
          "DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)",
      );
    }
  });

  it("says the schema is in step when there is nothing pending", async () => {
    const r = await request(app.server)
      .get("/admin/settings")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    // The applied list is what an operator reads to confirm a deploy went
    // through; without it the card can only report bad news.
    expect(r.text).toMatch(/schema-migration-item/);
  });

  it("shows whether the reverse-proxy header is trusted", async () => {
    // The trustProxy state is a deployment fact with a silent failure
    // mode: if it is off while a proxy is in front, every visitor shares
    // one rate-limit bucket and nothing looks broken until one visitor
    // exhausts everybody's quota. The operator has to be able to confirm
    // the state from the settings page instead of grepping the .env.
    const r = await request(app.server)
      .get("/admin/settings")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);
    // The default in this test config is off, so the page must say so.
    expect(r.text).toMatch(/信任反代头|Trust proxy header/);
    expect(r.text).not.toMatch(/TRUST_PROXY=true/);
  });

  it("POST /admin/settings/etl-restart works", async () => {    // GET first so the server sets the csrf cookie on the response jar.
    const getRes = await request(app.server)
      .get("/admin/settings")
      .set("Cookie", "sid=" + adminSid);
    expect(getRes.status).toBe(200);
    const csrfCookie = getRes.headers["set-cookie"]?.find((c) => c.startsWith("csrf="));
    expect(csrfCookie).toBeDefined();
    const csrfValue = decodeURIComponent(csrfCookie!.split(";")[0].split("=")[1]);
    const csrfIssuedCookie = getRes.headers["set-cookie"]?.find((c) => c.startsWith("csrf_issued="));
    const csrfIssued = csrfIssuedCookie
      ? decodeURIComponent(csrfIssuedCookie.split(";")[0].split("=")[1])
      : "";
    // The CSRF binding check also needs the httpOnly HMAC cookie.
    const csrfBindCookie = getRes.headers["set-cookie"]?.find((c) => c.startsWith("csrf_bind="));
    const csrfBind = csrfBindCookie ? csrfBindCookie.split(";")[0].split("=")[1] : "";
    const post = await request(app.server)
      .post("/admin/settings/etl-restart")
      .set("Cookie", `sid=${adminSid}; csrf=${csrfValue}; csrf_issued=${csrfIssued}; csrf_bind=${csrfBind}`)
      .type("form")
      .send({ csrf: csrfValue });
    // Success: redirect to /admin/settings (302). Brief says "works" so we
    // require neither 404 nor 500; a 302 to the settings page is the happy path.
    expect(post.status).not.toBe(404);
    expect(post.status).not.toBe(500);
    expect(post.status).toBe(302);
    // The tabbed settings redesign anchors the ETL controls on the
    // Integrations pane, so the handler redirects to that hash.
    expect(post.headers.location).toBe("/admin/settings#integrations");
  });
});
