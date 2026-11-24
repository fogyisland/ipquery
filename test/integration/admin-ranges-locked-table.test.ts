// SPDX-License-Identifier: MIT
//
// /admin/ranges counts the library on every render:
//
//     SELECT COUNT(*) AS n FROM ip_ranges
//
// That count is the one thing on the page that can fail on its own. Every
// other query it makes — the export list, the import history — reads a
// different table, and the two forms read nothing at all. But `ip_ranges` is
// also the table everybody else wants: the ETL swaps it under a RENAME, a
// hand-run UPDATE takes a write lock on it, and a leftover transaction
// holds one. When that happens the count waits for the metadata lock until
// `lock_wait_timeout` and then throws ER_LOCK_WAIT_TIMEOUT — and the page
// did not survive it. The route's promise rejected, Fastify answered 500,
// and the operator got a bare `{"error":"internal_error"}` where the import
// form should have been.
//
// The replacement gate has the same dependency, and it is a different
// question: there the count is not decoration, it is the thing the
// operator types to prove they meant it. A gate that cannot read the
// number must not be waved through — so the replacement is refused, and
// the operator is told why.
//
// These tests pin both halves.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import * as mysql from "mysql2/promise";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { fetchCsrfTriple } from "../helpers/csrf";
import { encodeHeader } from "../../src/storage/rangeFile";
import { t, DEFAULT_LOCALE } from "../../src/web/i18n";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminSid: string;

/**
 * The session that holds the lock, if one is held.
 *
 * A connection of its own rather than one from the pool: ending it releases
 * the lock whatever the test does next, so a test that fails halfway
 * cannot leave the table locked for the rest of the suite.
 */
let locker: mysql.Connection | null = null;

/** How many ranges the library holds while the count can be read. */
const RANGE_COUNT = 7;

beforeAll(async () => {
  td = await createTestDb("rangeslock");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "admin@x.com",
    passwordHash: "h",
    displayName: "Admin",
    role: "admin",
  });
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, admin.id, new Date(Date.now() + 3600_000));
});

beforeEach(async () => {
  await td.pool.query("DELETE FROM ip_ranges");
  await insertRanges(RANGE_COUNT);
});

afterAll(async () => {
  await unlockRanges();
  await app.close();
  await dropTestDb(td);
});

/**
 * Put N ranges in the library.
 *
 * The addresses do not have to be reachable — nothing here looks a range
 * up, and the count is the only thing that reads them. What matters is
 * that there are exactly N rows.
 */
async function insertRanges(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    // The address is 16 bytes: twelve zero bytes and the IPv4 in the last
    // four. The end address is the start address with its last byte set.
    const tail = `0A${(20 + i).toString(16).padStart(2, "0")}0000`;
    const startIp = `000000000000000000000000${tail}`;
    const endIp = `000000000000000000000000${tail.slice(0, -2)}FF`;
    await td.pool.query(
      `INSERT INTO ip_ranges (start_ip, end_ip, range_size, country_code, country_source)
       VALUES (UNHEX('${startIp}'), UNHEX('${endIp}'), 255, 'ZZ', 'dbip')`,
    );
  }
}

/** Take a write lock on `ip_ranges`, the way a swap or an UPDATE does. */
async function lockRanges(): Promise<void> {
  const cfg = loadConfig();
  locker = await mysql.createConnection({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: td.dbName,
  });
  await locker.query("LOCK TABLES ip_ranges WRITE");
}

/** Let go of the lock. */
async function unlockRanges(): Promise<void> {
  if (!locker) return;
  const connection = locker;
  locker = null;
  try {
    await connection.query("UNLOCK TABLES");
  } catch (err) {
    console.warn(
      `[test] could not unlock ip_ranges: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await connection.end();
}

/** The flash is a Set-Cookie on the redirect; a browser replays it, supertest does not. */
function flashCookieOf(res: request.Response): string {
  const cookie = (res.headers["set-cookie"] as string[] | undefined)?.find((c) =>
    c.startsWith("ranges_flash="),
  );
  return cookie ? cookie.split(";")[0]! : "";
}

describe("/admin/ranges with ip_ranges locked by another session", () => {
  it("renders the page instead of failing with a 500", async () => {
    await lockRanges();
    try {
      const r = await request(app.server)
        .get("/admin/ranges")
        .set("Cookie", "sid=" + adminSid)
        .set("Accept-Language", "zh-CN");

      // The count times out against the lock; the rest of the page does not
      // depend on it, so the page is still worth rendering.
      expect(r.status).toBe(200);
      // The import form is the reason the operator came here.
      expect(r.text).toContain('id="range-upload-form"');
    } finally {
      await unlockRanges();
    }
  });

  it("says the count is unknown rather than showing a number it did not read", async () => {
    await lockRanges();
    try {
      const r = await request(app.server)
        .get("/admin/ranges")
        .set("Cookie", "sid=" + adminSid)
        .set("Accept-Language", "zh-CN");

      expect(r.status).toBe(200);
      expect(r.text).toContain(t(DEFAULT_LOCALE, "admin.ranges.replace.currentRowsUnknown"));

      // The library holds RANGE_COUNT rows, and the page could not read
      // that. It must not claim a number — neither the real one, nor a
      // zero standing in for it.
      expect(r.text).not.toContain(`<strong>${RANGE_COUNT}</strong>`);
      expect(r.text).not.toContain("<strong>0</strong>");
    } finally {
      await unlockRanges();
    }
  });

  it("shows the real count when the table can be counted", async () => {
    // The degradation is a response to a failure, not the page's normal
    // state: with the table readable the operator gets the number.
    const r = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid)
      .set("Accept-Language", "zh-CN");

    expect(r.status).toBe(200);
    expect(r.text).toContain(`<strong>${RANGE_COUNT}</strong>`);
    expect(r.text).not.toContain(t(DEFAULT_LOCALE, "admin.ranges.replace.currentRowsUnknown"));
  });

  it("refuses a replacement when the count cannot be read", async () => {
    // The gate compares the number the operator typed against the live
    // count. If the count cannot be read, the gate cannot check the
    // number — so the replacement is refused, and the operator is told
    // that nothing was replaced.
    const { cookie, token } = await fetchCsrfTriple(app, "/admin/ranges", "sid=" + adminSid);
    const body = encodeHeader({ exportedAt: new Date().toISOString(), rows: 0 }) + "\n";

    await lockRanges();
    let posted: request.Response;
    try {
      posted = await request(app.server)
        .post("/admin/ranges/import")
        .set("Cookie", "sid=" + adminSid + "; " + cookie)
        .set("Accept-Language", "zh-CN")
        .type("form")
        .send({ csrf: token, file: body, mode: "replace", confirmRows: String(RANGE_COUNT) });
    } finally {
      await unlockRanges();
    }

    expect(posted!.status).toBe(302);
    const page = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid + "; " + flashCookieOf(posted!))
      .set("Accept-Language", "zh-CN");
    expect(page.text).toContain(t(DEFAULT_LOCALE, "admin.ranges.replace.countUnavailable"));

    // And the library is still there: a gate that cannot check the number
    // must not be waved through.
    const [rows] = await td.pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM ip_ranges",
    );
    expect(Number(rows[0]!.n)).toBe(RANGE_COUNT);
  });
});
