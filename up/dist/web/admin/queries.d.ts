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
 * No upper-bound `ts <= until` predicate is applied because the MySQL server's
 * CURRENT_TIMESTAMP runs ahead of Node's Date.now() in this environment
 * (server tz is +08:00 but the connection sets `timezone: 'Z'`); a strict
 * `<= now()` predicate would falsely exclude rows just written. The dashboard
 * uses the same open-ended pattern (`WHERE ts >= ?`).
 */
export declare function getQueryStats(pool: Pool, opts?: {
    since?: Date;
    until?: Date;
}): Promise<QueryStats>;
