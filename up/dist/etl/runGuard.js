"use strict";
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
// ── Reclaiming an abandoned run ────────────────────────────────────────
//
// The row check has a failure mode of its own: a run whose process
// died leaves its row at status='running' with the lock already free,
// and every future run is then refused with "an ETL run is already in
// progress" — pointing at a run that ended days ago, with no way to
// clear it except a hand-written UPDATE.
//
// This happened for real on 2026-11-23: run #6 sat at status='running'
// with current_stage='swap' for 5.8 hours because its process was
// killed while the rename was blocked on a metadata lock. The next
// run was refused, the admin UI showed a run that had been "running"
// all day, and there was no button to clear it.
//
// closeStaleEtlRuns() closes that gap. A run is abandoned when it is
// BOTH old (past STALE_RUN_AFTER_MINUTES) AND unlocked (nobody holds
// the advisory lock). Both conditions are required: the lock check is
// what makes it safe, because a genuinely running run holds the lock
// even if it looks old; the age check is what keeps the two apart,
// because there is a window between the pipeline taking the lock and
// the guard looking for it.
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.EtlRunLockedError = exports.STALE_RUN_AFTER_MINUTES = void 0;
exports.findRunningEtlRun = findRunningEtlRun;
exports.closeStaleEtlRuns = closeStaleEtlRuns;
exports.acquireEtlRunLock = acquireEtlRunLock;
exports.withEtlRunLock = withEtlRunLock;
/**
 * The advisory lock name, scoped to one database.
 *
 * `GET_LOCK` is keyed by NAME alone — two connections to different
 * databases on the same server collide when the names match. The comment
 * here used to claim per-database scoping while the constant was a bare
 * string, so every IPQuery database on a MySQL server shared one lock:
 * a run against one library blocked a run against another, and the
 * integration suite deadlocked against itself whenever two files ran a
 * pipeline concurrently.
 *
 * The name therefore carries the database it protects. `DATABASE()` is
 * read through the same connection that will hold the lock, so the suffix
 * is always the schema this run is actually writing to.
 */
function lockNameFor(database) {
    return `ipquery:etl:run:${database}`;
}
/** Resolve the lock name for the database behind this connection. */
async function resolveLockName(conn) {
    const [rows] = await conn.query(`SELECT DATABASE() AS db`);
    const db = rows[0]?.db;
    if (typeof db !== "string" || db === "") {
        // No default schema on the connection means the pool was built
        // without one, and the ETL cannot run anyway. Fail loudly rather than
        // falling back to a shared name — that is the bug this replaced.
        throw new Error("cannot resolve the ETL lock name: the connection has no database selected");
    }
    return lockNameFor(db);
}
/** How long to wait for the advisory lock before giving up, in seconds.
 *  Zero: the ETL takes minutes, so a lock holder is legitimately busy
 *  for a long time. Every caller here wants a synchronous "no" it can
 *  surface as a flash message, not a multi-minute block. */
const LOCK_WAIT_SECONDS = 0;
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
async function findRunningEtlRun(pool, excludeRunId) {
    const [rows] = await pool.query(`SELECT id FROM etl_runs
      WHERE status = 'running' ${excludeRunId !== undefined ? "AND id <> ?" : ""}
      ORDER BY id DESC LIMIT 1`, excludeRunId !== undefined ? [excludeRunId] : []);
    if (rows.length === 0)
        return null;
    return Number(rows[0].id);
}
/**
 * How long a run may sit at status='running' before it is considered
 * abandoned, in minutes.
 *
 * A real run is not this long. The download stage alone measures in
 * minutes on a slow link (the 81.7 MB DB-IP city file took 451 s once),
 * and the insert stage inserts ~9.6M rows — the run that produced the
 * current library took 23 minutes end to end. Two hours leaves room for
 * a slow day and for the swap itself (which is bounded at 30 seconds
 * now, but was unbounded before that fix landed).
 *
 * The threshold exists because "no advisory lock holder" alone is not
 * enough to conclude "dead". There is a window between the pipeline
 * taking the lock and the guard checking for it, and a genuinely
 * running run must never be declared stale — closing one out would let
 * a second run start and race it on truncateNew + atomicSwapRanges.
 */
exports.STALE_RUN_AFTER_MINUTES = 120;
/**
 * Close out ETL runs that were abandoned by a dead process.
 *
 * A run is abandoned when BOTH:
 *
 *   - it is at status='running' and older than STALE_RUN_AFTER_MINUTES,
 *     and
 *   - no process holds the advisory lock for this database.
 *
 * The lock check is what makes this safe. The advisory lock is
 * released automatically when its session ends — including on a hard
 * crash — so a crashed run leaves the lock free and the ROW still
 * saying 'running'. The age check is what keeps the two facts apart:
 * a run that is old but still holding the lock is genuinely in flight
 * and must be left alone.
 *
 * Returns the number of runs closed out.
 */
async function closeStaleEtlRuns(pool) {
    const candidates = await findStaleRunCandidates(pool);
    if (candidates.length === 0)
        return 0;
    // Is anyone holding the lock right now? If so, a run is in flight
    // and none of the candidates may be closed — even the old-looking
    // ones.
    const conn = await pool.getConnection();
    try {
        const lockName = await resolveLockName(conn);
        const [rows] = await conn.query(`SELECT IS_FREE_LOCK(?) AS free`, [
            lockName,
        ]);
        // IS_FREE_LOCK returns 1 when nobody holds it, 0 when somebody does,
        // and NULL when the name does not exist.
        const isFree = rows[0]?.free;
        if (isFree !== null && Number(isFree) !== 1) {
            // A run holds the lock. Everything that looks stale is not.
            return 0;
        }
        const ids = candidates.map((c) => c.id);
        const placeholders = ids.map(() => "?").join(",");
        const [res] = await pool.query(`UPDATE etl_runs
          SET status = 'failed',
              finished_at = NOW(3),
              error_message = ?
        WHERE id IN (${placeholders})
          AND status = 'running'`, [
            `abandoned: the run had not progressed for over ${exports.STALE_RUN_AFTER_MINUTES} minutes and no process was holding the ETL lock — the row was closed out automatically`,
            ...ids,
        ]);
        const closed = Number(res.affectedRows ?? 0);
        if (closed > 0) {
            console.warn(`[etl] closed out ${closed} stale ETL run(s): ${ids.join(", ")} — ` +
                "no process was holding the ETL lock");
        }
        return closed;
    }
    finally {
        conn.release();
    }
}
/**
 * The ids of runs that are at status='running' and old enough to be
 * considered abandoned, newest first.
 */
async function findStaleRunCandidates(pool) {
    const [rows] = await pool.query(`SELECT id FROM etl_runs
      WHERE status = 'running'
        AND started_at < DATE_SUB(NOW(3), INTERVAL ? MINUTE)
      ORDER BY id DESC`, [exports.STALE_RUN_AFTER_MINUTES]);
    return rows.map((r) => ({ id: Number(r.id) }));
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
async function acquireEtlRunLock(pool, opts) {
    // Reclaim abandoned runs before refusing. A run whose process died
    // leaves its row at status='running' with the advisory lock already
    // free; without this the guard would refuse every future run and
    // point the operator at a run that ended days ago. closeStaleEtlRuns
    // only touches runs that are BOTH old AND unlocked, so a genuinely
    // running run is never reclaimed.
    await closeStaleEtlRuns(pool).catch((err) => {
        // Best-effort. If the reclaim fails, the run simply stays refused
        // — which is the safe direction: a false negative costs the
        // operator one manual UPDATE, a false positive lets two runs race.
        console.warn(`[etl] stale-run reclaim failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    // Cheap pre-check first: it avoids burning a pooled connection on the
    // common "an ETL really is running" path, and it gives the caller the
    // run id so the UI can link to the in-progress run.
    const runningRunId = await findRunningEtlRun(pool, opts?.excludeRunId);
    if (runningRunId !== null) {
        // The run survived the reclaim above, so it is either fresh or
        // still holding the lock — in both cases it is genuinely in
        // flight. `stale` stays false.
        return {
            acquired: false,
            reason: "an ETL run is already in progress",
            runningRunId,
            stale: false,
        };
    }
    const conn = await pool.getConnection();
    let held = false;
    // Resolved before the try so the catch block's best-effort release can
    // name the same lock. A failure here means there is nothing to release.
    const lockName = await resolveLockName(conn);
    try {
        const [rows] = await conn.query(`SELECT GET_LOCK(?, ?) AS acquired`, [lockName, LOCK_WAIT_SECONDS]);
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
            await conn.query(`SELECT RELEASE_LOCK(?) AS released`, [lockName]);
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
        const lock = {
            release: async () => {
                if (released)
                    return;
                released = true;
                try {
                    await conn.query(`SELECT RELEASE_LOCK(?) AS released`, [lockName]);
                }
                catch {
                    // Best-effort: the lock is session-scoped, so MySQL releases
                    // it when this connection closes. A failed RELEASE_LOCK
                    // cannot wedge it permanently.
                }
                finally {
                    conn.release();
                }
            },
        };
        return { acquired: true, lock };
    }
    catch (err) {
        if (held) {
            try {
                await conn.query(`SELECT RELEASE_LOCK(?) AS released`, [lockName]);
            }
            catch {
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
async function withEtlRunLock(pool, fn) {
    const guard = await acquireEtlRunLock(pool);
    if (!guard.acquired || !guard.lock) {
        throw new EtlRunLockedError(guard.reason ?? "an ETL run is already in progress");
    }
    try {
        return await fn(guard.lock);
    }
    finally {
        await guard.lock.release();
    }
}
/** Thrown when the ETL run lock could not be taken. */
class EtlRunLockedError extends Error {
    constructor(message) {
        super(message);
        this.name = "EtlRunLockedError";
    }
}
exports.EtlRunLockedError = EtlRunLockedError;
//# sourceMappingURL=runGuard.js.map