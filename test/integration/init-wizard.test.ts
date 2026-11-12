// SPDX-License-Identifier: MIT
// Integration test: full setup wizard E2E.
//
// Walks the full wizard end-to-end against a fresh DB and asserts cross-component
// behavior (routes + guard + bootstrap + login flow). Follows the same
// beforeAll/afterAll pattern as init-routes.test.ts (drop+create DB, do NOT
// call markInitialized so we can test the uninitialized path).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { buildServer } from "../../src/api/server";
import { getSetting, isInitialized } from "../../src/storage/settings";
import { isolateEnvFile, type EnvIsolation } from "../helpers/envIsolation";

const TEST_DB = "ipquery_test_setup_wizard_e2e";

interface TestDb {
  pool: mysql.Pool;
  dbName: string;
}

let td: TestDb;
// Pre-init: server built against a fresh DB with `initialized_at` not set.
let appPre: Awaited<ReturnType<typeof buildServer>>;
// Post-init: rebuilt after the wizard marks initialized_at; flips
// initGuard.requireSetup = false.
let appPost: Awaited<ReturnType<typeof buildServer>>;
// Keeps the wizard's .env writes out of the developer's project .env.
let envIsolation: EnvIsolation | undefined;

async function dropAndCreate(): Promise<TestDb> {
  const cfg = loadConfig();
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
  // NOTE: do NOT call markInitialized here — we want the uninitialized path.
  // initGuard's boot cache should read the missing `initialized_at` row and
  // flip `requireSetup=true`.
  return { pool, dbName: TEST_DB };
}

async function dropDb(dbName: string): Promise<void> {
  const cfg = loadConfig();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await root.end();
}

async function freshApp(): Promise<Awaited<ReturnType<typeof buildServer>>> {
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  return buildServer(cfg);
}

// Extract the csrf hidden input value from a rendered HBS page.
function extractCsrf(html: string): string {
  const m = /<input[^>]+name="csrf"[^>]+value="([^"]+)"/.exec(html);
  if (!m) throw new Error("csrf hidden input not found in page");
  return m[1]!;
}

// Extract both `csrf` and `csrf_issued` cookies so subsequent POSTs pass
// verifyCsrfRequest (the csrf plugin requires both — see
// src/web/plugins/csrf.ts).
function extractCsrfPair(headers: Record<string, unknown>): { cookie: string; token: string } {
  const raw = headers["set-cookie"] as string[] | undefined;
  if (!raw) throw new Error("no set-cookie header in response");
  const csrfCookie = raw.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
  const issuedCookie = raw.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
  const bindCookie = raw.find((c) => c.startsWith("csrf_bind="))!.split(";")[0]!;
  const tokenMatch = /csrf=([a-f0-9]+)/.exec(csrfCookie)!;
  return { cookie: `${csrfCookie}; ${issuedCookie}; ${bindCookie}`, token: tokenMatch[1]! };
}

// POST /init/<step> with CSRF, threaded through supertest agent so cookies
// (csrf, csrf_issued) carry forward between GET and POST.
async function wizardPost(
  agent: ReturnType<typeof request.agent>,
  path: string,
  fields: Record<string, string>,
): Promise<request.Response> {
  const getPage = await agent.get(path.replace("/init/", "/init/"));
  // GET e.g. /init/database returns the form with csrf input + cookies.
  const token = extractCsrf(getPage.text);
  return agent
    .post(path)
    .type("form")
    .send({ csrf: token, ...fields });
}

beforeAll(async () => {
  // Step 2 of the wizard writes the connection to a .env file. Without
  // this, it would write the TEST database into the developer's own
  // project .env and silently replace their working configuration.
  envIsolation = isolateEnvFile();
  td = await dropAndCreate();
  appPre = await freshApp();
});

afterAll(async () => {
  if (appPre) await appPre.close();
  if (appPost) await appPost.close();
  await td.pool.end();
  await dropDb(td.dbName);
  envIsolation?.restore();
});

describe("setup wizard E2E", () => {
  it("happy path: full wizard + login + admin access", async () => {
    const agent = request.agent(appPre.server);

    // Step 1 — welcome
    const welcome = await agent.get("/init");
    expect(welcome.status).toBe(200);
    expect(welcome.text).toContain('class="layout-setup"');

    // Step 2 — database. The step is a real configuration step: it
    // collects the connection details, proves they work and re-points the
    // live pool. So the POST carries them.
    const cfg = loadConfig();
    const dbPost = await wizardPost(agent, "/init/database", {
      host: cfg.db.host,
      port: String(cfg.db.port),
      user: cfg.db.user,
      password: cfg.db.password,
      database: td.dbName,
    });
    expect(dbPost.status).toBe(302);
    expect(dbPost.headers["location"]).toMatch(/^\/init\/site/);

    // Step 3 — site
    const sitePost = await wizardPost(agent, "/init/site", {
      name: "E2E Site",
      tagline: "integration test tagline",
    });
    expect(sitePost.status).toBe(302);
    expect(sitePost.headers["location"]).toMatch(/^\/init\/admin/);

    // Step 4 — admin
    const adminEmail = "e2e-admin@setup.test";
    const adminPassword = "longpassword1";
    const adminPost = await wizardPost(agent, "/init/admin", {
      email: adminEmail,
      password: adminPassword,
      displayName: "E2E Admin",
    });
    expect(adminPost.status).toBe(302);
    expect(adminPost.headers["location"]).toMatch(/^\/init\/seed/);

    // Step 5 — seed (load=true)
    const seedPost = await wizardPost(agent, "/init/seed", { load: "true" });
    expect(seedPost.status).toBe(302);
    expect(seedPost.headers["location"]).toMatch(/^\/init\/complete/);

    // Step 6 — complete
    const completePost = await wizardPost(agent, "/init/complete", {});
    expect(completePost.status).toBe(302);
    expect(completePost.headers["location"]).toMatch(/^\/login/);

    // Final DB state assertions:
    expect(await isInitialized(td.pool)).toBe(true);
    expect(await getSetting(td.pool, "site.name")).toBe("E2E Site");
    expect(await getSetting(td.pool, "site.tagline")).toBe("integration test tagline");

    const [userRows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT email, role, email_verified FROM users WHERE email = ?`,
      [adminEmail],
    );
    expect(userRows.length).toBe(1);
    expect(userRows[0]!.role).toBe("admin");
    expect(Number(userRows[0]!.email_verified)).toBe(1);

    const [seedRows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = 'seed'`,
    );
    expect(Number(seedRows[0]!.n)).toBe(50);

    // Rebuild server post-init: initGuard re-reads `initialized_at` at boot.
    appPost = await freshApp();

    // /login must now be reachable (200, not redirected to /init).
    const loginPage = await request(appPost.server).get("/login");
    expect(loginPage.status).toBe(200);
    expect(loginPage.headers["location"]).toBeUndefined();

    // Login as the admin we just bootstrapped.
    const { cookie, token } = extractCsrfPair(loginPage.headers);
    const loginResp = await request(appPost.server)
      .post("/login")
      .set("Cookie", cookie)
      .type("form")
      .send({ email: adminEmail, password: adminPassword, csrf: token });
    expect(loginResp.status).toBe(302);
    expect(loginResp.headers["location"]).toBe("/dashboard");
    const setCookies = loginResp.headers["set-cookie"] as string[];
    expect(setCookies.some((c) => c.startsWith("sid="))).toBe(true);

    // Pull the sid cookie so we can hit /admin.
    const sidCookie = setCookies.find((c) => c.startsWith("sid="))!.split(";")[0]!;

    const adminPage = await request(appPost.server).get("/admin").set("Cookie", sidCookie);
    expect(adminPage.status).toBe(200);
    expect(adminPage.text).toContain('class="layout-admin"');
  });

  it("guard before-init: /login redirects to /init", async () => {
    // Use the pre-init app: its DB still has `initialized_at` set from the
    // happy-path test above. We need to delete that row, then build a fresh
    // server so the guard reads requireSetup=true at boot.
    await td.pool.query(`DELETE FROM settings WHERE k = 'initialized_at'`);
    const appGuard = await freshApp();
    try {
      const r = await request(appGuard.server).get("/login");
      expect(r.status).toBe(302);
      expect(r.headers["location"]).toBe("/init");
    } finally {
      await appGuard.close();
    }
  });

  it("guard after-init: /init returns 404", async () => {
    // Use appPost (post-init). /init must be locked out by the guard.
    const r = await request(appPost.server).get("/init");
    expect(r.status).toBe(404);
  });

  it("seed: load=true → 50 rows; migration 012 is idempotent", async () => {
    // The route always runs runMigrations (idempotent); load=false skips the
    // seed step entirely, load=true persists a setting but the migration is
    // what actually inserts rows. Verify migration 012 is idempotent: re-run
    // runMigrations on the same DB → still 50 rows, not 100.
    const [beforeRows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = 'seed'`,
    );
    expect(Number(beforeRows[0]!.n)).toBe(50);

    await runMigrations(td.pool);

    const [afterRows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = 'seed'`,
    );
    expect(Number(afterRows[0]!.n)).toBe(50);
  });

  it("DB step failure: a connection that does not work is rejected", async () => {
    // Wipe `initialized_at` so the guard doesn't redirect /init requests.
    await td.pool.query(`DELETE FROM settings WHERE k = 'initialized_at'`);

    // Delete any users + site settings so we can test setup from a clean
    // uninit state without the happy-path leftovers interfering with the
    // guard allowlist (we still want the wizard reachable).
    await td.pool.query(`DELETE FROM users`);
    await td.pool.query(`DELETE FROM settings WHERE k LIKE 'site.%' OR k LIKE 'seed.%'`);

    const cfg = loadConfig();
    cfg.db.database = td.dbName;
    const appFail = await buildServer(cfg);
    try {
      // GET the database page so we have csrf cookies.
      const page = await request(appFail.server).get("/init/database");
      const token = extractCsrf(page.text);
      const { cookie } = extractCsrfPair(page.headers);

      // A connection that cannot be reached must be REJECTED, and the
      // form must come back with a readable reason. (The step used to
      // redirect with ?flash=error; it now re-renders with the reason
      // inline, because the operator has to see WHICH value was wrong.)
      //
      // The port below is one nothing listens on, so the probe fails for
      // a genuine reason rather than through a mock.
      const post = await request(appFail.server)
        .post("/init/database")
        .set("Cookie", cookie)
        .type("form")
        .send({
          csrf: token,
          host: cfg.db.host,
          port: "59322",
          user: cfg.db.user,
          password: cfg.db.password,
          database: td.dbName,
        });
      expect(post.status).toBe(200);
      expect(post.text).toContain('class="form-error"');
      // The reason is operator-facing, not a raw driver stack trace.
      expect(post.text).toMatch(/refused|unreachable|拒绝|无法连接/i);

      // And with a working connection the wizard continues.
      const page2 = await request(appFail.server).get("/init/database");
      const token2 = extractCsrf(page2.text);
      const { cookie: cookie2 } = extractCsrfPair(page2.headers);
      const post2 = await request(appFail.server)
        .post("/init/database")
        .set("Cookie", cookie2)
        .type("form")
        .send({
          csrf: token2,
          host: cfg.db.host,
          port: String(cfg.db.port),
          user: cfg.db.user,
          password: cfg.db.password,
          database: td.dbName,
        });
      expect(post2.status).toBe(302);
      expect(post2.headers["location"]).toMatch(/^\/init\/site/);
    } finally {
      await appFail.close();
    }
  });

  it("site validation failure: re-renders form (200) with name preserved", async () => {
    // Wizard requires initialized_at cleared so /init/site is reachable.
    await td.pool.query(`DELETE FROM settings WHERE k = 'initialized_at'`);
    const cfg = loadConfig();
    cfg.db.database = td.dbName;
    const appFx = await buildServer(cfg);
    try {
      const page = await request(appFx.server).get("/init/site");
      const { cookie, token } = extractCsrfPair(page.headers);
      const r = await request(appFx.server)
        .post("/init/site")
        .set("Cookie", cookie)
        .type("form")
        .send({ csrf: token, name: "   ", tagline: "kept on the page" });
      // Re-render the form directly, NOT redirect+flash.
      expect(r.status).toBe(200);
      expect(r.text).toContain('class="form-error"');
      // Empty name → granular "site_name_required" error.
      expect(r.text).toMatch(/站点名称必填|site name required/i);
      // Preserved input must round-trip into the form (tagline only; name was
      // empty so nothing to preserve).
      expect(r.text).toContain('value="kept on the page"');
    } finally {
      await appFx.close();
    }
  });

  it("admin validation failure: re-renders form (200) with email + displayName preserved", async () => {
    await td.pool.query(`DELETE FROM settings WHERE k = 'initialized_at'`);
    const cfg = loadConfig();
    cfg.db.database = td.dbName;
    const appFx = await buildServer(cfg);
    try {
      const page = await request(appFx.server).get("/init/admin");
      const { cookie, token } = extractCsrfPair(page.headers);
      const r = await request(appFx.server)
        .post("/init/admin")
        .set("Cookie", cookie)
        .type("form")
        .send({ csrf: token, email: "not-an-email", password: "weak", displayName: "KEEP ME" });
      expect(r.status).toBe(200);
      expect(r.text).toContain('class="form-error"');
      // Granular error for invalid email.
      expect(r.text).toMatch(/邮箱格式不正确|email invalid/i);
      // Email and displayName echoed back; password intentionally NOT echoed.
      expect(r.text).toContain('value="not-an-email"');
      expect(r.text).toContain('value="KEEP ME"');
      expect(r.text).not.toContain('value="weak"');
    } finally {
      await appFx.close();
    }
  });
});
