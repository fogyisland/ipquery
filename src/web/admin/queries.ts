// SPDX-License-Identifier: MIT
import type { Pool, RowDataPacket } from 'mysql2/promise';

export interface QueryStats {
  range: { since: Date; until: Date };
  total: number;
  byStatus: { hit: number; miss: number; invalid: number };
  topIps: Array<{ ip_text: string; n: number }>;          // 10
  topUsers: Array<{ user_email: string; n: number }>;    // 10
  hourly: number[];                                       // 24 buckets
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
export async function getQueryStats(pool: Pool, opts: {
  since?: Date;
  until?: Date;
} = {}): Promise<QueryStats> {
  const until = opts.until ?? new Date();
  const since = opts.since ?? new Date(until.getTime() - 24 * 60 * 60 * 1000);

  // Single batched statement: byStatus counts. topIps / topUsers / hourly
  // use separate queries because their GROUP BY shapes differ.
  const [agg] = await pool.query<RowDataPacket[]>(`
    SELECT
      (SELECT COUNT(*) FROM query_log WHERE ts >= ?) AS total,
      (SELECT COUNT(*) FROM query_log WHERE ts >= ? AND status = 'hit') AS hit,
      (SELECT COUNT(*) FROM query_log WHERE ts >= ? AND status = 'miss') AS miss,
      (SELECT COUNT(*) FROM query_log WHERE ts >= ? AND status = 'invalid') AS invalid
  `, [since, since, since, since]);
  const a = agg[0] as { total: number; hit: number; miss: number; invalid: number };

  const [topIpRows] = await pool.query<RowDataPacket[]>(
    `SELECT ip_text, COUNT(*) AS n FROM query_log
       WHERE ts >= ?
       GROUP BY ip_text ORDER BY n DESC, ip_text ASC LIMIT 10`,
    [since],
  );

  const [topUserRows] = await pool.query<RowDataPacket[]>(
    `SELECT COALESCE(u.email, '(anonymous)') AS user_email, COUNT(*) AS n
       FROM query_log q
       LEFT JOIN users u ON u.id = q.user_id
       WHERE q.ts >= ?
       GROUP BY user_email ORDER BY n DESC, user_email ASC LIMIT 10`,
    [since],
  );

  // 24 buckets bucketed by hour-of-day over the range. The dashboard's
  // 24h trend uses the same pattern.
  const [hourlyRows] = await pool.query<RowDataPacket[]>(
    `SELECT HOUR(ts) AS h, COUNT(*) AS n
       FROM query_log WHERE ts >= ?
       GROUP BY HOUR(ts) ORDER BY h`,
    [since],
  );
  const hourly = new Array(24).fill(0);
  for (const r of hourlyRows) hourly[Number(r.h)] = Number(r.n);

  return {
    range: { since, until },
    total: Number(a.total ?? 0),
    byStatus: { hit: Number(a.hit ?? 0), miss: Number(a.miss ?? 0), invalid: Number(a.invalid ?? 0) },
    topIps: topIpRows.map((r) => ({ ip_text: String(r.ip_text), n: Number(r.n) })),
    topUsers: topUserRows.map((r) => ({ user_email: String(r.user_email), n: Number(r.n) })),
    hourly,
  };
}
