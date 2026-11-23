// SPDX-License-Identifier: MIT
//
// Timestamps the DATABASE wrote.
//
// MySQL stamps `created_at` with its own clock, in the server's own time
// zone, and it stamps `ts`, `updated_at` and `expires_at` the same way
// unless the application hands it a value. The reader has to interpret
// those literals in the same zone the server wrote them, or every
// relative time in the console is off by the server's offset from UTC.
//
// On a +08:00 host the pool used to read DATETIME columns as UTC while
// the server wrote them in its own zone, so a user created a moment ago
// rendered as "in about 8 hours" — the future, in the operator's own
// console. The same offset stretched the query-log window from 24 hours
// to 32.
//
// Nothing in this file names an offset. The assertions compare the
// console against the clock the DATABASE reports, so they hold on a
// UTC host and on a +08:00 host alike.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { getQueryStats } from "../../src/web/admin/queries";
import { countQueriesByDay } from "../../src/storage/queryLog";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let adminUid: number;
let adminSid: string;

beforeAll(async () => {
  td = await createTestDb("timestamps");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  app = await buildServer(cfg);
  const admin = await createUser(app.pool, {
    email: "admin@x.com",
    passwordHash: "h",
    displayName: "Admin",
    role: "admin",
  });
  adminUid = admin.id;
  adminSid = generateToken(16);
  await createSession(app.pool, adminSid, adminUid, new Date(Date.now() + 3600_000));
});

afterAll(async () => {
  // `beforeAll` can fail before `app` is assigned — a failed setup must
  // not replace its own error with a teardown crash. The setup failure is
  // the one worth reading.
  if (app) await app.close();
  if (td) await dropTestDb(td);
});

describe("timestamps the database wrote", () => {
  it("reads a row back as the moment the server stamped it", async () => {
    // The row's `created_at` is the server's own NOW(). The console has
    // to call that "now", not "now plus the server's offset from UTC".
    const [now] = await app.pool.query("SELECT NOW(3) AS n");
    await app.pool.query("UPDATE users SET created_at = ? WHERE id = ?", [now[0].n, adminUid]);

    const en = await request(app.server)
      .get("/admin/users")
      .set("Cookie", `sid=${adminSid}; lang=en-US`);
    expect(en.status).toBe(200);
    expect(en.text).toMatch(/less than a minute ago/);
    expect(en.text).not.toMatch(/in about \d+ (minute|hour|day)s?/);

    const zh = await request(app.server)
      .get("/admin/users")
      .set("Cookie", `sid=${adminSid}; lang=zh-CN`);
    expect(zh.status).toBe(200);
    expect(zh.text).toMatch(/不到\s*1\s*分钟前/);
  });

  it("prints the wall clock the database stored", async () => {
    // The absolute timestamp is a different question from the relative
    // one: it must read as the literal the server wrote, with no shift
    // in either direction. `CAST(... AS CHAR)` gives the raw stored
    // string, because a DATETIME read back through the driver is
    // already a Date and has lost the literal.
    const [rows] = await app.pool.query("SELECT CAST(created_at AS CHAR) AS c FROM users WHERE id = ?", [
      adminUid,
    ]);
    const stored = String(rows[0].c); // e.g. "2026-11-24 01:16:05.193"
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

    const r = await request(app.server)
      .get(`/admin/users/${adminUid}`)
      .set("Cookie", `sid=${adminSid}; lang=en-US`);
    expect(r.status).toBe(200);
    expect(r.text).toContain(stored.slice(0, 19));
  });

  it("keeps a session it created a moment ago alive", async () => {
    // The expiry the application writes and the clock the database
    // compares it against have to be the same one. When they are not,
    // the session is either already dead on arrival or never dies.
    const r = await request(app.server)
      .get("/admin/users")
      .set("Cookie", `sid=${adminSid}; lang=en-US`);
    expect(r.status).toBe(200);
    expect(r.text).toContain("admin@x.com");
  });
});

describe("the query-log window", () => {
  it("covers 24 hours, not 24 hours plus the server's offset", async () => {
    // Two rows: one an hour old, one thirty hours old. Only the recent
    // one belongs in the last 24 hours.
    await app.pool.query(
      `INSERT INTO query_log (ip, ip_text, status, ts)
       VALUES (UNHEX('00000000000000000000000000000000'), '192.0.2.1', 'hit', NOW(3) - INTERVAL 1 HOUR),
              (UNHEX('00000000000000000000000000000001'), '192.0.2.2', 'hit', NOW(3) - INTERVAL 30 HOUR)`,
    );

    const stats = await getQueryStats(app.pool);
    expect(stats.total).toBe(1);
  });
});

describe("a timestamp in an export", () => {
  it("is printed in the clock the database keeps it in", async () => {
    // The export and the console show the same row. If the export
    // converted the wall clock into UTC, the two would be eight hours
    // apart on a +08:00 host — the same row, two times, in two places a
    // minute apart.
    await app.pool.query(
      `INSERT INTO query_log (ip, ip_text, status, ts)
       VALUES (UNHEX('00000000000000000000000000000002'), '192.0.2.9', 'hit', NOW(3))`,
    );
    const [rows] = await app.pool.query(
      "SELECT CAST(ts AS CHAR) AS c FROM query_log WHERE ip_text = '192.0.2.9'",
    );
    const stored = String(rows[0].c); // e.g. "2026-11-24 01:16:05.193"

    const r = await request(app.server)
      .get("/admin/queries.csv")
      .set("Cookie", `sid=${adminSid}; lang=en-US`);
    expect(r.status).toBe(200);

    // The digits are the ones the database holds, and the offset says
    // which clock they are in.
    expect(r.text).toContain(stored.slice(0, 19).replace(" ", "T"));
    expect(r.text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/);
  });
});

describe("the daily buckets", () => {
  it("keys each row by the UTC day the database says it belongs to", async () => {
    // The buckets are keyed by UTC day. A row's UTC day is its stamp
    // minus the server's offset from UTC — worked out here by
    // arithmetic, so the test does not lean on the same expression the
    // implementation uses.
    const marker = "192.0.2.88";
    await app.pool.query(
      `INSERT INTO query_log (ip, ip_text, status, ts)
       VALUES (UNHEX('00000000000000000000000000000004'), ?, 'hit', NOW(3))`,
      [marker],
    );

    const [offsetRows] = await app.pool.query(
      "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS off",
    );
    const offsetSec = Number(offsetRows[0].off);
    const [dayRows] = await app.pool.query(
      "SELECT DATE_FORMAT(ts - INTERVAL ? SECOND, '%Y-%m-%d') AS utc_day FROM query_log WHERE ip_text = ?",
      [offsetSec, marker],
    );
    const utcDay = String(dayRows[0].utc_day);

    const buckets = await countQueriesByDay(app.pool, 7);
    const bucket = buckets.find((b) => b.date === utcDay);
    expect(bucket, `no bucket for the UTC day ${utcDay}`).toBeDefined();
    expect(bucket?.total ?? 0).toBeGreaterThanOrEqual(1);
  });
});
