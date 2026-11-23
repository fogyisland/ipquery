"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getOverview = getOverview;
const auditLog_1 = require("../../storage/auditLog");
const queryLog_1 = require("../../storage/queryLog");
const rangeCount_1 = require("../../storage/rangeCount");
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
    // `ip_ranges` is NOT counted here. COUNT(*) on the 8.15M-row library takes
    // ~3.2s and this render used to pay it on every request — the whole page
    // took ~2.9s and the console re-rendered it every 30 seconds. The count
    // comes from storage/rangeCount, which reads a cached exact value (written
    // after every swap) or an index estimate, and never blocks on COUNT(*).
    //
    // The other four tables are small (hundreds to thousands of rows) and their
    // counts stay exact.
    // Two levels of unwrapping, and both are easy to get wrong without noticing:
    // `pool.query` resolves to `[rows, fields]`, and Promise.all therefore puts
    // that PAIR at position 0. `countsResult[0]` is the rows ARRAY; the row is
    // `countsResult[0][0]`. Mistaking one for the other throws nothing — every
    // field reads `undefined` and the template prints "NaN" in four tiles, which
    // is exactly what the first version of this function did.
    const [countsResult, ipRangeCount] = await Promise.all([
        pool.query(`
      SELECT
        (SELECT COUNT(*) FROM query_log) AS query_log_total,
        (SELECT COUNT(*) FROM users) AS users_total,
        (SELECT COUNT(*) FROM users WHERE email_verified = 1) AS users_verified,
        (SELECT COUNT(*) FROM users WHERE is_disabled = 1) AS users_disabled,
        (SELECT COUNT(*) FROM api_keys) AS keys_total,
        (SELECT COUNT(*) FROM api_keys WHERE revoked_at IS NULL) AS keys_active
    `),
        (0, rangeCount_1.getRangeCount)(pool),
    ]);
    const c = (countsResult[0]?.[0] ?? {});
    // Fan out the 24h split and the 7-day buckets in parallel — they hit
    // different aggregations on the same table, no shared intermediate.
    const [split, last7Days] = await Promise.all([
        (0, queryLog_1.countQueriesByStatusSince)(pool, since24h),
        (0, queryLog_1.countQueriesByDay)(pool, 7),
    ]);
    const total = split.hit + split.miss + split.invalid;
    const hitRate = total > 0 ? split.hit / total : 0;
    const { rows: recentActivity } = await (0, auditLog_1.listAuditLog)(pool, { offset: 0, limit: 20 });
    // Sum the chart's own buckets, so the number in the chart's subtitle and the
    // bars beneath it describe the same window. Keeping 24h and 7d separate is
    // deliberate: the three status tiles are a 24h view and the chart is a 7d
    // view, and mixing them made both numbers unreadable.
    const queries7d = last7Days.reduce((acc, bucket) => ({
        hit: acc.hit + bucket.hit,
        miss: acc.miss + bucket.miss,
        invalid: acc.invalid + bucket.invalid,
        total: acc.total + bucket.total,
        hitRate: 0,
    }), { hit: 0, miss: 0, invalid: 0, total: 0, hitRate: 0 });
    queries7d.hitRate = queries7d.total > 0 ? queries7d.hit / queries7d.total : 0;
    return {
        generatedAt: new Date(),
        etl: { lastRun, lastSuccessAt, runsToday },
        db: {
            ipRanges: ipRangeCount.value,
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
        queries7d,
        recentActivity,
    };
}
//# sourceMappingURL=overview.js.map