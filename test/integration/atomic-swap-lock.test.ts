// SPDX-License-Identifier: MIT
//
// The atomic swap must not hang forever.
//
// `RENAME TABLE` needs an EXCLUSIVE metadata lock on every table it
// touches. MySQL's `lock_wait_timeout` — the timeout that applies to
// METADATA locks, as opposed to `innodb_lock_wait_timeout` for row
// locks — defaults to 31,536,000 seconds. That is a YEAR. So when any
// other session happens to hold a long-running read on `ip_ranges`, the
// rename waits for a year instead of failing.
//
// The failure mode is not a clean error. It is:
//
//   1. The ETL's `etl_runs` row stays at status='running' forever, with
//      `current_stage='swap'`.
//   2. `findRunningEtlRun()` then refuses every subsequent ETL run —
//      the admin can never re-run it without a manual database edit.
//   3. Every read of `ip_ranges` queues behind the pending rename's
//      metadata lock, so `/lookup`, `/dashboard` and the landing page
//      all hang.
//
// This happened for real on 2026-11-23: run #6 sat in the swap stage
// for 5.8 hours because an unrelated ad-hoc diagnostic query held a
// read on the table. The fix is to give the swap connection a SHORT
// metadata-lock timeout, so the rename fails fast and the run is
// recorded as failed — which the pipeline already knows how to do.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import {
  createPool,
  runMigrations,
  atomicSwapRanges,
  insertIntoNew,
  truncateNew,
} from "../../src/storage/mysql";
import { loadConfig } from "../../src/config";
import type { IpRangeRow } from "../../src/types";

const TEST_DB = "ipquery_test_swaplock";

function v4(a: number, b: number, c: number, d: number): Buffer {
  return Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, a, b, c, d]);
}

describe("atomicSwapRanges metadata-lock timeout", () => {
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

  it("the server's default metadata-lock timeout is a year, so the swap must override it", async () => {
    // This is the baseline the fix departs from. MySQL's
    // `lock_wait_timeout` — the timeout that applies to METADATA
    // locks — defaults to 31,536,000 seconds. A rename that waits for
    // that long is a rename that never returns.
    //
    // The assertion pins the environment's default so that a future
    // MySQL upgrade (or a server-wide config change) does not silently
    // make this test vacuous.
    const [defaults] = await pool.query<mysql.RowDataPacket[]>(
      "SHOW VARIABLES LIKE 'lock_wait_timeout'",
    );
    const defaultValue = Number(defaults[0]?.Value);
    expect(defaultValue).toBeGreaterThan(3600);
  });

  it("fails the swap instead of waiting a year when the table is locked", async () => {
    // Hold a metadata lock on ip_ranges from another session, exactly
    // like the rogue diagnostic query did. `LOCK TABLES ... READ`
    // takes a metadata lock that the rename's exclusive one cannot
    // pass — and it is the portable way to say it on MySQL 5.7 (which
    // has no `FOR SHARE`).
    await truncateNew(pool);
    await insertIntoNew(pool, [
      {
        startIp: v4(10, 0, 0, 0),
        endIp: v4(10, 0, 0, 255),
        countryCode: "US",
        countrySource: "dbip",
      } as IpRangeRow,
    ]);

    const blocker = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
      database: TEST_DB,
    });
    try {
      await blocker.query("LOCK TABLES ip_ranges READ");

      const startedAt = Date.now();
      const result = await atomicSwapRanges(pool);
      const elapsedMs = Date.now() - startedAt;

      // The swap must FAIL, not hang.
      expect(result.status).toBe("failed");
      expect(result.errorMessage).toBeTruthy();

      // And it must fail PROMPTLY. MySQL's default is 31,536,000
      // seconds; a fix that merely bounds it at, say, 60s is still a
      // minute of downtime for every reader. The bound is 30s in the
      // fix, so 60s leaves headroom for a loaded box while still
      // failing well inside the test's own patience.
      expect(elapsedMs).toBeLessThan(60_000);
    } finally {
      await blocker.query("UNLOCK TABLES").catch(() => undefined);
      await blocker.end();
    }
  }, 120_000);
});
