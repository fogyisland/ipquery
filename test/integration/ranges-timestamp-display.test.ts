// SPDX-License-Identifier: MIT
//
// /admin/ranges shows two lists of jobs: the EXPORTS the operator has run
// and the IMPORTS they have uploaded. Both put a timestamp in a <time>
// element, and both need the same three things to be true at once:
//
//   1. the digits are the digits the DATABASE holds — the server's own wall
//      clock, which is what the pool reads (`timezone: "local"`);
//   2. the string says WHICH clock it is, so a reader in another zone (or
//      reading a screenshot in a bug report) can place it;
//   3. the `datetime` attribute is a value a machine can parse.
//
// The EXPORTS table has had all three since the clock fix. The IMPORTS
// table did not: it rendered the raw Date, so Handlebars printed
// `Date.toString()` — "Tue Nov 24 2026 01:16:05 GMT+0800 (China Standard
// Time)" — as both the visible text and the `datetime` attribute. That
// attribute is not a valid HTML date string, and the visible text is a
// JavaScript artifact rather than a timestamp.
//
// This file pins the IMPORTS cell to the same contract as the EXPORTS one.
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
let importId: number;

beforeAll(async () => {
  td = await createTestDb("rangests");
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

  // The job row the page will list. `started_at` is the server's own
  // clock — the column's default is CURRENT_TIMESTAMP(3) — so the row
  // carries a wall clock the page has to reproduce exactly.
  const [result] = await app.pool.query(
    `INSERT INTO range_imports (mode, source, status, rows_done, rows_written, preserved)
     VALUES ('merge', 'test.ipq', 'success', 10, 10, 0)`,
  );
  importId = Number((result as { insertId: number }).insertId);
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

/** The offset of the clock the digits are written in, as "±HH:MM". */
function localOffsetLabel(): string {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

/** The wall clock the DATABASE holds, read straight out of the column. */
async function dbLiteral(): Promise<string> {
  const [rows] = await app.pool.query(
    `SELECT CAST(started_at AS CHAR) AS literal FROM range_imports WHERE id = ?`,
    [importId],
  );
  return String(rows[0].literal);
}

describe("/admin/ranges job timestamps", () => {
  it("prints the import's start as a machine-readable, zone-named stamp", async () => {
    const r = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);

    const literal = await dbLiteral();
    expect(literal, "the row must exist for this test to mean anything").toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
    );

    // The same instant, written the way an HTML date string is written:
    // the wall clock the database holds, then the offset that says which
    // clock that is.
    const iso = literal.replace(" ", "T") + localOffsetLabel();
    expect(r.text).toContain(`<time datetime="${iso}">${iso}</time>`);
  });

  it("leaves no job timestamp rendered as a raw JavaScript Date", async () => {
    const r = await request(app.server)
      .get("/admin/ranges")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);

    // `Date.toString()` on this host ends in "GMT+0800 (中国标准时间)" — the
    // zone name is localised, but the shape is always "GMT±0800 (...)". A
    // `datetime` attribute holding that is not a date string.
    expect(r.text).not.toMatch(/GMT[+-]\d{4} \(/);
  });
});
