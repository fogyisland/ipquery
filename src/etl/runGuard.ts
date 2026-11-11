// SPDX-License-Identifier: MIT
//
// ETL single-run guard.
//
// Four independent entry points can start an ETL run:
//
//   1. POST /admin/etl/trigger          (web server, manual)
//   2. POST /admin/settings/etl-restart (web server, manual)
//   3. the init wizard's background ETL (web server, background)
//   4. `ipq serve`'s cron schedule      (server process, scheduled)
//
// None of them knows about the others. Two concurrent runs are not
// merely wasteful: the pipeline truncates `ip_ranges_new`, streams rows
// into it, then `RENAME TABLE`s it over `ip_ranges`. Two runs racing on
// that means one run's truncate wipes the other's partial insert, and
// the surviving table is whichever RENAME happened to land last — a
// silently truncated or half-populated live table.
//
// This module is the single place that answers "may I run an ETL right
// now?".
//
// Two layers, because there are two failure modes:
//
//   - A MySQL advisory lock (`GET_LOCK`) gives CROSS-PROCESS exclusion.
//     The web server and the CLI are separate processes; an in-process
//     mutex cannot see the other one. `GET_LOCK` is scoped to the
//     MySQL session that took it, so the lock is released when the
//     session ends — including on a hard crash — and never leaks.
//
//   - The `etl_runs` row check gives a durable, human-visible answer.
//     If a previous run crashed hard enough that its row is stuck at
//     status='running', the advisory lock is already free (the session
//     died), but the row would still say "running" — so the admin UI
//     shows a run that has been "running" for three days and the
//     progress page polls forever. The row check catches that.
//
// The advisory lock alone is not enough (a stale row would block every
// future run) and the row check alone is not enough (it is racy between
// two processes that check at the same moment). Both together: the lock
// closes the race, the row check explains the refusal to a human.
//
// ── Why a dedicated connection ────────────────────────────────────────
//
// `GET_LOCK` is scoped to the MySQL *session*. The mysql2 pool hands
// out arbitrary connections, so taking the lock on one pooled
// connection and releasing it on another releases nothing — the lock
// stays held by the original session, which then returns to the pool
// and blocks every later caller. Everything here therefore operates on
// ONE dedicated connection checked out of the pool for the whole run,
// and the lock and the connection are released together.

import type { Pool } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";

/** The advisory lock name. Scoped per-database so two IPQuery installs
 *  sharing one MySQL server don't block each other. */
const LOCK_NAME = "ipquery:etl:run";

/** How long to wait for the advisory lock before giving up, in seconds.
 *  Zero: the ETL takes minutes, so a lock holder is legitimately busy
 *  for a long time. Every caller here wants a synchronous "no" it can
 *  surface as a flash message, not a multi-minute block. */
const LOCK_WAIT_SECONDS = 0;

export interface EtlGuardResult {
  /** True when the caller may start a run. */
  acquired: boolean;
  /** Human-readable reason, set when acquired is false. */
  reason?: string;
  /** The id of the run that is already in progress, if any. */
  runningRunId?: number;
  /** True when the refusal came from a stale row rather than a live
   *  process — the caller may offer a "force" affordance in that case. */
  stale?: boolean;
}

/**
 * Find the id of the run row currently at status='running', if any.
 *
 * `excludeRunId` skips one row. The init wizard creates its run row
 * up-front (it needs the id for the progress page before the pipeline
 * starts) and then hands it to the pipeline — without the exclusion
 * the pipeline's own guard would see that row and refuse to run.
 *
 * Returns null when there is no such row.
 */
export async function findRunningEtlRun(pool: Pool, excludeRunId?: number): Promise<number | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM etl_runs
      WHERE status = 'running' ${excludeRunId !== undefined ? "AND id <> ?" : ""}
      ORDER BY id DESC LIMIT 1`,
    excludeRunId !== undefined ? [excludeRunId] : [],
  );
  if (rows.length === 0) return null;
  return Number(rows[0]!.id);
}

/**
 * A held ETL run lock. Call `release()` exactly once when the run is
 * over — including on the error path.
 */
export interface EtlRunLock {
  /** Release the advisory lock and return the connection to the pool. */
  release(): Promise<void>;
}

/**
 * Try to take the ETL run lock.
 *
 * Returns `acquired: true` when the caller may proceed. On refusal the
 * `reason` explains why in a form suitable for a flash message.
 *
 * The caller MUST call `release()` when the run finishes. If the caller
 * forgets, the lock is released when the connection is closed — which
 * happens at process exit — so a forgotten release is a hang, not a
 * permanent wedge.
 */
export async function acquireEtlRunLock(
  pool: Pool,
  opts?: { excludeRunId?: number },
): Promise<EtlGuardResult & { lock?: EtlRunLock }> {
  // Cheap pre-check first: it avoids burning a pooled connection on the
  // common "an ETL really is running" path, and it gives the caller the
  // run id so the UI can link to the in-progress run.
  const runningRunId = await findRunningEtlRun(pool, opts?.excludeRunId);
  if (runningRunId !== null) {
    return {
      acquired: false,
      reason: "an ETL run is already in progress",
      runningRunId,
      stale: false,
    };
  }

  const conn = await pool.getConnection();
  let held = false;
  try {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT GET_LOCK(?, ?) AS acquired`,
      [LOCK_NAME, LOCK_WAIT_SECONDS],
    );
    // GET_LOCK returns 1 on success, 0 on timeout, NULL on error.
    if (Number(rows[0]?.acquired) !== 1) {
      conn.release();
      return {
        acquired: false,
        reason: "another ETL process holds the run lock",
        stale: false,
      };
    }
    held = true;

    // Re-check the row table now that we hold the lock. Between the
    // first check and here, a peer process could have finished its own
    // check and taken the lock — in which case our GET_LOCK would have
    // failed above. It could also have completed a whole run and left a
    // new 'running' row while we were waiting on the lock. Re-checking
    // makes the decision on state we know is current.
    const recheck = await findRunningEtlRun(pool, opts?.excludeRunId);
    if (recheck !== null) {
      await conn.query(`SELECT RELEASE_LOCK(?) AS released`, [LOCK_NAME]);
      held = false;
      conn.release();
      return {
        acquired: false,
        reason: "an ETL run is already in progress",
        runningRunId: recheck,
        stale: false,
      };
    }

    let released = false;
    const lock: EtlRunLock = {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        try {
          await conn.query(`SELECT RELEASE_LOCK(?) AS released`, [LOCK_NAME]);
        } catch {
          // Best-effort: the lock is session-scoped, so MySQL releases
          // it when this connection closes. A failed RELEASE_LOCK
          // cannot wedge it permanently.
        } finally {
          conn.release();
        }
      },
    };
    return { acquired: true, lock };
  } catch (err) {
    if (held) {
      try {
        await conn.query(`SELECT RELEASE_LOCK(?) AS released`, [LOCK_NAME]);
      } catch {
        // Best-effort.
      }
    }
    conn.release();
    throw err;
  }
}

/**
 * Run `fn` while holding the ETL run lock.
 *
 * The lock is released and the connection returned to the pool when
 * `fn` settles, on both the success and the failure path.
 */
export async function withEtlRunLock<T>(
  pool: Pool,
  fn: (lock: EtlRunLock) => Promise<T>,
): Promise<T> {
  const guard = await acquireEtlRunLock(pool);
  if (!guard.acquired || !guard.lock) {
    throw new EtlRunLockedError(guard.reason ?? "an ETL run is already in progress");
  }
  try {
    return await fn(guard.lock);
  } finally {
    await guard.lock.release();
  }
}

/** Thrown when the ETL run lock could not be taken. */
export class EtlRunLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtlRunLockedError";
  }
}
