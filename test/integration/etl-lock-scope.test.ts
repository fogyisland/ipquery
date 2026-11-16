// SPDX-License-Identifier: MIT
// Integration test: the ETL run lock is scoped per database.
//
// `GET_LOCK` in MySQL is keyed by NAME, and the name was the constant
// `ipquery:etl:run` — the comment claimed it was per-database but the
// code never said so. Every IPQuery database on one MySQL server
// therefore shared a single lock: a run against `ipquery_test_a` blocked
// a run against `ipquery_test_b`, and the integration suite deadlocked
// against itself whenever two files ran a pipeline.
//
// The lock name now carries the database it protects.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { createTestDb, dropTestDb, type TestDb } from "../helpers/db";
import { loadConfig } from "../../src/config";
import { acquireEtlRunLock } from "../../src/etl/runGuard";

let dbA: TestDb;
let dbB: TestDb;

beforeAll(async () => {
  dbA = await createTestDb("lock_scope_a");
  dbB = await createTestDb("lock_scope_b");
});

afterAll(async () => {
  await dropTestDb(dbA);
  await dropTestDb(dbB);
});

describe("ETL run lock scope", () => {
  it("lets two different databases hold the lock at the same time", async () => {
    const held = await acquireEtlRunLock(dbA.pool);
    expect(held.acquired).toBe(true);
    try {
      // A second database is a different library and its own run; it must
      // not be refused because the first one is mid-refresh.
      const other = await acquireEtlRunLock(dbB.pool);
      expect(other.acquired).toBe(true);
      if (other.lock) await other.lock.release();
    } finally {
      if (held.lock) await held.lock.release();
    }
  });

  it("still refuses a second run against the same database", async () => {
    const held = await acquireEtlRunLock(dbA.pool);
    expect(held.acquired).toBe(true);
    try {
      const second = await acquireEtlRunLock(dbA.pool);
      expect(second.acquired).toBe(false);
      expect(second.reason).toBeTruthy();
    } finally {
      if (held.lock) await held.lock.release();
    }
  });

  it("releases the lock so the next run in the same database can start", async () => {
    const held = await acquireEtlRunLock(dbA.pool);
    expect(held.acquired).toBe(true);
    if (held.lock) await held.lock.release();

    const again = await acquireEtlRunLock(dbA.pool);
    expect(again.acquired).toBe(true);
    if (again.lock) await again.lock.release();
  });

  it("names the lock after the database it protects", async () => {
    // The name is the contract: two libraries must never collide, and one
    // database must never be protected by two different names.
    const [rows] = await daoQuery("SELECT DATABASE() AS db");
    void rows;
    const held = await acquireEtlRunLock(dbA.pool);
    expect(held.acquired).toBe(true);
    try {
      const cfg = loadConfig();
      const probe = await mysql.createConnection({
        host: cfg.db.host,
        port: cfg.db.port,
        user: cfg.db.user,
        password: cfg.db.password,
      });
      try {
        const expected = `ipquery:etl:run:${dbA.dbName}`;
        const [locked] = await probe.query<mysql.RowDataPacket[]>(
          `SELECT IS_USED_LOCK(?) AS holder`,
          [expected],
        );
        expect(locked[0]?.holder).not.toBeNull();
      } finally {
        await probe.end();
      }
    } finally {
      if (held.lock) await held.lock.release();
    }
  });
});

/** Runs a query on dbA's pool; kept separate so the assertion above reads
 *  clearly. */
async function daoQuery(sql: string): Promise<[mysql.RowDataPacket[], unknown]> {
  const [rows] = await dbA.pool.query<mysql.RowDataPacket[]>(sql);
  return [rows, null];
}
