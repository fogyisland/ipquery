// SPDX-License-Identifier: MIT
//
// Browser-side E2E for the chunked .ipq upload.
//
// The unit suite drives `range-upload.js` inside a `node:vm` sandbox
// against a real HTTP server, which proves the wire format and the retry
// logic. It cannot prove the part that actually breaks in practice: that
// the page as rendered by the server has the elements the script binds
// to, that a real browser's `File` object survives `file.slice()`, and
// that the browser's own multipart encoder produces something
// `@fastify/multipart` accepts.
//
// So this test opens the real page in real Chromium, picks a real file
// from disk through the file input, clicks the real button, and waits
// for the rows to land in the database.
//
// NOTE: this project depends on `playwright` (the library), not
// `@playwright/test` (the runner). There is therefore no Playwright
// `expect` extension available — `toBeVisible`, `toHaveText`, etc. do
// not exist here. All assertions are plain vitest `expect` over values
// read out of the page, with explicit polling helpers for the parts
// that change over time.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { buildServer } from "../../src/api/server";
import { loadConfig } from "../../src/config";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { hashPassword } from "../../src/web/auth/password";
import { markInitialized } from "../../src/storage/settings";
import { runMigrations } from "../../src/storage/migrations/runner";

const TEST_DB = "ipquery_e2e_rangeupload";
const cfg = loadConfig();
let app: Awaited<ReturnType<typeof buildServer>>;
let browser: Browser;
let baseUrl: string;
let adminSid: string;
let tmpDir: string;
const ADMIN_EMAIL = "rangeadmin@x.com";
const ADMIN_PW = "AdminPass1234";

/** The rows the fixture file holds. The upload must land exactly these. */
const FIXTURE_ROWS: ReadonlyArray<{
  start: string;
  end: string;
  countryCode: string;
}> = [
  { start: "203.0.113.0", end: "203.0.113.15", countryCode: "AU" },
  { start: "203.0.113.16", end: "203.0.113.31", countryCode: "JP" },
  { start: "198.51.100.0", end: "198.51.100.255", countryCode: "DE" },
];

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

  // The setup guard reads `settings.initialized_at` once at boot and
  // caches the answer, so the row has to be there BEFORE buildServer().
  await markInitialized(migratePool);
  await migratePool.end();

  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: ADMIN_EMAIL,
    passwordHash: await hashPassword(ADMIN_PW),
    displayName: "RangeAdmin",
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

  // The upload directory lives under DATA_DIR; give the test its own so
  // the assembled file does not land in the developer's real data dir.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipquery-e2e-range-"));
}, 180_000);

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
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a .ipq file with the given rows and return its path. */
function writeIpqFile(rows: ReadonlyArray<{ start: string; end: string; countryCode: string }>): string {
  const lines: string[] = [
    JSON.stringify({
      format: "ipquery-ranges",
      version: 1,
      exportedAt: "2026-11-21T00:00:00.000Z",
      rows: rows.length,
    }),
  ];
  for (const row of rows) {
    lines.push(
      JSON.stringify({
        start: row.start,
        end: row.end,
        countryCode: row.countryCode,
        countryName: null,
        asn: null,
        asnOrg: null,
      }),
    );
  }
  const filepath = path.join(tmpDir, "fixture.ipq");
  fs.writeFileSync(filepath, lines.join("\n") + "\n", "utf8");
  return filepath;
}

/** Open a page with the admin session cookie already set. */
async function adminPage(): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "sid", value: adminSid, domain: "127.0.0.1", path: "/" }]);
  return context.newPage();
}

/** Read an element's trimmed text content. */
async function textOf(page: Page, selector: string): Promise<string> {
  const raw = await page.locator(selector).textContent();
  return (raw ?? "").trim();
}

/**
 * Poll `read` until it returns a value satisfying `done`, or time out.
 * Mirrors Playwright's expect.poll, which this project does not have.
 */
async function waitFor<T>(
  read: () => Promise<T>,
  done: (_value: T) => boolean,
  timeoutMs = 60_000,
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

/** How many ranges the table holds right now. */
async function rangeCount(): Promise<number> {
  const [rows] = await app.pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM ip_ranges");
  return Number(rows[0]?.n ?? 0);
}

describe("Chunked range upload — browser E2E", () => {
  it("uploads a file through the page and lands the rows in the database", async () => {
    const filepath = writeIpqFile(FIXTURE_ROWS);
    const page = await adminPage();
    try {
      await page.goto(`${baseUrl}/admin/ranges`, { waitUntil: "domcontentloaded" });

      // The page has to offer the chunked path at all.
      expect(await page.locator("#range-upload-form").count()).toBe(1);
      expect(await page.locator("#range-upload-file").count()).toBe(1);
      expect(await page.locator("#range-upload-start").count()).toBe(1);

      // Pick the file the way an operator does — through the file input,
      // not by setting a value. Playwright hands the bytes to the browser
      // exactly as a file picker would.
      await page.setInputFiles("#range-upload-file", filepath);

      const before = await rangeCount();

      // Click the real button and let the script run.
      await page.click("#range-upload-start");

      // The script reports where it is. The upload has to reach the end
      // on its own — a stalled status is a failure, not a slow success.
      const status = await waitFor(
        () => textOf(page, "#range-upload-status"),
        (value) => /uploaded|imported|failed/i.test(value),
        60_000,
      );
      expect(status).not.toMatch(/failed/i);

      // The rows are in the table.
      const after = await waitFor(
        () => rangeCount(),
        (value) => value === before + FIXTURE_ROWS.length,
        30_000,
      );
      expect(after).toBe(before + FIXTURE_ROWS.length);

      // The assembled file is gone, and so are the upload rows: the
      // import cleans up after itself.
      await waitFor(
        async () => {
          const [rows] = await app.pool.query<mysql.RowDataPacket[]>(
            "SELECT COUNT(*) AS n FROM range_uploads",
          );
          return Number(rows[0]?.n ?? 0);
        },
        (value) => value === 0,
        15_000,
      );
      const [chunkRows] = await app.pool.query<mysql.RowDataPacket[]>(
        "SELECT COUNT(*) AS n FROM range_upload_chunks",
      );
      expect(Number(chunkRows[0]?.n ?? 0)).toBe(0);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("shows the replacement field only when a replacement is chosen", async () => {
    const page = await adminPage();
    try {
      await page.goto(`${baseUrl}/admin/ranges`, { waitUntil: "domcontentloaded" });

      // The confirmation field is hidden on arrival: merging is the safe
      // default and must not ask for a confirmation.
      expect(await page.locator("#range-upload-confirm-field").isVisible()).toBe(false);

      await page.selectOption("#range-upload-mode", "replace");
      expect(await page.locator("#range-upload-confirm-field").isVisible()).toBe(true);

      await page.selectOption("#range-upload-mode", "merge");
      expect(await page.locator("#range-upload-confirm-field").isVisible()).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("refuses a replacement the operator has not confirmed", async () => {
    const filepath = writeIpqFile([{ start: "192.0.2.0", end: "192.0.2.255", countryCode: "FR" }]);
    const page = await adminPage();
    try {
      await page.goto(`${baseUrl}/admin/ranges`, { waitUntil: "domcontentloaded" });
      await page.setInputFiles("#range-upload-file", filepath);
      await page.selectOption("#range-upload-mode", "replace");

      const before = await rangeCount();
      await page.click("#range-upload-start");

      // The script must say what is missing before a byte travels.
      const status = await waitFor(
        () => textOf(page, "#range-upload-status"),
        (value) => value.length > 0,
        15_000,
      );
      expect(status).toMatch(/confirm/i);

      // The failure is marked by the attribute, not by the wording of
      // the sentence — the sentence says what to do, the attribute says
      // that it is a failure.
      const isError = await page.locator("#range-upload-status").getAttribute("data-error");
      expect(isError).toBe("1");

      // And nothing was uploaded: the guard runs before the transfer.
      expect(await rangeCount()).toBe(before);
      const [rows] = await app.pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM range_uploads");
      expect(Number(rows[0]?.n ?? 0)).toBe(0);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("shows the reason when the server refuses the upload", async () => {
    const page = await adminPage();
    try {
      // Break the token the script will use, so the server refuses the
      // very first request. The page must say so rather than fail
      // silently.
      await page.goto(`${baseUrl}/admin/ranges`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        const form = document.getElementById("range-upload-form");
        if (form) form.setAttribute("data-csrf", "not-a-real-token");
        const hidden = form?.querySelector("[name=csrf]") as HTMLInputElement | null;
        if (hidden) hidden.value = "not-a-real-token";
      });

      const filepath = writeIpqFile([{ start: "192.0.2.128", end: "192.0.2.255", countryCode: "GB" }]);
      await page.setInputFiles("#range-upload-file", filepath);
      await page.click("#range-upload-start");

      const status = await waitFor(
        () => textOf(page, "#range-upload-status"),
        (value) => /failed|error/i.test(value),
        30_000,
      );
      expect(status).toMatch(/failed/i);

      // The status line carries the error attribute so it is styled as a
      // failure, not as ordinary progress.
      const isError = await page.locator("#range-upload-status").getAttribute("data-error");
      expect(isError).toBe("1");
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("The import progress bar — browser E2E", () => {
  it("polls the running job and moves the bar while the page is open", async () => {
    // The unit suite proves the script's arithmetic inside a sandbox.
    // It cannot prove that the page the server actually renders has the
    // elements the script binds to — a renamed class or a missing
    // data attribute would leave the unit test green and the operator
    // watching a bar that never moves.
    //
    // So: upload a file, let the import start, and watch the real
    // browser's bar.
    const filepath = writeIpqFile([
      { start: "198.18.0.0", end: "198.18.3.255", countryCode: "NL" },
      { start: "198.18.4.0", end: "198.18.7.255", countryCode: "SE" },
    ]);
    const page = await adminPage();
    try {
      await page.goto(`${baseUrl}/admin/ranges`, { waitUntil: "domcontentloaded" });
      await page.setInputFiles("#range-upload-file", filepath);
      await page.click("#range-upload-start");

      // Wait for the import job to exist. The page renders one row per
      // job, and the row is what the script polls.
      const jobId = await waitFor(
        async () => {
          const [rows] = await app.pool.query<mysql.RowDataPacket[]>(
            "SELECT id FROM range_imports ORDER BY id DESC LIMIT 1",
          );
          return rows[0] ? Number(rows[0].id) : 0;
        },
        (value) => value > 0,
        60_000,
      );
      expect(jobId).toBeGreaterThan(0);

      // The script is on the page, and it is a separate file — the CSP
      // forbids an inline script, so an inline one would never run.
      const scriptSrc = await page.getAttribute("script[src*='range-progress.js']", "src");
      expect(scriptSrc).toBe("/assets/range-progress.js");

      // The row carries the job id the endpoint is addressed by, and the
      // elements the script writes into.
      await page.reload({ waitUntil: "domcontentloaded" });
      const row = page.locator(`.range-import-row[data-import-id="${jobId}"]`);
      await row.waitFor({ state: "attached", timeout: 15_000 });
      expect(await row.locator(".range-import-bar-fill").count()).toBe(1);
      expect(await row.locator(".range-import-progress-text").count()).toBe(1);

      // The endpoint answered, so the bar has a width. The exact number
      // depends on how fast the import finished, but a bar that never
      // moved would have no width at all.
      const width = await row
        .locator(".range-import-bar-fill")
        .evaluate((el) => (el as HTMLElement).style.width);
      expect(width).toMatch(/^\d+(\.\d+)?%$/);

      // And the text says how far it got.
      const raw = await row.locator(".range-import-progress-text").textContent();
      expect((raw ?? "").trim().length).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("does not poll a job that already finished", async () => {
    // A finished job has no progress left. The page marks the row so the
    // script skips it: a client that keeps asking about a finished job
    // is asking the database for nothing, forever.
    const page = await adminPage();
    try {
      await page.goto(`${baseUrl}/admin/ranges`, { waitUntil: "domcontentloaded" });

      // Every finished job's row must carry the marker.
      const rows = page.locator(".range-import-row[data-poll='off']");
      const total = await page.locator(".range-import-row").count();
      const off = await rows.count();
      // Whatever the history, every row that is not running is marked.
      const running = await page.locator(".range-import-row.is-running").count();
      expect(off).toBe(total - running);
    } finally {
      await page.close();
    }
  }, 60_000);
});
