// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import { loadConfig } from "../../src/config";
import { runMigrations } from "../../src/storage/migrations/runner";
import { buildServer } from "../../src/api/server";
import { markInitialized } from "../../src/storage/settings";

interface TestDb {
  pool: mysql.Pool;
  dbName: string;
}

let td: TestDb;
let appPre: Awaited<ReturnType<typeof buildServer>>;
let appPost: Awaited<ReturnType<typeof buildServer>>;

async function dropAndCreate(): Promise<{ pool: mysql.Pool; dbName: string }> {
  const cfg = loadConfig();
  const dbName = "ipquery_test_setup_guard";
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await root.query(`CREATE DATABASE \`${dbName}\``);
  await root.end();
  const pool = mysql.createPool({
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
  return { pool, dbName };
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

beforeAll(async () => {
  td = await dropAndCreate();
  const cfg = loadConfig();
  cfg.db.database = td.dbName;

  // The initGuard plugin enforces on every non-setup request when
  // `initialized_at` is missing. Test fixture: build pre-init server
  // (initialized_at NOT set yet), then mark initialized and rebuild
  // to exercise the post-init lock-out.
  appPre = await buildServer(cfg);
  await markInitialized(td.pool);
  appPost = await buildServer(cfg);
});

afterAll(async () => {
  await appPre.close();
  await appPost.close();
  await td.pool.end();
  await dropDb(td.dbName);
});

describe("initGuard plugin", () => {
  describe("before init", () => {
    it("redirects GET / to /init", async () => {
      const r = await request(appPre.server).get("/");
      expect(r.status).toBe(302);
      expect(r.headers["location"]).toBe("/init");
    });

    it("redirects GET /login to /init", async () => {
      const r = await request(appPre.server).get("/login");
      expect(r.status).toBe(302);
      expect(r.headers["location"]).toBe("/init");
    });

    it("allows GET /healthz through (external probes)", async () => {
      const r = await request(appPre.server).get("/healthz");
      expect(r.status).toBe(200);
    });

    it("allows GET /lookup through (public IP-API works during setup)", async () => {
      const r = await request(appPre.server).get("/lookup");
      // Endpoint is reachable; status depends on whether seed data was loaded.
      // We only care that initGuard didn't redirect to /init.
      expect(r.status).not.toBe(302);
      expect(r.headers["location"]).toBeUndefined();
    });

    it("allows GET /stats through (public stats API works during setup)", async () => {
      const r = await request(appPre.server).get("/stats");
      expect(r.status).not.toBe(302);
      expect(r.headers["location"]).toBeUndefined();
    });
  });

  describe("after init", () => {
    it("does NOT redirect GET / to /init", async () => {
      const r = await request(appPost.server).get("/");
      expect(r.status).not.toBe(302);
    });

    it("returns 404 for GET /init (lock-out)", async () => {
      const r = await request(appPost.server).get("/init");
      expect(r.status).toBe(404);
    });
  });

  describe("onResponse cache refresh (regression)", () => {
    // Regression test for the production bug where `initGuard`'s onResponse
    // hook skipped cache refresh on 3xx responses. POST /init/complete returns
    // 302, so the cache was never refreshed in production: after the wizard
    // completed, /login got redirected back to /init, trapping the user in a
    // loop. The fix is `reply.statusCode >= 400` instead of `>= 300`.
    //
    // Build a fresh pre-init server, walk the wizard up to /init/complete on
    // THE SAME instance, and assert /login reaches the real handler (200) — no
    // redirect to /init, no server rebuild between steps.
    let liveApp: Awaited<ReturnType<typeof buildServer>>;
    beforeAll(async () => {
      const cfg = loadConfig();
      const dbName = "ipquery_test_setup_guard_refresh";
      const root = await mysql.createConnection({
        host: cfg.db.host,
        port: cfg.db.port,
        user: cfg.db.user,
        password: cfg.db.password,
      });
      await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await root.query(`CREATE DATABASE \`${dbName}\``);
      await root.end();
      const pool = mysql.createPool({
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
      await pool.end();
      const liveCfg = loadConfig();
      liveCfg.db.database = dbName;
      liveApp = await buildServer(liveCfg);
    });

    afterAll(async () => {
      await liveApp.close();
      const cfg = loadConfig();
      const root = await mysql.createConnection({
        host: cfg.db.host,
        port: cfg.db.port,
        user: cfg.db.user,
        password: cfg.db.password,
      });
      await root.query(`DROP DATABASE IF EXISTS \`ipquery_test_setup_guard_refresh\``);
      await root.end();
    });

    function extractCsrf(html: string, setCookie: string[] | undefined): string {
      const tokenMatch = /<input[^>]+name="csrf"[^>]+value="([^"]+)"/.exec(html);
      if (!tokenMatch) throw new Error("csrf token not found in page");
      const csrfCookie = setCookie?.find((c) => c.startsWith("csrf="))!.split(";")[0]!;
      const issuedCookie = setCookie?.find((c) => c.startsWith("csrf_issued="))!.split(";")[0]!;
      void csrfCookie;
      void issuedCookie;
      return tokenMatch[1]!;
    }

    async function wizardStep(
      agent: ReturnType<typeof request.agent>,
      path: string,
      fields: Record<string, string> = {},
    ): Promise<void> {
      const getR = await agent.get(path.replace(/^POST_/, ""));
      const token = extractCsrf(getR.text, getR.headers["set-cookie"] as string[] | undefined);
      const r = await agent
        .post(path.replace(/^POST_/, ""))
        .type("form")
        .send({ csrf: token, ...fields });
      expect(r.status).toBe(302);
    }

    it("POST /init/complete (302) refreshes cache so GET /login is NOT redirected", async () => {
      const agent = request.agent(liveApp.server);
      await wizardStep(agent, "POST_/init/site", { name: "X", tagline: "Y" });
      await wizardStep(agent, "POST_/init/admin", {
        email: "x@y.z",
        password: "longpassword1",
        displayName: "X",
      });
      await wizardStep(agent, "POST_/init/seed", { load: "true" });
      await wizardStep(agent, "POST_/init/complete");

      // Same server instance — no rebuild. Pre-fix this redirected 302 to /init.
      const loginR = await request(liveApp.server).get("/login");
      expect(loginR.status).toBe(200);
      expect(loginR.headers["location"]).toBeUndefined();

      const setupR = await request(liveApp.server).get("/init");
      expect(setupR.status).toBe(404);
    });
  });
});
