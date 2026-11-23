import type { Pool } from "mysql2/promise";
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
export declare function findRunningEtlRun(pool: Pool, excludeRunId?: number): Promise<number | null>;
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
export declare const STALE_RUN_AFTER_MINUTES = 120;
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
export declare function closeStaleEtlRuns(pool: Pool): Promise<number>;
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
export declare function acquireEtlRunLock(pool: Pool, opts?: {
    excludeRunId?: number;
}): Promise<EtlGuardResult & {
    lock?: EtlRunLock;
}>;
/**
 * Run `fn` while holding the ETL run lock.
 *
 * The lock is released and the connection returned to the pool when
 * `fn` settles, on both the success and the failure path.
 */
export declare function withEtlRunLock<T>(pool: Pool, fn: (lock: EtlRunLock) => Promise<T>): Promise<T>;
/** Thrown when the ETL run lock could not be taken. */
export declare class EtlRunLockedError extends Error {
    constructor(message: string);
}
