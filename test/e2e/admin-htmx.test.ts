// SPDX-License-Identifier: MIT
//
// Regression test for the admin layout missing htmx.
//
// `layouts/admin.hbs` never included /assets/js/htmx.min.js, so every
// hx-get in the admin views was dead: the ETL run-detail live section,
// the ETL progress bars, and the 30s auto-refresh on /admin and
// /admin/queries. The page looked fine (server-rendered) but never
// updated.
//
// This test asserts htmx actually loads on an admin page and that a
// polling element issues its request. It is deliberately small — the
// behavioural depth is covered by etl-progress.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { chromium, type Browser, type Page } from "playwright";
import { buildServer } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { hashPassword } from "../../src/web/auth/password";
import { markInitialized } from "../../src/storage/settings";
import { runMigrations } from "../../src/storage/migrations/runner";

const TEST_DB = "ipquery_e2e_adminhtmx";
const cfg = loadConfig();
let app: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let baseUrl: string;
let adminSid: string;

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

  const migratePool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: TEST_DB,
    connectionLimit: 1,
    multipleStatements: true,
  });
  await runMigrations(migratePool);
  // Before buildServer — the setup guard caches `initialized_at` at boot.
  await markInitialized(migratePool);
  await migratePool.end();

  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "adminhtmx@x.com",
    passwordHash: await hashPassword("AdminPass1234"),
    displayName: "AdminHtmx",
    role: "admin",
  });
  await app.pool.query("UPDATE users SET email_verified = 1 WHERE id = ?", [admin.id]);
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));

  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind to a TCP port");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  if (browser) await browser.close();
  if (app) await app.close();
  const root = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
  });
  await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await root.end();
});

/** Open a page with the admin session cookie already set. */
async function adminPage(): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "sid", value: adminSid, domain: "127.0.0.1", path: "/" }]);
  return context.newPage();
}

describe("admin layout loads htmx", () => {
  it("exposes window.htmx on an admin page", async () => {
    const page = await adminPage();
    try {
      await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });
      const htmxType = await page.evaluate(() => typeof (window as { htmx?: unknown }).htmx);
      expect(htmxType).toBe("object");
    } finally {
      await page.context().close();
    }
  });

  it("still loads confirm-form.js and wires data-confirm forms", async () => {
    const page = await adminPage();
    try {
      await page.goto(`${baseUrl}/admin/keys`, { waitUntil: "domcontentloaded" });

      // The admin layout used to carry the confirm-form.js tag after
      // </html>; it now sits inside <body> next to the htmx tag. Verify
      // the script still runs and binds the bulk-revoke form.
      const wired = await page.evaluate(() => {
        const form = document.querySelector<HTMLFormElement>("form[data-confirm]");
        if (!form) return { found: false, bound: false };
        return { found: true, bound: (form as unknown as { __confirmFormWired?: boolean }).__confirmFormWired === true };
      });
      expect(wired.found).toBe(true);
      expect(wired.bound).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  it("issues the poll request declared by hx-trigger", async () => {
    const page = await adminPage();
    try {
      const requested: string[] = [];
      page.on("request", (r) => {
        if (r.url().startsWith(baseUrl)) requested.push(new URL(r.url()).pathname);
      });

      await page.goto(`${baseUrl}/admin`, { waitUntil: "domcontentloaded" });

      // The dashboard section declares hx-trigger="every 30s". Waiting the
      // full 30s is slow but the alternative — asserting on the
      // attribute alone — would not catch htmx failing to initialize.
      // Poll the request list until the /admin poll lands.
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        if (requested.filter((p) => p === "/admin").length >= 2) break;
        await page.waitForTimeout(500);
      }

      // The initial page load is one /admin request; the htmx poll adds
      // a second one.
      expect(requested.filter((p) => p === "/admin").length).toBeGreaterThanOrEqual(2);
    } finally {
      await page.context().close();
    }
  });
});
