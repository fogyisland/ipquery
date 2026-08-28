// SPDX-License-Identifier: MIT
import type { Pool } from 'mysql2/promise';
import type { QueryLogEntry } from '../types';

export interface QueryLogInsertable {
  ip: Buffer;
  ipText: string;
  status: 'hit' | 'miss' | 'invalid';
  userId: number | null;
  apiKeyId: number | null;
  sessionId: string | null;
  remoteAddr: Buffer | null;
  userAgent: string | null;
}

export async function insertQueryLogs(pool: Pool, entries: QueryLogInsertable[]): Promise<void> {
  if (entries.length === 0) return;
  const CHUNK = 200;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const placeholders = slice.map((e) => {
      values.push(
        e.ip, e.ipText, e.status,
        e.userId, e.apiKeyId, e.sessionId, e.remoteAddr, e.userAgent,
      );
      return '(?,?,?,?,?,?,?,?)';
    }).join(',');
    await pool.query(
      `INSERT INTO query_log (ip, ip_text, status, user_id, api_key_id, session_id, remote_addr, user_agent) VALUES ${placeholders}`,
      values,
    );
  }
}

export interface QueryLogQuery {
  offset: number;
  limit: number;
  userId?: number;
  status?: 'hit' | 'miss' | 'invalid';
  ipText?: string;
  startTime?: Date;
  endTime?: Date;
  sort?: { col: 'id' | 'ts'; dir: 'asc' | 'desc' };
}

export interface QueryLogRow extends QueryLogEntry {
  id: number;
  userEmail?: string | null;
  apiKeyPrefix?: string | null;
}

function mapRow(r: Record<string, unknown>): QueryLogRow {
  return {
    id: Number(r.id),
    ts: r.ts as Date,
    ip: r.ip as Buffer,
    ipText: r.ip_text as string,
    status: r.status as 'hit' | 'miss' | 'invalid',
    userId: r.user_id == null ? null : Number(r.user_id),
    apiKeyId: r.api_key_id == null ? null : Number(r.api_key_id),
    sessionId: r.session_id == null ? null : (r.session_id as string),
    remoteAddr: r.remote_addr == null ? null : (r.remote_addr as Buffer),
    userAgent: r.user_agent as string | null,
    userEmail: (r.user_email as string | null) ?? null,
    apiKeyPrefix: (r.api_key_prefix as string | null) ?? null,
  };
}

export async function listQueryLogs(pool: Pool, q: QueryLogQuery): Promise<{ rows: QueryLogRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.userId !== undefined) { where.push('q.user_id = ?'); params.push(q.userId); }
  if (q.status) { where.push('q.status = ?'); params.push(q.status); }
  if (q.ipText) { where.push('q.ip_text = ?'); params.push(q.ipText); }
  if (q.startTime) { where.push('q.ts >= ?'); params.push(q.startTime); }
  if (q.endTime) { where.push('q.ts <= ?'); params.push(q.endTime); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderCol = q.sort?.col ?? 'id';
  const orderDir = q.sort?.dir === 'asc' ? 'ASC' : 'DESC';

  const [rows] = await pool.query(
    `SELECT q.*, u.email AS user_email, k.key_prefix AS api_key_prefix
       FROM query_log q
       LEFT JOIN users u ON u.id = q.user_id
       LEFT JOIN api_keys k ON k.id = q.api_key_id
       ${whereSql}
       ORDER BY q.${orderCol} ${orderDir}
       LIMIT ? OFFSET ?`,
    [...params, q.limit, q.offset],
  );
  const [totalRows] = await pool.query(
    `SELECT COUNT(*) AS c FROM query_log q ${whereSql}`, params,
  );
  const arr = rows as Record<string, unknown>[];
  const totalArr = totalRows as Record<string, unknown>[];
  return {
    rows: arr.map(mapRow),
    total: Number((totalArr[0] as { c: number }).c),
  };
}

export async function countQueriesByStatusSince(
  pool: Pool, since: Date, opts?: { userId?: number },
): Promise<{
  hit: number; miss: number; invalid: number;
}> {
  const where: string[] = ['ts >= ?'];
  const params: unknown[] = [since];
  if (opts?.userId !== undefined) {
    where.push('user_id = ?');
    params.push(opts.userId);
  }
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) AS c FROM query_log WHERE ${where.join(' AND ')} GROUP BY status`,
    params,
  );
  const out = { hit: 0, miss: 0, invalid: 0 };
  for (const r of rows as Record<string, unknown>[]) {
    const k = r.status as 'hit' | 'miss' | 'invalid';
    out[k] = Number(r.c);
  }
  return out;
}

// Per-day buckets for the dashboard 7-day chart. Returns oldest-first.
// Days with no rows still appear in the result (zeros) so the chart x-axis
// is always 7 ticks wide.
export interface DailyBucket {
  date: string;       // YYYY-MM-DD in server local time
  hit: number;
  miss: number;
  invalid: number;
  total: number;
}
export async function countQueriesByDay(pool: Pool, days: number): Promise<DailyBucket[]> {
  const since = new Date(Date.now() - (days - 1) * 86_400_000);
  since.setHours(0, 0, 0, 0);
  const [rows] = await pool.query(
    `SELECT DATE(ts) AS d, status, COUNT(*) AS c
       FROM query_log
       WHERE ts >= ?
       GROUP BY DATE(ts), status
       ORDER BY d ASC`,
    [since],
  );
  const byDate = new Map<string, { hit: number; miss: number; invalid: number }>();
  for (const r of rows as Record<string, unknown>[]) {
    const d = r.d instanceof Date ? (r.d as Date).toISOString().slice(0, 10) : String(r.d);
    const cur = byDate.get(d) ?? { hit: 0, miss: 0, invalid: 0 };
    const k = r.status as 'hit' | 'miss' | 'invalid';
    cur[k] = Number(r.c);
    byDate.set(d, cur);
  }
  const out: DailyBucket[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    const c = byDate.get(key) ?? { hit: 0, miss: 0, invalid: 0 };
    out.push({ date: key, ...c, total: c.hit + c.miss + c.invalid });
  }
  return out;
}

export async function streamQueryLogsCsv(pool: Pool, q: QueryLogQuery, write: (chunk: string) => void): Promise<void> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.userId !== undefined) { where.push('q.user_id = ?'); params.push(q.userId); }
  if (q.status) { where.push('q.status = ?'); params.push(q.status); }
  if (q.ipText) { where.push('q.ip_text = ?'); params.push(q.ipText); }
  if (q.startTime) { where.push('q.ts >= ?'); params.push(q.startTime); }
  if (q.endTime) { where.push('q.ts <= ?'); params.push(q.endTime); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  write('id,ts,ip_text,status,user_email,api_key_prefix,remote_addr,user_agent\n');
  const conn = await pool.getConnection();
  try {
    const [stream] = await conn.query(
      `SELECT q.id, q.ts, q.ip_text, q.status, u.email AS user_email, k.key_prefix AS api_key_prefix,
              HEX(q.remote_addr) AS remote_hex, q.user_agent
         FROM query_log q
         LEFT JOIN users u ON u.id = q.user_id
         LEFT JOIN api_keys k ON k.id = q.api_key_id
         ${whereSql}
         ORDER BY q.id ASC`,
      params,
    );
    const rows = stream as Record<string, unknown>[];
    for (const r of rows) {
      const cells = [
        r.id,
        (r.ts as Date).toISOString(),
        JSON.stringify(r.ip_text),
        r.status,
        JSON.stringify(r.user_email ?? ''),
        JSON.stringify(r.api_key_prefix ?? ''),
        JSON.stringify(r.remote_hex ?? ''),
        JSON.stringify(r.user_agent ?? ''),
      ];
      write(cells.join(',') + '\n');
    }
  } finally {
    conn.release();
  }
}
