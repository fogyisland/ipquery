// SPDX-License-Identifier: MIT
//
// Queue of IPs the local DB couldn't resolve. /lookup writes here on miss;
// the admin backfill job drains it (calling external providers, applying
// majority vote, upserting to ip_ranges) and marks rows processed.
//
// Design notes:
// - `processed_at` is the source of truth for "drained". A row with
//   `processed_at IS NULL` is still pending, regardless of whether the
//   backfill tried it and gave up.
// - "Already covered by ip_ranges" is NOT persisted on this row. The
//   backfill filter (NOT EXISTS subquery) decides at read time. That's
//   intentional: a stale row from before a recent ETL merge shouldn't be
//   re-queued just because someone rebuilds ip_ranges.
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export interface UnknownIpRow {
  id: number;
  ip: Buffer;
  ipText: string;
  queryCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  source: 'auto_miss' | 'manual_submit';
  submittedByUserId: number | null;
  processedAt: Date | null;
  mergedRunId: number | null;
  lastAttemptReason: string | null;
}

interface QueueRow extends RowDataPacket {
  id: number;
  ip: Buffer;
  ip_text: string;
  query_count: number;
  first_seen_at: Date;
  last_seen_at: Date;
  source: 'auto_miss' | 'manual_submit';
  submitted_by_user_id: number | null;
  processed_at: Date | null;
  merged_run_id: number | null;
  last_attempt_reason: string | null;
}

function toRow(r: QueueRow): UnknownIpRow {
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
export async function insertOrIncrement(
  pool: Pool,
  ip: Buffer,
  ipText: string,
  opts: { submittedByUserId?: number; source?: 'auto_miss' | 'manual_submit' } = {},
): Promise<void> {
  const userId = opts.submittedByUserId ?? null;
  const source = opts.source ?? 'auto_miss';
  // When the row already exists we DO NOT overwrite submitted_by_user_id
  // — once a user manually submitted, manual wins. Likewise source stays
  // as 'auto_miss' unless this insert was manual itself.
  await pool.query<ResultSetHeader>(
    `INSERT INTO unknown_ip_queue (ip, ip_text, query_count, submitted_by_user_id, source)
     VALUES (?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE
       query_count = query_count + 1,
       last_seen_at = CURRENT_TIMESTAMP(3),
       submitted_by_user_id = COALESCE(submitted_by_user_id, VALUES(submitted_by_user_id)),
       source = IF(source = 'manual_submit', 'manual_submit', VALUES(source))`,
    [ip, ipText, userId, source],
  );
}

/** Return up to `limit` pending IPs that are NOT already covered by
 *  ip_ranges, highest-priority first (more misses, then more recent). */
export async function nextBatch(pool: Pool, limit: number): Promise<UnknownIpRow[]> {
  const [rows] = await pool.query<QueueRow[]>(
    `SELECT q.* FROM
    (
      SELECT * FROM unknown_ip_queue
      WHERE processed_at IS NULL
      ORDER BY query_count DESC, last_seen_at DESC
      LIMIT ?
    ) q
    LEFT JOIN ip_ranges r
      ON r.start_ip <= q.ip AND q.ip < r.end_ip
    WHERE r.id IS NULL
    LIMIT ?`,
    [limit * 3, limit],
    // ↑ Pull 3× so we still get `limit` candidates after the NOT EXISTS
    //   cull. Reasonable for typical queue-vs-ranges overlap (<<1%).
  );
  return rows.map(toRow);
}

/** Mark a batch of queue rows as merged into ip_ranges under `runId`. */
export async function markProcessed(
  pool: Pool,
  ids: number[],
  runId: number,
): Promise<void> {
  if (ids.length === 0) return;
  // Use chunked updates to keep the IN-list under MySQL's max packet size.
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    await pool.query<ResultSetHeader>(
      `UPDATE unknown_ip_queue
       SET processed_at = CURRENT_TIMESTAMP(3),
           merged_run_id = ?,
           last_attempt_reason = NULL
       WHERE id IN (${placeholders})`,
      [runId, ...slice],
    );
  }
}

/** Record that we tried these rows but couldn't merge them (e.g. no
 *  consensus). They stay pending; `last_attempt_reason` is informational
 *  for the admin view. */
export async function markAttempted(
  pool: Pool,
  ids: number[],
  reason: string,
): Promise<void> {
  if (ids.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    await pool.query<ResultSetHeader>(
      `UPDATE unknown_ip_queue
       SET last_attempt_reason = ?
       WHERE id IN (${placeholders}) AND processed_at IS NULL`,
      [reason, ...slice],
    );
  }
}

/** Admin UI: show top-pending IPs sorted by pressure (query_count, then
 *  recency). Includes both pending and recent-processed for context. */
export async function topByQueryCount(
  pool: Pool,
  limit: number,
): Promise<{ pending: UnknownIpRow[]; recentlyProcessed: UnknownIpRow[] }> {
  const [pendingRows] = await pool.query<QueueRow[]>(
    `SELECT * FROM unknown_ip_queue
     WHERE processed_at IS NULL
     ORDER BY query_count DESC, last_seen_at DESC
     LIMIT ?`,
    [limit],
  );
  const [processedRows] = await pool.query<QueueRow[]>(
    `SELECT * FROM unknown_ip_queue
     WHERE processed_at IS NOT NULL
     ORDER BY processed_at DESC
     LIMIT ?`,
    [limit],
  );
  return {
    pending: pendingRows.map(toRow),
    recentlyProcessed: processedRows.map(toRow),
  };
}

/** Snapshot counters for the dashboard tile. Cheap (single COUNT query). */
export async function queueStats(pool: Pool): Promise<{
  pending: number;
  processed: number;
  totalQueries: number;
}> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT
       SUM(IF(processed_at IS NULL, 1, 0)) AS pending,
       SUM(IF(processed_at IS NOT NULL, 1, 0)) AS processed,
       COALESCE(SUM(query_count), 0) AS total_queries
     FROM unknown_ip_queue`,
  );
  const r = rows[0] as { pending: number | null; processed: number | null; total_queries: number | string | null };
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
export async function clearPending(pool: Pool): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(
    `DELETE FROM unknown_ip_queue WHERE processed_at IS NULL`,
  );
  return res.affectedRows;
}

/** Render the pending queue as a CSV string for the "export failed IPs"
 *  button. Header row + one row per pending IP. IPs are in plain text
 *  (the admin already has DB access). */
export async function exportPendingCsv(pool: Pool): Promise<string> {
  const [rows] = await pool.query<QueueRow[]>(
    `SELECT ip_text, query_count, first_seen_at, last_seen_at,
            source, last_attempt_reason
       FROM unknown_ip_queue
       WHERE processed_at IS NULL
       ORDER BY query_count DESC, last_seen_at DESC`,
  );
  const lines: string[] = ['ip,query_count,first_seen_at,last_seen_at,source,last_attempt_reason'];
  for (const r of rows) {
    const esc = (s: string | number | null | Date) => {
      if (s == null) return '';
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
    ].join(','));
  }
  return lines.join('\n');
}