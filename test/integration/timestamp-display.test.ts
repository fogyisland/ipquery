// SPDX-License-Identifier: MIT
//
// The console prints absolute timestamps in the clock the DATABASE keeps
// them in — the server's own wall clock, which is what the pool reads
// (`timezone: "local"`). That is the right thing to show an operator who
// works on the same host as the database.
//
// But a bare "2026-11-24 01:42:00" says nothing about WHICH clock it is.
// An operator reading the console from another zone, or reading a
// screenshot in a bug report, has no way to place it. The CSV export
// already answers this by writing the offset out; the console does not.
//
// This file pins that gap shut: every absolute timestamp the console
// renders carries the offset of the clock it is in, and the digits it
// shows are the digits the database holds.
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

const MARKER = "198.51.100.7";

beforeAll(async () => {
  td = await createTestDb("tsdisplay");
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
  await app.pool.query(
    `INSERT INTO query_log (ip, ip_text, status, ts)
     VALUES (UNHEX('0000000000000000000000000000C633'), ?, 'hit', NOW(3))`,
    [MARKER],
  );
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
    `SELECT DATE_FORMAT(ts, '%Y-%m-%d %H:%i:%s') AS literal FROM query_log WHERE ip_text = ?`,
    [MARKER],
  );
  return String(rows[0].literal);
}

describe("the absolute timestamps the console renders", () => {
  it("names the clock they are in", async () => {
    const r = await request(app.server)
      .get("/admin/audit")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);

    // The wall clock the DATABASE holds — the server's own clock, with no
    // conversion applied to it anywhere.
    const literal = await dbLiteral();
    expect(literal, "the row must exist for this test to mean anything").toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );

    // The console has to show those exact digits — the ones the database
    // wrote — and then say which clock they are in.
    expect(r.text).toContain(
      `<td class="table-num">${literal} ${localOffsetLabel()}</td>`,
    );
  });

  it("leaves no absolute timestamp without a zone marker", async () => {
    const r = await request(app.server)
      .get("/admin/audit")
      .set("Cookie", "sid=" + adminSid);
    expect(r.status).toBe(200);

    // A cell that ends in a bare timestamp is the failure this test
    // exists to catch: a reader has no way to place it.
    const bare = [...r.text.matchAll(/<td class="table-num">([^<]*)<\/td>/g)]
      .map((m) => (m[1] ?? "").trim())
      .filter((cell) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cell));
    expect(bare, "a timestamp was rendered without its zone").toEqual([]);
  });
});
