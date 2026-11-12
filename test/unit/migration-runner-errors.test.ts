// SPDX-License-Identifier: MIT
// Unit tests for the migration runner's error handling.
//
// The runner's job is to apply schema migrations. Its error handling
// matters more than it looks: the boot path decides whether a failure
// means "the database is unreachable" (degrade and serve the setup
// wizard) or "the schema is broken" (a real failure that must stop
// the server). That decision reads the driver's error `code` — so the
// runner must not throw it away.
import { describe, it, expect, vi } from "vitest";
import type * as mysql from "mysql2/promise";
import { runMigrations } from "../../src/storage/migrations/runner";

/**
 * A pool whose DDL fails with the given driver code.
 *
 * `getAppliedVersions` needs a working `query`, so the fake answers the
 * SELECT and the CREATE with an empty result set, and fails on the
 * migration statement itself.
 */
function poolFailingWith(code: string, message = "something went wrong"): mysql.Pool {
  const conn = {
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockImplementation(async (sql: string) => {
      // The migration's own DDL is the statement that fails.
      if (/CREATE TABLE/i.test(sql) && !/schema_migrations/i.test(sql)) {
        const err = new Error(message) as Error & { code?: string };
        err.code = code;
        throw err;
      }
      return [[], []];
    }),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn().mockResolvedValue([[], []]),
    getConnection: vi.fn().mockResolvedValue(conn),
  };
  return pool as unknown as mysql.Pool;
}

describe("runMigrations error handling", () => {
  it("keeps the driver's error code on the wrapped error", async () => {
    // The boot path classifies the failure by `code`. A wrapper that
    // drops it turns every migration failure into "unreachable
    // database" — and the server would quietly degrade instead of
    // reporting the actual problem.
    const err = await runMigrations(poolFailingWith("ER_TABLE_EXISTS_ERROR")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("ER_TABLE_EXISTS_ERROR");
  }, 60_000);

  it("keeps the original error as the cause", async () => {
    const err = await runMigrations(poolFailingWith("ER_DUP_FIELDNAME")).catch(
      (e: unknown) => e,
    );
    expect((err as { cause?: { code?: string } }).cause?.code).toBe("ER_DUP_FIELDNAME");
  }, 60_000);

  it("names the failing migration in the message", async () => {
    const err = await runMigrations(poolFailingWith("ER_TABLE_EXISTS_ERROR")).catch(
      (e: unknown) => e,
    );
    expect((err as Error).message).toMatch(/^migration \d{3} failed: /);
  }, 60_000);

  it("rolls the transaction back when a migration fails", async () => {
    const pool = poolFailingWith("ER_TABLE_EXISTS_ERROR");
    await runMigrations(pool).catch(() => undefined);
    const conn = await pool.getConnection();
    expect(conn.rollback).toHaveBeenCalled();
    expect(conn.commit).not.toHaveBeenCalled();
  }, 60_000);

  it("releases the connection even when a migration fails", async () => {
    const pool = poolFailingWith("ER_TABLE_EXISTS_ERROR");
    await runMigrations(pool).catch(() => undefined);
    const conn = await pool.getConnection();
    expect(conn.release).toHaveBeenCalled();
  }, 60_000);
});
