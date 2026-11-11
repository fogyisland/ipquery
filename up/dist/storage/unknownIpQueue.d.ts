import type { Pool } from "mysql2/promise";
export interface UnknownIpRow {
    id: number;
    ip: Buffer;
    ipText: string;
    queryCount: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
    source: "auto_miss" | "manual_submit";
    submittedByUserId: number | null;
    processedAt: Date | null;
    mergedRunId: number | null;
    lastAttemptReason: string | null;
}
/** Increment-or-insert a miss for this IP. Always returns void — caller
 *  should not fail its primary response (the /lookup 404) on queue errors,
 *  so wrap in a try/catch upstream. */
export declare function insertOrIncrement(pool: Pool, ip: Buffer, ipText: string, opts?: {
    submittedByUserId?: number;
    source?: "auto_miss" | "manual_submit";
}): Promise<void>;
/** Return up to `limit` pending IPs that are NOT already covered by
 *  ip_ranges, highest-priority first (more misses, then more recent). */
export declare function nextBatch(pool: Pool, limit: number): Promise<UnknownIpRow[]>;
/** Mark a batch of queue rows as merged into ip_ranges under `runId`. */
export declare function markProcessed(pool: Pool, ids: number[], runId: number): Promise<void>;
/** Record that we tried these rows but couldn't merge them (e.g. no
 *  consensus). They stay pending; `last_attempt_reason` is informational
 *  for the admin view. */
export declare function markAttempted(pool: Pool, ids: number[], reason: string): Promise<void>;
/** Admin UI: show top-pending IPs sorted by pressure (query_count, then
 *  recency). Includes both pending and recent-processed for context. */
export declare function topByQueryCount(pool: Pool, limit: number): Promise<{
    pending: UnknownIpRow[];
    recentlyProcessed: UnknownIpRow[];
}>;
/** Snapshot counters for the dashboard tile. Cheap (single COUNT query). */
export declare function queueStats(pool: Pool): Promise<{
    pending: number;
    processed: number;
    totalQueries: number;
}>;
/** Wipe all PENDING queue rows. Used by the admin "clear queue" bulk
 *  action. Returns the count deleted so the route can flash a number
 *  back. We deliberately do NOT delete processed rows — those are the
 *  audit trail of past backfills. */
export declare function clearPending(pool: Pool): Promise<number>;
/** Render the pending queue as a CSV string for the "export failed IPs"
 *  button. Header row + one row per pending IP. IPs are in plain text
 *  (the admin already has DB access). */
export declare function exportPendingCsv(pool: Pool): Promise<string>;
