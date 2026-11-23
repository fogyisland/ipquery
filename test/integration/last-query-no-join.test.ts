// SPDX-License-Identifier: MIT
//
// The dashboard's "last query" hero must not depend on the IP table.
//
// On 2026-11-23 the whole console went down. The cause was not the
// database being slow — it was one route's SQL:
//
//   SELECT q.ip_text, q.status, q.ts, r.country_code, r.country_name, r.asn_org
//     FROM query_log q
//     LEFT JOIN ip_ranges r ON r.start_ip <= q.ip AND r.end_ip >= q.ip
//                            AND r.country_code IS NOT NULL
//    WHERE q.user_id = ?
//    ORDER BY q.ts DESC, q.id DESC
//    LIMIT 1
//
// That LEFT JOIN puts `ip_ranges` in the statement, so the statement
// needs a metadata lock on it. When a rename was pending on that table,
// every /dashboard request queued behind it — a page whose real job is
// "show me my query history" could not be served because it asked for
// the country of the last IP.
//
// The join buys three decorative fields. The rest of the row — the IP,
// the status, the timestamp — comes from `query_log`, which is not
// locked by anything.
//
// So the shape of the fix is: read the row WITHOUT the join, then
// resolve the geography separately, and let the geography fail
// quietly. A missing country name is a cosmetic loss. A dead console
// is an outage.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { getLastUserQuery } from "../../src/storage/queryLog";
import { insertQueryLogs } from "../../src/storage/queryLog";
import { parseIp } from "../../src/ip";
import { loadConfig } from "../../src/config";

let td: TestDb;
const USER_ID = 4242;

beforeAll(async () => {
  td = await createTestDb("lastquery");
  await insertQueryLogs(td.pool, [
    {
      ip: parseIp("8.8.8.8")!,
      ipText: "8.8.8.8",
      status: "hit",
      userId: USER_ID,
      apiKeyId: null,
      sessionId: null,
      remoteAddr: null,
      userAgent: null,
    },
  ]);
});

afterAll(async () => {
  await dropTestDb(td);
});

describe("getLastUserQuery", () => {
  it("returns the row without needing the IP table", async () => {
    const r = await getLastUserQuery(td.pool, USER_ID);
    // The query_log row is there; the geography is optional.
    expect(r).not.toBeNull();
    expect(r!.ipText).toBe("8.8.8.8");
    expect(r!.status).toBe("hit");
    expect(r!.ts).toBeInstanceOf(Date);
  });

  it("still answers while the IP table is locked", async () => {
    // Hold an EXCLUSIVE metadata lock on ip_ranges from another
    // session, exactly like a pending RENAME does. The hero element
    // must still render: the row comes from query_log, which is free.
    const cfg = loadConfig();
    const holder = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
      database: td.dbName,
    });
    try {
      // The holder's own wait is bounded too. Without this it would sit
      // on MySQL's year-long default if anything else held the table,
      // and the test would hang instead of failing.
      await holder.query("SET SESSION lock_wait_timeout = 10");
      await holder.query("LOCK TABLES ip_ranges WRITE");

      const startedAt = Date.now();
      const r = await getLastUserQuery(td.pool, USER_ID);
      const elapsedMs = Date.now() - startedAt;

      expect(r).not.toBeNull();
      expect(r!.ipText).toBe("8.8.8.8");
      // The point of the test: it did not wait on the lock. The
      // geography is decoration, so it gets a short bound of its own
      // (OPTIONAL_READ_LOCK_WAIT_SECONDS = 2) rather than the pool's
      // longer one.
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      await holder.query("UNLOCK TABLES").catch(() => undefined);
      await holder.end();
    }
  }, 60_000);

  it("returns null when the user has no queries", async () => {
    const r = await getLastUserQuery(td.pool, 999_999);
    expect(r).toBeNull();
  });
});
