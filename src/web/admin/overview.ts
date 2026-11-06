// SPDX-License-Identifier: MIT
import type { Pool, RowDataPacket } from "mysql2/promise";
import { listAuditLog, type AuditLogEntry } from "../../storage/auditLog";
import { countQueriesByStatusSince, countQueriesByDay, type DailyBucket } from "../../storage/queryLog";

export interface Overview {
  generatedAt: Date;
  etl: {
    lastRun: {
      id: number;
      startedAt: Date;
      finishedAt: Date | null;
      status: string;
      mergedRecords: number;
    } | null;
    lastSuccessAt: Date | null;
    runsToday: number;
  };
  db: {
    ipRanges: number;
    queryLogTotal: number;
    users: { total: number; verified: number; disabled: number };
    apiKeys: { total: number; active: number };
  };
  // 24h hit/miss/invalid split + hit-rate. Drives the three status cards.
  queries24h: {
    hit: number;
    miss: number;
    invalid: number;
    total: number;
    hitRate: number;
  };
  // 7-day bucketed series for the dashboard bar chart. Oldest-first.
  last7Days: DailyBucket[];
  recentActivity: AuditLogEntry[];
}

interface OverviewCounts {
  ip_ranges: number;
  query_log_total: number;
  users_total: number;
  users_verified: number;
  users_disabled: number;
  keys_total: number;
  keys_active: number;
}

export async function getOverview(pool: Pool): Promise<Overview> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [etlRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, started_at, finished_at, status, merged_records FROM etl_runs ORDER BY id DESC LIMIT 1`,
  );
  const etlRow = etlRows[0];
  const lastRun = etlRow
    ? {
        id: Number(etlRow.id),
        startedAt: etlRow.started_at as Date,
        finishedAt: (etlRow.finished_at ?? null) as Date | null,
        status: etlRow.status as string,
        mergedRecords: Number(etlRow.merged_records ?? 0),
      }
    : null;

  const [successRows] = await pool.query<RowDataPacket[]>(
    `SELECT MAX(finished_at) AS last FROM etl_runs WHERE status = 'success' AND finished_at IS NOT NULL`,
  );
  const lastSuccessAt = (successRows[0]?.last ?? null) as Date | null;

  const [runsTodayRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM etl_runs WHERE started_at >= CURDATE()`,
  );
  const runsToday = Number((runsTodayRows[0] as { c: number }).c);

  const [counts] = await pool.query<RowDataPacket[]>(`
    SELECT
      (SELECT COUNT(*) FROM ip_ranges) AS ip_ranges,
      (SELECT COUNT(*) FROM query_log) AS query_log_total,
      (SELECT COUNT(*) FROM users) AS users_total,
      (SELECT COUNT(*) FROM users WHERE email_verified = 1) AS users_verified,
      (SELECT COUNT(*) FROM users WHERE is_disabled = 1) AS users_disabled,
      (SELECT COUNT(*) FROM api_keys) AS keys_total,
      (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL) AS keys_active
  `);
  const c = counts[0] as unknown as OverviewCounts;

  // Fan out the 24h split and the 7-day buckets in parallel — they hit
  // different aggregations on the same table, no shared intermediate.
  const [split, last7Days] = await Promise.all([
    countQueriesByStatusSince(pool, since24h),
    countQueriesByDay(pool, 7),
  ]);
  const total = split.hit + split.miss + split.invalid;
  const hitRate = total > 0 ? split.hit / total : 0;

  const { rows: recentActivity } = await listAuditLog(pool, { offset: 0, limit: 20 });

  return {
    generatedAt: new Date(),
    etl: { lastRun, lastSuccessAt, runsToday },
    db: {
      ipRanges: Number(c.ip_ranges),
      queryLogTotal: Number(c.query_log_total),
      users: {
        total: Number(c.users_total),
        verified: Number(c.users_verified),
        disabled: Number(c.users_disabled),
      },
      apiKeys: { total: Number(c.keys_total), active: Number(c.keys_active) },
    },
    queries24h: { ...split, total, hitRate },
    last7Days,
    recentActivity,
  };
}
