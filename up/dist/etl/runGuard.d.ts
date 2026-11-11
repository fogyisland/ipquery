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
