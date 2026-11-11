// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { buildServer } from "../../src/api/server";
import { getSetting, isInitialized, markInitialized as _markInitialized } from "../../src/storage/settings";

const TEST_DB = "ipquery_test_setup_routes";

let td: { pool: mysql.Pool; dbName: string };
let appPre: Awaited<ReturnType<typeof buildServer>>;
let appPost: Awaited<ReturnType<typeof buildServer>>;

async function dropAndCreate(): Promise<{ pool: mysql.Pool; dbName: string }> {
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
  // Intentionally do NOT call markInitialized here — we want to test the
  // uninitialized path. The initGuard's boot cache should read the missing
  // `initialized_at` row and flip `requireSetup=true`.
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

// Helper: extract the csrf token from a rendered HBS page. The form templates
// render `<input type="hidden" name="csrf" value="...">` exactly once per page.
function extractCsrf(html: string): string {
  const m = /<input[^>]+name="csrf"[^>]+value="([^"]+)"/.exec(html);
  if (!m) throw new Error("csrf hidden input not found in page");
  return m[1]!;
}

beforeAll(async () => {
  td = await dropAndCreate();
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  appPre = await buildServer(cfg);
});

afterAll(async () => {
  await appPre.close();
  if (appPost) await appPost.close();
  await td.pool.end();
  await dropDb(td.dbName);
});

describe("setup wizard routes", () => {
  it("GET /init returns 200 with the welcome page", async () => {
    const r = await request(appPre.server).get("/init");
    expect(r.status).toBe(200);
    // Default locale is zh-CN; the welcome title is the localized "Welcome".
    expect(r.text).toContain("欢迎");
    expect(r.text).toContain('class="setup-stepper"');
  });

  it("GET / redirects to /init when uninitialized", async () => {
    const r = await request(appPre.server).get("/");
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toBe("/init");
  });

  it("GET /init/admin returns 200 with the form", async () => {
    const r = await request(appPre.server).get("/init/admin");
    expect(r.status).toBe(200);
    expect(r.text).toContain('name="email"');
    expect(r.text).toContain('name="password"');
    expect(r.text).toContain('name="csrf"');
  });

  it("POST /init/database with valid CSRF redirects to /init/site", async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get("/init/database");
    const csrf = extractCsrf(page.text);
    const r = await agent.post("/init/database").type("form").send({ csrf });
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toMatch(/^\/init\/site/);
  });

  it("POST /init/site with valid CSRF saves settings and redirects to /init/admin", async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get("/init/site");
    const csrf = extractCsrf(page.text);
    const r = await agent.post("/init/site").type("form").send({
      csrf,
      name: "Test Site",
      tagline: "hello",
    });
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toMatch(/^\/init\/admin/);
    expect(await getSetting(td.pool, "site.name")).toBe("Test Site");
    expect(await getSetting(td.pool, "site.tagline")).toBe("hello");
  });

  it("POST /init/admin with valid credentials creates admin and redirects to /init/seed", async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get("/init/admin");
    const csrf = extractCsrf(page.text);
    const r = await agent.post("/init/admin").type("form").send({
      csrf,
      email: "admin@setup.test",
      password: "longpassword1",
      displayName: "Setup Admin",
    });
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toMatch(/^\/init\/seed/);

    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT email, role FROM users WHERE email = ?`,
      ["admin@setup.test"],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe("admin");
  });

  it("POST /init/admin with weak password re-renders form with no user created", async () => {
    // Validation failures re-render the form (200) so email/displayName are
    // preserved — see fix(web): preserve form input on setup wizard
    // validation failure. The critical invariant is: weak password must NOT
    // create a user row.
    const agent = request.agent(appPre.server);
    const page = await agent.get("/init/admin");
    const csrf = extractCsrf(page.text);
    const r = await agent.post("/init/admin").type("form").send({
      csrf,
      email: "weak@setup.test",
      password: "short",
      displayName: "Weak",
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain('class="form-error"');
    // Password intentionally NOT echoed back; email + displayName round-trip.
    expect(r.text).toContain('value="weak@setup.test"');
    expect(r.text).toContain('value="Weak"');
    expect(r.text).not.toContain('value="short"');

    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(`SELECT id FROM users WHERE email = ?`, [
      "weak@setup.test",
    ]);
    expect(rows.length).toBe(0);
  });

  it("POST /init/seed with load=true runs migrations and ensures 50 seed rows, redirects to /init/complete", async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get("/init/seed");
    const csrf = extractCsrf(page.text);
    const r = await agent.post("/init/seed").type("form").send({ csrf, load: "true" });
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toMatch(/^\/init\/complete/);

    const [seedRows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = 'seed'`,
    );
    expect(Number(seedRows[0]!.n)).toBe(50);
    expect(await getSetting(td.pool, "seed.loaded")).toBe("true");
  });

  it("POST /init/seed with load=false is idempotent (migrations still run) and leaves 0 seed rows", async () => {
    // First wipe the seed rows so we can verify load=false inserts none.
    await td.pool.query(`DELETE FROM ip_ranges WHERE country_source = 'seed'`);
    const agent = request.agent(appPre.server);
    const page = await agent.get("/init/seed");
    const csrf = extractCsrf(page.text);
    const r = await agent.post("/init/seed").type("form").send({ csrf, load: "false" });
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toMatch(/^\/init\/complete/);

    const [seedRows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM ip_ranges WHERE country_source = 'seed'`,
    );
    // load=false does not insert; the migration runner is still idempotent.
    expect(Number(seedRows[0]!.n)).toBe(0);
    expect(await getSetting(td.pool, "seed.loaded")).toBe("false");
  });

  it("POST /init/seed with mode=etl kicks off a background ETL and renders the progress page", async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get("/init/seed");
    const csrf = extractCsrf(page.text);
    const r = await agent.post("/init/seed").type("form").send({ csrf, mode: "etl" });
    // Redirects straight back to the progress page (runId in URL).
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toMatch(/^\/init\/seed\?runId=/);

    // The progress page is reachable and surfaces an etl_runs row.
    const progress = await agent.get(r.headers["location"]);
    expect(progress.status).toBe(200);
    // Will be one of: running, success, failed — depending on whether the
    // background downloader can reach db-ip.com from the test environment.
    expect(progress.text).toMatch(/init-progress-status--(running|success|failed)/);

    // A run row exists. Either still running or already finished.
    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      `SELECT id, status FROM etl_runs ORDER BY id DESC LIMIT 1`,
    );
    expect(rows.length).toBe(1);
    expect(["running", "success", "failed"]).toContain(rows[0]!.status);

    // Guard: a second click while running does NOT spawn a second pipeline.
    const r2 = await agent.post("/init/seed").type("form").send({ csrf, mode: "etl" });
    expect(r2.status).toBe(302);
    const [count] = await td.pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM etl_runs`);
    expect(Number(count[0]!.n)).toBe(1);
  });

  it("POST /init/complete marks initialized, redirects to /login, and locks /init out", async () => {
    const agent = request.agent(appPre.server);
    const page = await agent.get("/init/complete");
    const csrf = extractCsrf(page.text);
    const r = await agent.post("/init/complete").type("form").send({ csrf });
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toMatch(/^\/login/);
    expect(await isInitialized(td.pool)).toBe(true);

    // Rebuild server to refresh boot cache; initGuard now reads initialized_at
    // and should flip requireSetup=false. /init is locked out (404) and /
    // no longer redirects.
    const cfg = loadConfig();
    cfg.db.database = td.dbName;
    appPost = await buildServer(cfg);

    const root = await request(appPost.server).get("/");
    expect(root.status).not.toBe(302);

    const setup = await request(appPost.server).get("/init");
    expect(setup.status).toBe(404);
  });
});
