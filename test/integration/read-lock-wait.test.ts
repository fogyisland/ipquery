// SPDX-License-Identifier: MIT
//
// A read must not hang forever behind a metadata lock.
//
// The swap-side timeout (see atomic-swap-lock.test.ts) stops the ETL's
// `RENAME TABLE` from waiting a year for an EXCLUSIVE metadata lock. It
// does NOT stop the READS.
//
// Here is the chain that took the whole site down on 2026-11-23:
//
//   1. A rogue diagnostic held a SHARED metadata lock on `ip_ranges`
//      for 42 hours.
//   2. The ETL's `RENAME TABLE` asked for an EXCLUSIVE one. It went
//      PENDING and became the head of the metadata-lock queue.
//   3. A PENDING EXCLUSIVE request makes every LATER request wait —
//      including plain SELECTs that only need a SHARED lock and would
//      have been perfectly compatible with the reader in step 1.
//   4. Every route that reads `ip_ranges` hung: /lookup, /dashboard,
//      /stats. The homepage survived only because it reads no IP table.
//
// So the timeout has to be set on the READ path too. A read that cannot
// get its metadata lock within a few seconds must fail fast and say so,
// instead of holding a request open and a pool connection busy for a
// year.
//
// MySQL's `lock_wait_timeout` is the session variable that governs this
// for METADATA locks (as opposed to `innodb_lock_wait_timeout`, which
// governs row locks). It defaults to 31,536,000 seconds. Setting it
// per connection at connect time covers every query the pool runs.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import {
  createPool,
  runMigrations,
  findRange,
  insertIntoNew,
  truncateNew,
} from "../../src/storage/mysql";
import { loadConfig } from "../../src/config";
import type { IpRangeRow } from "../../src/types";

const TEST_DB = "ipquery_test_readlock";

function v4(a: number, b: number, c: number, d: number): Buffer {
  return Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, a, b, c, d]);
}

describe("reads must not hang behind a metadata lock", () => {
  let pool: mysql.Pool;
  const cfg = loadConfig();

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
    pool = createPool(cfg);
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
    const root = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
    });
    await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await root.end();
  });

  it("every pooled connection gets a short metadata-lock timeout", async () => {
    // The pool hands out connections freely. If only some of them
    // carried the setting, the read that happened to land on the wrong
    // connection would still hang — a failure that shows up under load
    // and not in a test. So the assertion is about EVERY connection the
    // pool opens, not about a single query.
    //
    // This reads the SESSION value, which is the one the pool arms on
    // each connection. The sibling test reads the GLOBAL value — the
    // server's default — which is a different thing on purpose.
    const connections = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const conn = await pool.getConnection();
        try {
          const [rows] = await conn.query<mysql.RowDataPacket[]>(
            "SHOW SESSION VARIABLES LIKE 'lock_wait_timeout'",
          );
          return Number(rows[0]?.Value);
        } finally {
          conn.release();
        }
      }),
    );

    for (const value of connections) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(60);
    }
  });

  it("the timeout is not the server's year-long default", async () => {
    // Same rationale as the swap test: pin the environment's default so
    // a server-side config change cannot quietly turn this suite
    // vacuous.
    //
    // It reads the GLOBAL value. The pool arms every session with a
    // short timeout, so the session value is the override — reading it
    // here would report the thing being overridden, not the thing being
    // overridden FROM.
    const [defaults] = await pool.query<mysql.RowDataPacket[]>(
      "SHOW GLOBAL VARIABLES LIKE 'lock_wait_timeout'",
    );
    expect(Number(defaults[0]?.Value)).toBeGreaterThan(3600);
  });

  it("a read that cannot take the lock fails fast instead of hanging", async () => {
    // Reproduce the site's outage in miniature: one session holds a
    // metadata lock, and the read has to wait for it.
    await truncateNew(pool);
    await insertIntoNew(pool, [
      {
        startIp: v4(10, 0, 0, 0),
        endIp: v4(10, 0, 0, 255),
        countryCode: "US",
        countrySource: "dbip",
      } as IpRangeRow,
    ]);

    const holder = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
      database: TEST_DB,
    });
    try {
      // The holder needs its own bounded wait too. Without it this
      // session would sit on MySQL's year-long default if some other
      // connection happened to hold the table, and the test would
      // hang instead of failing.
      await holder.query("SET SESSION lock_wait_timeout = 10");

      // A WRITE lock is the strongest thing a session can hold on a
      // table. A read needs a SHARED one, which cannot be granted while
      // this is in place.
      await holder.query("LOCK TABLES ip_ranges WRITE");

      const startedAt = Date.now();
      let error: unknown = null;
      try {
        await findRange(pool, v4(10, 0, 0, 1));
      } catch (err) {
        error = err;
      }
      const elapsedMs = Date.now() - startedAt;

      // The read must fail, and it must fail PROMPTLY. MySQL's default
      // is 31,536,000 seconds; anything near that is an outage.
      expect(error).toBeInstanceOf(Error);
      expect(elapsedMs).toBeLessThan(60_000);
    } finally {
      await holder.query("UNLOCK TABLES").catch(() => undefined);
      await holder.end();
    }
  }, 120_000);

  it("the failure names the metadata lock, so the operator can act on it", async () => {
    // A bare "ER_LOCK_WAIT_TIMEOUT" is not something an operator can
    // act on. The message has to say WHICH lock went wrong, because
    // the fix (interrupt the holder) is completely different from the
    // fix for a row-lock timeout.
    await truncateNew(pool);
    await insertIntoNew(pool, [
      {
        startIp: v4(10, 0, 0, 0),
        endIp: v4(10, 0, 0, 255),
        countryCode: "US",
        countrySource: "dbip",
      } as IpRangeRow,
    ]);

    const holder = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
      database: TEST_DB,
    });
    try {
      await holder.query("SET SESSION lock_wait_timeout = 10");
      await holder.query("LOCK TABLES ip_ranges WRITE");

      let error: Error | null = null;
      try {
        await findRange(pool, v4(10, 0, 0, 1));
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
      }

      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/metadata lock/i);
    } finally {
      await holder.query("UNLOCK TABLES").catch(() => undefined);
      await holder.end();
    }
  }, 120_000);
});
