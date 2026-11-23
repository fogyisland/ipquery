import type { Pool } from "mysql2/promise";
export interface QueryStats {
    range: {
        since: Date;
        until: Date;
    };
    total: number;
    byStatus: {
        hit: number;
        miss: number;
        invalid: number;
    };
    topIps: Array<{
        ip_text: string;
        n: number;
    }>;
    topUsers: Array<{
        user_email: string;
        n: number;
    }>;
    hourly: number[];
}
/**
 * Aggregates query_log stats over a time window. Mirrors the dashboard's
 * 24h hourly-bucketing pattern (see getOverview in src/web/admin/overview.ts).
 *
 * `hourly` is 24 buckets bucketed by hour-of-day over the since→until range.
 * Default window when no opts are supplied: last 24 hours.
 *
 * No upper-bound `ts <= until` predicate is applied. The window is taken
 * when the request starts, so a query logged while the page is being
 * rendered falls after `until` — and a strict upper bound would drop it
 * even though it is part of the traffic the page is reporting on. The
 * dashboard uses the same open-ended pattern (`WHERE ts >= ?`).
 */
export declare function getQueryStats(pool: Pool, opts?: {
    since?: Date;
    until?: Date;
}): Promise<QueryStats>;
