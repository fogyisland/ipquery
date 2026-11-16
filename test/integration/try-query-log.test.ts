// SPDX-License-Identifier: MIT
// Integration test: the /try query form logs only for signed-in visitors.
//
// `/try` is the browser query form — the page most visitors actually use
// to look something up. It called findRange() directly and never touched
// the query-log writer, so the analytics page counted nothing at all for
// it: the rows simply never existed.
//
// The rule that now applies is the one /lookup already follows: a query
// is worth recording when it can be attributed to someone. A signed-in
// visitor has a session user, so the row is written with that user and
// the session id. An anonymous visitor has neither, and the row is
// skipped rather than written as unattributable traffic.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { csrfTripleFrom } from "../helpers/csrf";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/api/server";
import { insertIntoNew, atomicSwapRanges, truncateNew } from "../../src/storage/mysql";
import { createUser } from "../../src/storage/users";
import { createSession } from "../../src/storage/sessions";
import { generateToken } from "../../src/web/auth/tokens";
import { parseIp } from "../../src/ip";

let td: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;

// A /24 in right-aligned 16-byte form — the shape parseIp() writes.
const RANGE_START = "000000000000000000000000cb007100";
const RANGE_END = "000000000000000000000000cb00717f";

let sessionUserId: number;
let sid: string;

beforeAll(async () => {
  td = await createTestDb("try_query_log");
  const cfg = loadConfig();
  cfg.db.database = td.dbName;
  await truncateNew(td.pool);
  await insertIntoNew(td.pool, [
    {
      startIp: Buffer.from(RANGE_START, "hex"),
      endIp: Buffer.from(RANGE_END, "hex"),
      countryCode: "US",
      countryName: "United States",
      countrySource: "dbip",
      citySource: "dbip",
      geoSource: "dbip",
    },
  ]);
  await atomicSwapRanges(td.pool);
  app = await buildServer(cfg);

  const user = await createUser(td.pool, {
    email: "trylog@test",
    passwordHash: "h",
    displayName: "TryLog",
  });
  sessionUserId = user.id;
  sid = generateToken(16);
  await createSession(td.pool, sid, sessionUserId, new Date(Date.now() + 3600_000));
});

afterAll(async () => {
  await app.close();
  await dropTestDb(td);
});

/** Force the batched writer to flush so assertions see the row. */
const flush = (): Promise<void> => app.flushQueryLog();

/** POST /try with a valid CSRF triple and an optional session cookie. */
async function tryIp(ip: string, cookie?: string): Promise<request.Response> {
  const page = await request(app.server)
    .get("/try")
    .set("Cookie", cookie ?? "");
  const pair = csrfTripleFrom(page.headers["set-cookie"] as string[]);
  return request(app.server)
    .post("/try")
    .set("Cookie", `${pair.cookie}${cookie ? "; " + cookie : ""}`)
    .type("form")
    .send({ csrf: pair.token, ip });
}

/** Count query_log rows, optionally scoped to a user. */
async function countRows(userId?: number): Promise<number> {
  const [rows] = await td.pool.query(
    userId === undefined
      ? `SELECT COUNT(*) AS c FROM query_log`
      : `SELECT COUNT(*) AS c FROM query_log WHERE user_id = ?`,
    userId === undefined ? [] : [userId],
  );
  return Number((rows as { c: number }[])[0].c);
}

describe("/try query form writes query_log", () => {
  it("records a hit for a signed-in visitor", async () => {
    const before = await countRows(sessionUserId);
    const r = await tryIp("203.0.113.10", "sid=" + sid);
    expect(r.status).toBe(200);
    await flush();

    const [rows] = await td.pool.query(
      `SELECT * FROM query_log WHERE user_id = ? AND ip_text = ? ORDER BY id DESC LIMIT 1`,
      [sessionUserId, "203.0.113.10"],
    );
    const row = (
      rows as {
        status: string;
        user_id: number;
        api_key_id: number | null;
        session_id: string | null;
        ip: Buffer;
      }[]
    )[0];
    expect(row).toBeDefined();
    expect(row.status).toBe("hit");
    expect(row.user_id).toBe(sessionUserId);
    expect(row.api_key_id).toBeNull();
    expect(row.session_id).toBe(sid);
    expect(parseIp("203.0.113.10")!.equals(row.ip)).toBe(true);
    expect(await countRows(sessionUserId)).toBe(before + 1);
  });

  it("records a miss for a signed-in visitor on an unknown address", async () => {
    const before = await countRows(sessionUserId);
    const r = await tryIp("198.51.100.7", "sid=" + sid);
    expect(r.status).toBe(200);
    await flush();

    const [rows] = await td.pool.query(
      `SELECT * FROM query_log WHERE user_id = ? AND ip_text = ? AND status = 'miss' ORDER BY id DESC LIMIT 1`,
      [sessionUserId, "198.51.100.7"],
    );
    expect((rows as unknown[])[0]).toBeDefined();
    expect(await countRows(sessionUserId)).toBe(before + 1);
  });

  it("records an invalid address for a signed-in visitor", async () => {
    const before = await countRows(sessionUserId);
    const r = await tryIp("not-an-ip", "sid=" + sid);
    expect(r.status).toBe(200);
    await flush();

    const [rows] = await td.pool.query(
      `SELECT * FROM query_log WHERE user_id = ? AND ip_text = ? AND status = 'invalid' ORDER BY id DESC LIMIT 1`,
      [sessionUserId, "not-an-ip"],
    );
    expect((rows as unknown[])[0]).toBeDefined();
    expect(await countRows(sessionUserId)).toBe(before + 1);
  });

  it("records nothing for an anonymous visitor", async () => {
    const totalBefore = await countRows();
    await tryIp("203.0.113.10");
    await flush();
    expect(await countRows()).toBe(totalBefore);
  });

  it("records nothing for an anonymous visitor even when the address is unknown", async () => {
    const totalBefore = await countRows();
    await tryIp("198.51.100.7");
    await flush();
    expect(await countRows()).toBe(totalBefore);
  });
});
