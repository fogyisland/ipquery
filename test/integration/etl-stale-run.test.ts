// SPDX-License-Identifier: MIT
//
// Recovery of an ETL run that died without closing itself out.
//
// The `etl_runs` row is the human-visible record of a run, and it is
// also the guard: `findRunningEtlRun()` refuses every new run while a
// row is at status='running'. That is the right behaviour while a run
// is genuinely in flight, and the wrong behaviour after the run's
// process has died.
//
// The advisory lock (`GET_LOCK`) is released when the holding session
// ends — including on a hard crash — so the lock is already free. But
// the ROW still says 'running'. The result is a wedge:
//
//   - Every future ETL run is refused with "an ETL run is already in
//     progress", pointing at a run that ended days ago.
//   - The admin UI shows a run that has been "running" for days.
//   - The progress page polls forever.
//   - There is no UI affordance to clear it — only a hand-written
//     UPDATE against the database.
//
// This happened for real on 2026-11-23: run #6 sat at status='running'
// with current_stage='swap' for 5.8 hours because its process was
// killed while the rename was blocked on a metadata lock.
//
// The fix: a run that is old enough AND has no live lock holder is
// STALE. A stale run is closed out automatically (status='failed',
// with a message saying why) so the next run can proceed.
//
// The age threshold exists because "no lock holder" alone is not
// enough to conclude "dead": there is a window between the pipeline
// taking the advisory lock and the guard's own check, and a run that
// is genuinely running must never be declared stale.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as mysql from "mysql2/promise";
import { createPool, runMigrations, recordEtlStart } from "../../src/storage/mysql";
import {
  acquireEtlRunLock,
  findRunningEtlRun,
  closeStaleEtlRuns,
  STALE_RUN_AFTER_MINUTES,
} from "../../src/etl/runGuard";
import { loadConfig } from "../../src/config";

const TEST_DB = "ipquery_test_etl_stale";

describe("stale ETL run recovery", () => {
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
  }, 180_000);

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

  it("leaves a fresh run alone", async () => {
    const runId = await recordEtlStart(pool);
    try {
      const closed = await closeStaleEtlRuns(pool);
      expect(closed).toBe(0);
      // The run must still be running.
      expect(await findRunningEtlRun(pool)).toBe(runId);
    } finally {
      await pool.query(`UPDATE etl_runs SET status = 'failed', finished_at = NOW(3) WHERE id = ?`, [
        runId,
      ]);
    }
  });

  it("closes out an old run that has no live lock holder", async () => {
    const runId = await recordEtlStart(pool);
    try {
      // Backdate the run past the staleness threshold.
      await pool.query(
        `UPDATE etl_runs SET started_at = DATE_SUB(NOW(3), INTERVAL ? MINUTE) WHERE id = ?`,
        [STALE_RUN_AFTER_MINUTES + 10, runId],
      );

      // No advisory lock is held — the process that owned it is gone.
      const closed = await closeStaleEtlRuns(pool);
      expect(closed).toBe(1);

      // The run must no longer block the next one.
      expect(await findRunningEtlRun(pool)).toBeNull();

      // And it must be recorded as failed, with a message that says
      // why — an operator reading the run list needs to know this was
      // reclaimed, not that it succeeded.
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT status, finished_at, error_message FROM etl_runs WHERE id = ?",
        [runId],
      );
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.finished_at).not.toBeNull();
      expect(String(rows[0]?.error_message ?? "")).toMatch(/stale|abandon|no longer running/i);
    } finally {
      await pool.query(`UPDATE etl_runs SET status = 'failed', finished_at = NOW(3) WHERE id = ?`, [
        runId,
      ]);
    }
  });

  it("leaves an old run alone while its lock is still held", async () => {
    const runId = await recordEtlStart(pool);
    const guard = await acquireEtlRunLock(pool, { excludeRunId: runId });
    expect(guard.acquired).toBe(true);
    try {
      await pool.query(
        `UPDATE etl_runs SET started_at = DATE_SUB(NOW(3), INTERVAL ? MINUTE) WHERE id = ?`,
        [STALE_RUN_AFTER_MINUTES + 10, runId],
      );

      // The lock is held, so the run is genuinely in flight even
      // though it looks old. Closing it out would let a SECOND run
      // start and race it on truncateNew + atomicSwapRanges.
      const closed = await closeStaleEtlRuns(pool);
      expect(closed).toBe(0);
      expect(await findRunningEtlRun(pool)).toBe(runId);
    } finally {
      await guard.lock!.release();
      await pool.query(`UPDATE etl_runs SET status = 'failed', finished_at = NOW(3) WHERE id = ?`, [
        runId,
      ]);
    }
  });

  it("the guard reclaims a stale run so the next run can start", async () => {
    const runId = await recordEtlStart(pool);
    try {
      await pool.query(
        `UPDATE etl_runs SET started_at = DATE_SUB(NOW(3), INTERVAL ? MINUTE) WHERE id = ?`,
        [STALE_RUN_AFTER_MINUTES + 10, runId],
      );

      // acquireEtlRunLock is what every entry point goes through. It
      // must reclaim the stale run rather than refusing.
      const guard = await acquireEtlRunLock(pool);
      expect(guard.acquired).toBe(true);
      await guard.lock!.release();
    } finally {
      await pool.query(`UPDATE etl_runs SET status = 'failed', finished_at = NOW(3) WHERE id = ?`, [
        runId,
      ]);
    }
  });
});
