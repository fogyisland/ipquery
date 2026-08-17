// SPDX-License-Identifier: MIT
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { listAuditLog, type AuditLogEntry } from '../../storage/auditLog';

export interface Overview {
  generatedAt: Date;
  etl: {
    lastRun: { id: number; startedAt: Date; finishedAt: Date | null; status: string; mergedRecords: number } | null;
    lastSuccessAt: Date | null;
    runsToday: number;
  };
  db: {
    ipRanges: number;
    queryLogTotal: number;
    users: { total: number; verified: number; disabled: number };
    apiKeys: { total: number; active: number };
  };
  queries24h: { total: number; hitRate: number; trend: number[] };
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
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [etlRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, started_at, finished_at, status, merged_records FROM etl_runs ORDER BY id DESC LIMIT 1`,
  );
  const etlRow = etlRows[0];
  const lastRun = etlRow ? {
    id: Number(etlRow.id),
    startedAt: etlRow.started_at as Date,
    finishedAt: (etlRow.finished_at ?? null) as Date | null,
    status: etlRow.status as string,
    mergedRecords: Number(etlRow.merged_records ?? 0),
  } : null;

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

  // query_log column is `ts`, not `created_at` (see migration 008).
  const [q24] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS total,
            SUM(status='hit') AS hits
     FROM query_log WHERE ts >= ?`,
    [since],
  );
  const q24Row = q24[0] as { total: number; hits: number | null };
  const total = Number(q24Row.total);
  const hits = Number(q24Row.hits ?? 0);
  const hitRate = total > 0 ? hits / total : 0;

  const [trendRows] = await pool.query<RowDataPacket[]>(
    `SELECT HOUR(ts) AS h, COUNT(*) AS n
     FROM query_log WHERE ts >= ?
     GROUP BY HOUR(ts) ORDER BY h`,
    [since],
  );
  const trend = new Array(24).fill(0);
  for (const r of trendRows) trend[Number(r.h)] = Number(r.n);

  const { rows: recentActivity } = await listAuditLog(pool, { offset: 0, limit: 20 });

  return {
    generatedAt: new Date(),
    etl: { lastRun, lastSuccessAt, runsToday },
    db: {
      ipRanges: Number(c.ip_ranges),
      queryLogTotal: Number(c.query_log_total),
      users: { total: Number(c.users_total), verified: Number(c.users_verified), disabled: Number(c.users_disabled) },
      apiKeys: { total: Number(c.keys_total), active: Number(c.keys_active) },
    },
    queries24h: { total, hitRate, trend },
    recentActivity,
  };
}
