"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOverview = getOverview;
const auditLog_1 = require("../../storage/auditLog");
const queryLog_1 = require("../../storage/queryLog");
async function getOverview(pool) {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [etlRows] = await pool.query(`SELECT id, started_at, finished_at, status, merged_records FROM etl_runs ORDER BY id DESC LIMIT 1`);
    const etlRow = etlRows[0];
    const lastRun = etlRow
        ? {
            id: Number(etlRow.id),
            startedAt: etlRow.started_at,
            finishedAt: (etlRow.finished_at ?? null),
            status: etlRow.status,
            mergedRecords: Number(etlRow.merged_records ?? 0),
        }
        : null;
    const [successRows] = await pool.query(`SELECT MAX(finished_at) AS last FROM etl_runs WHERE status = 'success' AND finished_at IS NOT NULL`);
    const lastSuccessAt = (successRows[0]?.last ?? null);
    const [runsTodayRows] = await pool.query(`SELECT COUNT(*) AS c FROM etl_runs WHERE started_at >= CURDATE()`);
    const runsToday = Number(runsTodayRows[0].c);
    const [counts] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM ip_ranges) AS ip_ranges,
      (SELECT COUNT(*) FROM query_log) AS query_log_total,
      (SELECT COUNT(*) FROM users) AS users_total,
      (SELECT COUNT(*) FROM users WHERE email_verified = 1) AS users_verified,
      (SELECT COUNT(*) FROM users WHERE is_disabled = 1) AS users_disabled,
      (SELECT COUNT(*) FROM api_keys) AS keys_total,
      (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL) AS keys_active
  `);
    const c = counts[0];
    // Fan out the 24h split and the 7-day buckets in parallel — they hit
    // different aggregations on the same table, no shared intermediate.
    const [split, last7Days] = await Promise.all([
        (0, queryLog_1.countQueriesByStatusSince)(pool, since24h),
        (0, queryLog_1.countQueriesByDay)(pool, 7),
    ]);
    const total = split.hit + split.miss + split.invalid;
    const hitRate = total > 0 ? split.hit / total : 0;
    const { rows: recentActivity } = await (0, auditLog_1.listAuditLog)(pool, { offset: 0, limit: 20 });
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
//# sourceMappingURL=overview.js.map