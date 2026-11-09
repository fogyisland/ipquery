// SPDX-License-Identifier: MIT
//
// Browser-side E2E for the ETL live-progress bars.
//
// The DB side of this feature was verified directly against MySQL in an
// earlier session (migration 022 + EtlProgressSink + /progress JSON
// endpoint). This test covers what that could NOT: the browser half —
// that htmx actually polls the endpoint, that etl-progress.js updates
// the bar widths from the JSON payload, and that a 204 from a finished
// run stops the polling instead of wiping the bars.
//
// Real Chromium via Playwright, real HTTP server (not supertest's
// in-memory app) — the browser has to be able to make same-origin
// requests for the htmx polling to work.
//
// NOTE: this project depends on `playwright` (the library), not
// `@playwright/test` (the runner). There is therefore no Playwright
// `expect` extension available — `toBeVisible`, `toHaveText`, etc. do
// not exist here. All assertions are plain vitest `expect` over values
// read out of the page, with explicit polling helpers for the parts
// that change over time.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

const TEST_DB = "ipquery_e2e_progress";
const cfg = loadConfig();
let app: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let baseUrl: string;
let adminSid: string;
const ADMIN_EMAIL = "etladmin@x.com";
const ADMIN_PW = "AdminPass1234";

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

  // Apply the schema — the setup guard and the etl_runs table both need
  // it before buildServer() can start. multipleStatements is required:
  // the migration files contain several statements per file.
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

  // Mark the system initialized BEFORE buildServer(): the setup guard
  // reads `settings.initialized_at` once at boot and caches the answer
  // in `app.requireSetup`. Writing the row afterwards would leave the
  // guard in "not initialized" mode and every admin page would redirect
  // to /setup.
  await markInitialized(migratePool);
  await migratePool.end();

  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: ADMIN_EMAIL,
    passwordHash: await hashPassword(ADMIN_PW),
    displayName: "EtlAdmin",
    role: "admin",
  });
  await app.pool.query("UPDATE users SET email_verified = 1 WHERE id = ?", [admin.id]);

  // A live session sid so the browser can be pre-authenticated without
  // driving the login form (the login flow itself is covered by the
  // integration suite).
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));

  // Bind to an ephemeral port on the loopback interface.
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

/** Insert an etl_runs row in the given state and return its id. */
async function seedRun(row: {
  status: "running" | "success" | "failed";
  currentStage?: string | null;
  downloadBytesDone?: number | null;
  downloadBytesTotal?: number | null;
  insertRowsDone?: number | null;
  insertRowsTotal?: number | null;
}): Promise<number> {
  const [res] = await app.pool.query<mysql.ResultSetHeader>(
    `INSERT INTO etl_runs
       (status, started_at, current_stage, download_bytes_done,
        download_bytes_total, insert_rows_done, insert_rows_total,
        progress_updated_at)
     VALUES (?, NOW(3), ?, ?, ?, ?, ?, NOW(3))`,
    [
      row.status,
      row.currentStage ?? "download",
      row.downloadBytesDone ?? 0,
      row.downloadBytesTotal ?? 0,
      row.insertRowsDone ?? 0,
      row.insertRowsTotal ?? 0,
    ],
  );
  return res.insertId;
}

/** Open a page with the admin session cookie already set. */
async function adminPage(): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "sid", value: adminSid, domain: "127.0.0.1", path: "/" }]);
  return context.newPage();
}

/** Read a container's data-* attribute. */
async function dataAttr(page: Page, selector: string, attr: string): Promise<string | null> {
  return page.locator(selector).getAttribute(attr);
}

/** Read an element's inline width style, e.g. "50%". */
async function fillWidth(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((el) => (el as HTMLElement).style.width);
}

/** Read an element's trimmed text content. */
async function textOf(page: Page, selector: string): Promise<string> {
  const raw = await page.locator(selector).textContent();
  return (raw ?? "").trim();
}

/**
 * Poll `read` until it returns a value satisfying `done`, or time out.
 * Used for the parts of the page that change on their own (the 2s htmx
 * poll). Mirrors Playwright's expect.poll, which this project does not
 * have.
 */
async function waitFor<T>(
  read: () => Promise<T>,
  done: (_value: T) => boolean,
  timeoutMs = 15_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (Date.now() < deadline) {
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await read();
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms; last value = ${JSON.stringify(last)}`);
}

/** True when the element exists in the DOM and is not hidden. */
async function isVisible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).isVisible();
}

describe("ETL live progress — browser E2E", () => {
  beforeEach(async () => {
    // etl_run_downloads / etl_run_stages have FKs onto etl_runs, so a
    // bare TRUNCATE is rejected by MySQL. Disable the checks for the
    // duration of the wipe (same pattern as auth.login.test.ts).
    await app.pool.query("SET FOREIGN_KEY_CHECKS = 0");
    await app.pool.query("TRUNCATE TABLE etl_runs");
    await app.pool.query("SET FOREIGN_KEY_CHECKS = 1");
  });

  it("renders the progress bars with the server-side values", async () => {
    const runId = await seedRun({
      status: "running",
      currentStage: "insert",
      downloadBytesDone: 50 * 1024 * 1024,
      downloadBytesTotal: 100 * 1024 * 1024,
      insertRowsDone: 2500,
      insertRowsTotal: 10000,
    });

    const page = await adminPage();
    try {
      await page.goto(`${baseUrl}/admin/etl/runs/${runId}`, { waitUntil: "domcontentloaded" });

      const container = page.locator("#etl-progress-bars");
      expect(await container.count()).toBe(1);
      expect(await isVisible(page, "#etl-progress-bars")).toBe(true);

      // The data-* attributes carry the initial state.
      expect(await dataAttr(page, "#etl-progress-bars", "data-stage")).toBe("insert");
      expect(await dataAttr(page, "#etl-progress-bars", "data-rows-done")).toBe("2500");
      expect(await dataAttr(page, "#etl-progress-bars", "data-rows-total")).toBe("10000");

      // The bars themselves were sized by etl-progress.js from those attrs.
      // Download: 50/100 = 50%. Insert: 2500/10000 = 25%.
      expect(await fillWidth(page, "#etl-progress-download-fill")).toBe("50%");
      expect(await fillWidth(page, "#etl-progress-insert-fill")).toBe("25%");

      // The text labels show the byte/row counts. The script formats them
      // as "<done> / <total> (<pct>%)". Note fmtBytes drops the decimal
      // once the value reaches 100 ("100 MB", not "100.0 MB").
      const dlText = await textOf(page, "#etl-progress-download-text");
      expect(dlText).toContain("50.0 MB");
      expect(dlText).toContain("100 MB");
      expect(dlText).toContain("(50%)");

      const inText = await textOf(page, "#etl-progress-insert-text");
      expect(inText).toContain("2,500");
      expect(inText).toContain("10,000");
      expect(inText).toContain("(25%)");

      // The stage indicator reflects the current stage.
      expect(await textOf(page, "#etl-progress-stage")).toBe("insert");
    } finally {
      await page.context().close();
    }
  });

  it("polls /progress and updates the bars when the run advances", async () => {
    const runId = await seedRun({
      status: "running",
      currentStage: "download",
      downloadBytesDone: 10 * 1024 * 1024,
      downloadBytesTotal: 100 * 1024 * 1024,
      insertRowsDone: 0,
      insertRowsTotal: 0,
    });

    const page = await adminPage();
    try {
      await page.goto(`${baseUrl}/admin/etl/runs/${runId}`, { waitUntil: "domcontentloaded" });

      // Move the run forward in the DB; the 2s poll should pick it up.
      await app.pool.query(
        `UPDATE etl_runs
            SET current_stage = 'insert',
                download_bytes_done = 80 * 1024 * 1024,
                download_bytes_total = 100 * 1024 * 1024,
                insert_rows_done = 4000,
                insert_rows_total = 8000,
                progress_updated_at = NOW(3)
          WHERE id = ?`,
        [runId],
      );

      // Wait for the poll to land (htmx polls every 2s).
      const rowsDone = await waitFor(
        () => dataAttr(page, "#etl-progress-bars", "data-rows-done"),
        (v) => v === "4000",
      );
      expect(rowsDone).toBe("4000");

      expect(await fillWidth(page, "#etl-progress-insert-fill")).toBe("50%"); // 4000/8000
      expect(await fillWidth(page, "#etl-progress-download-fill")).toBe("80%"); // 80/100
      expect(await textOf(page, "#etl-progress-stage")).toBe("insert");
    } finally {
      await page.context().close();
    }
  });

  it("stops polling on 204 when the run finishes, keeping the last values", async () => {
    const runId = await seedRun({
      status: "running",
      currentStage: "insert",
      downloadBytesDone: 100 * 1024 * 1024,
      downloadBytesTotal: 100 * 1024 * 1024,
      insertRowsDone: 8000,
      insertRowsTotal: 8000,
    });

    const page = await adminPage();
    try {
      await page.goto(`${baseUrl}/admin/etl/runs/${runId}`, { waitUntil: "domcontentloaded" });

      // The run finishes while the page is open.
      await app.pool.query(`UPDATE etl_runs SET status = 'success' WHERE id = ?`, [runId]);

      // The container must keep its content — a 204 must NOT wipe the bars.
      // Wait long enough for at least one poll cycle to have fired.
      await page.waitForTimeout(5000);
      expect(await isVisible(page, "#etl-progress-bars")).toBe(true);
      expect(await fillWidth(page, "#etl-progress-insert-fill")).toBe("100%");
      expect(await textOf(page, "#etl-progress-insert-text")).toContain("8,000");

      // Confirm the endpoint really does return 204 for a finished run.
      const res = await page.request.get(`${baseUrl}/admin/etl/runs/${runId}/progress`);
      expect(res.status()).toBe(204);
    } finally {
      await page.context().close();
    }
  });

  it("returns 404 for a run that does not exist", async () => {
    const page = await adminPage();
    try {
      const res = await page.request.get(`${baseUrl}/admin/etl/runs/999999/progress`);
      expect(res.status()).toBe(404);
    } finally {
      await page.context().close();
    }
  });

  it("requires an admin session", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      const res = await page.goto(`${baseUrl}/admin/etl/runs/1`, {
        waitUntil: "domcontentloaded",
      });
      // Unauthenticated access to an admin path is rejected with 403 —
      // the auth guard renders errors/403.hbs rather than redirecting.
      expect(res?.status()).toBe(403);
    } finally {
      await context.close();
    }
  });
});
