"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertOrIncrement = insertOrIncrement;
exports.nextBatch = nextBatch;
exports.markProcessed = markProcessed;
exports.markAttempted = markAttempted;
exports.topByQueryCount = topByQueryCount;
exports.queueStats = queueStats;
exports.clearPending = clearPending;
exports.exportPendingCsv = exportPendingCsv;
function toRow(r) {
    return {
        id: Number(r.id),
        ip: r.ip,
        ipText: r.ip_text,
        queryCount: Number(r.query_count),
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        source: r.source,
        submittedByUserId: r.submitted_by_user_id == null ? null : Number(r.submitted_by_user_id),
        processedAt: r.processed_at,
        mergedRunId: r.merged_run_id == null ? null : Number(r.merged_run_id),
        lastAttemptReason: r.last_attempt_reason,
    };
}
/** Increment-or-insert a miss for this IP. Always returns void — caller
 *  should not fail its primary response (the /lookup 404) on queue errors,
 *  so wrap in a try/catch upstream. */
async function insertOrIncrement(pool, ip, ipText, opts = {}) {
    const userId = opts.submittedByUserId ?? null;
    const source = opts.source ?? "auto_miss";
    // When the row already exists we DO NOT overwrite submitted_by_user_id
    // — once a user manually submitted, manual wins. Likewise source stays
    // as 'auto_miss' unless this insert was manual itself.
    await pool.query(`INSERT INTO unknown_ip_queue (ip, ip_text, query_count, submitted_by_user_id, source)
     VALUES (?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE
       query_count = query_count + 1,
       last_seen_at = CURRENT_TIMESTAMP(3),
       submitted_by_user_id = COALESCE(submitted_by_user_id, VALUES(submitted_by_user_id)),
       source = IF(source = 'manual_submit', 'manual_submit', VALUES(source))`, [ip, ipText, userId, source]);
}
/** Return up to `limit` pending IPs that are NOT already covered by
 *  ip_ranges, highest-priority first (more misses, then more recent). */
async function nextBatch(pool, limit) {
    const [rows] = await pool.query(`SELECT q.* FROM
    (
      SELECT * FROM unknown_ip_queue
      WHERE processed_at IS NULL
      ORDER BY query_count DESC, last_seen_at DESC
      LIMIT ?
    ) q
    LEFT JOIN ip_ranges r
      ON r.start_ip <= q.ip AND q.ip < r.end_ip
    WHERE r.id IS NULL
    LIMIT ?`, [limit * 3, limit]);
    return rows.map(toRow);
}
/** Mark a batch of queue rows as merged into ip_ranges under `runId`. */
async function markProcessed(pool, ids, runId) {
    if (ids.length === 0)
        return;
    // Use chunked updates to keep the IN-list under MySQL's max packet size.
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const placeholders = slice.map(() => "?").join(",");
        await pool.query(`UPDATE unknown_ip_queue
       SET processed_at = CURRENT_TIMESTAMP(3),
           merged_run_id = ?,
           last_attempt_reason = NULL
       WHERE id IN (${placeholders})`, [runId, ...slice]);
    }
}
/** Record that we tried these rows but couldn't merge them (e.g. no
 *  consensus). They stay pending; `last_attempt_reason` is informational
 *  for the admin view. */
async function markAttempted(pool, ids, reason) {
    if (ids.length === 0)
        return;
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const placeholders = slice.map(() => "?").join(",");
        await pool.query(`UPDATE unknown_ip_queue
       SET last_attempt_reason = ?
       WHERE id IN (${placeholders}) AND processed_at IS NULL`, [reason, ...slice]);
    }
}
/** Admin UI: show top-pending IPs sorted by pressure (query_count, then
 *  recency). Includes both pending and recent-processed for context. */
async function topByQueryCount(pool, limit) {
    const [pendingRows] = await pool.query(`SELECT * FROM unknown_ip_queue
     WHERE processed_at IS NULL
     ORDER BY query_count DESC, last_seen_at DESC
     LIMIT ?`, [limit]);
    const [processedRows] = await pool.query(`SELECT * FROM unknown_ip_queue
     WHERE processed_at IS NOT NULL
     ORDER BY processed_at DESC
     LIMIT ?`, [limit]);
    return {
        pending: pendingRows.map(toRow),
        recentlyProcessed: processedRows.map(toRow),
    };
}
/** Snapshot counters for the dashboard tile. Cheap (single COUNT query). */
async function queueStats(pool) {
    const [rows] = await pool.query(`SELECT
       SUM(IF(processed_at IS NULL, 1, 0)) AS pending,
       SUM(IF(processed_at IS NOT NULL, 1, 0)) AS processed,
       COALESCE(SUM(query_count), 0) AS total_queries
     FROM unknown_ip_queue`);
    const r = rows[0];
    return {
        pending: Number(r.pending ?? 0),
        processed: Number(r.processed ?? 0),
        totalQueries: Number(r.total_queries ?? 0),
    };
}
/** Wipe all PENDING queue rows. Used by the admin "clear queue" bulk
 *  action. Returns the count deleted so the route can flash a number
 *  back. We deliberately do NOT delete processed rows — those are the
 *  audit trail of past backfills. */
async function clearPending(pool) {
    const [res] = await pool.query(`DELETE FROM unknown_ip_queue WHERE processed_at IS NULL`);
    return res.affectedRows;
}
/** Render the pending queue as a CSV string for the "export failed IPs"
 *  button. Header row + one row per pending IP. IPs are in plain text
 *  (the admin already has DB access). */
async function exportPendingCsv(pool) {
    const [rows] = await pool.query(`SELECT ip_text, query_count, first_seen_at, last_seen_at,
            source, last_attempt_reason
       FROM unknown_ip_queue
       WHERE processed_at IS NULL
       ORDER BY query_count DESC, last_seen_at DESC`);
    const lines = ["ip,query_count,first_seen_at,last_seen_at,source,last_attempt_reason"];
    for (const r of rows) {
        const esc = (s) => {
            if (s == null)
                return "";
            const v = s instanceof Date ? s.toISOString() : String(s);
            // Quote if it contains comma / quote / newline.
            return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        };
        lines.push([
            esc(r.ip_text),
            esc(r.query_count),
            esc(r.first_seen_at),
            esc(r.last_seen_at),
            esc(r.source),
            esc(r.last_attempt_reason),
        ].join(","));
    }
    return lines.join("\n");
}
//# sourceMappingURL=unknownIpQueue.js.map