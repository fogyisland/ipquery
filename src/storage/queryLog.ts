// SPDX-License-Identifier: MIT
import type { Pool } from "mysql2/promise";
import type { QueryLogEntry } from "../types";
import { findRange, OPTIONAL_READ_LOCK_WAIT_SECONDS } from "./mysql";
import { formatDbTimestamp } from "./dbTimestamp";

export interface QueryLogInsertable {
  ip: Buffer;
  ipText: string;
  status: "hit" | "miss" | "invalid";
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
    const placeholders = slice
      .map((e) => {
        values.push(e.ip, e.ipText, e.status, e.userId, e.apiKeyId, e.sessionId, e.remoteAddr, e.userAgent);
        return "(?,?,?,?,?,?,?,?)";
      })
      .join(",");
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
  status?: "hit" | "miss" | "invalid";
  ipText?: string;
  startTime?: Date;
  endTime?: Date;
  sort?: { col: "id" | "ts"; dir: "asc" | "desc" };
}

/** The only columns `listQueryLogs` may order by. `col` and `dir` are
 *  interpolated into the ORDER BY clause, so the set is enforced here
 *  as well as in the TypeScript type — a caller that passes an
 *  unvalidated string must not be able to inject SQL. */
const SORT_COLUMNS = new Set(["id", "ts"]);

function resolveSortColumn(col: string): string {
  if (!SORT_COLUMNS.has(col)) {
    throw new Error(`listQueryLogs: unsupported sort column ${JSON.stringify(col)}`);
  }
  return col;
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
    status: r.status as "hit" | "miss" | "invalid",
    userId: r.user_id == null ? null : Number(r.user_id),
    apiKeyId: r.api_key_id == null ? null : Number(r.api_key_id),
    sessionId: r.session_id == null ? null : (r.session_id as string),
    remoteAddr: r.remote_addr == null ? null : (r.remote_addr as Buffer),
    userAgent: r.user_agent as string | null,
    userEmail: (r.user_email as string | null) ?? null,
    apiKeyPrefix: (r.api_key_prefix as string | null) ?? null,
  };
}

export async function listQueryLogs(
  pool: Pool,
  q: QueryLogQuery,
): Promise<{ rows: QueryLogRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.userId !== undefined) {
    where.push("q.user_id = ?");
    params.push(q.userId);
  }
  if (q.status) {
    where.push("q.status = ?");
    params.push(q.status);
  }
  if (q.ipText) {
    where.push("q.ip_text = ?");
    params.push(q.ipText);
  }
  if (q.startTime) {
    where.push("q.ts >= ?");
    params.push(q.startTime);
  }
  if (q.endTime) {
    where.push("q.ts <= ?");
    params.push(q.endTime);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderCol = q.sort ? resolveSortColumn(q.sort.col) : "id";
  const orderDir = q.sort?.dir === "asc" ? "ASC" : "DESC";

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
  const [totalRows] = await pool.query(`SELECT COUNT(*) AS c FROM query_log q ${whereSql}`, params);
  const arr = rows as Record<string, unknown>[];
  const totalArr = totalRows as Record<string, unknown>[];
  return {
    rows: arr.map(mapRow),
    total: Number((totalArr[0] as { c: number }).c),
  };
}

export async function countQueriesByStatusSince(
  pool: Pool,
  since: Date,
  opts?: { userId?: number },
): Promise<{
  hit: number;
  miss: number;
  invalid: number;
}> {
  const where: string[] = ["ts >= ?"];
  const params: unknown[] = [since];
  if (opts?.userId !== undefined) {
    where.push("user_id = ?");
    params.push(opts.userId);
  }
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) AS c FROM query_log WHERE ${where.join(" AND ")} GROUP BY status`,
    params,
  );
  const out = { hit: 0, miss: 0, invalid: 0 };
  for (const r of rows as Record<string, unknown>[]) {
    const k = r.status as "hit" | "miss" | "invalid";
    out[k] = Number(r.c);
  }
  return out;
}

// Per-day buckets for the dashboard 7-day chart. Returns oldest-first.
// Days with no rows still appear in the result (zeros) so the chart x-axis
// is always 7 ticks wide.
export interface DailyBucket {
  date: string; // YYYY-MM-DD in server local time
  hit: number;
  miss: number;
  invalid: number;
  total: number;
}

// Most-recent query for a user + the resolved country/ASN when status=hit.
export interface LastQuery {
  ipText: string;
  status: "hit" | "miss" | "invalid";
  ts: Date;
  countryCode: string | null;
  countryName: string | null;
  asnOrg: string | null;
}
// Fetch the user's most recent query_log row, plus the resolved
// country/ASN when status=hit.
//
// The row and the geography are fetched SEPARATELY, on purpose.
//
// The original version joined them:
//
//   FROM query_log q
//   LEFT JOIN ip_ranges r ON r.start_ip <= q.ip AND r.end_ip >= q.ip ...
//
// That put `ip_ranges` in the statement, so the statement needed a
// metadata lock on it. On 2026-11-23 a pending RENAME on that table
// made every /dashboard request queue behind it — the console's
// "show me my last query" page could not be served because it also
// asked for the country of the last IP.
//
// Splitting them makes the geography optional, which is what it always
// was. The row (IP, status, timestamp) is the content; the country and
// ASN are decoration. If the IP table is unavailable the row still
// renders and the decoration is simply absent — the template already
// hides those fields when they are missing.
//
// The second query also gets to be better than the join was. The join's
// predicate is `start_ip <= ip AND end_ip >= ip` — a range on both
// columns, which no single index serves, over 7.8M rows. The split
// version uses findRange(), which walks `uniq_start_end` backwards from
// the target and takes the 100 nearest candidates (~100ms measured).
export async function getLastUserQuery(pool: Pool, userId: number): Promise<LastQuery | null> {
  const [rows] = await pool.query(
    `SELECT ip_text AS ipText, status AS status, ts AS ts, ip AS ip
       FROM query_log
      WHERE user_id = ?
      ORDER BY ts DESC, id DESC
      LIMIT 1`,
    [userId],
  );
  const arr = rows as Record<string, unknown>[];
  if (arr.length === 0) return null;
  const r = arr[0]!;

  const base: LastQuery = {
    ipText: String(r.ipText ?? ""),
    status: r.status as "hit" | "miss" | "invalid",
    ts: r.ts as Date,
    countryCode: null,
    countryName: null,
    asnOrg: null,
  };

  // Only a HIT has a resolved location. A miss or an invalid IP has
  // nothing to look up, and asking would be a pointless query against
  // the locked table.
  if (base.status !== "hit") return base;

  const ipBuf = r.ip as Buffer | null;
  if (!ipBuf) return base;

  // The geography is best-effort. If the IP table is locked, timing
  // out, or missing the IP, the row still renders without it. The
  // failure is logged rather than swallowed, because "the country
  // column is empty" and "the IP table is locked" look identical from
  // the outside and only one of them needs attention.
  try {
    const range = await findRange(pool, ipBuf, {
      metadataLockWaitSeconds: OPTIONAL_READ_LOCK_WAIT_SECONDS,
    });
    if (!range) return base;
    return {
      ...base,
      countryCode: range.countryCode ?? null,
      countryName: range.countryName ?? null,
      asnOrg: range.asnOrg ?? null,
    };
  } catch (err) {
    console.warn(
      `[queryLog] could not resolve the location of the last query: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return base;
  }
}
export async function countQueriesByDay(pool: Pool, days: number): Promise<DailyBucket[]> {
  // Bucket in UTC end to end. `ts` is stamped by MySQL in the server's
  // own clock, and a day key has to be a UTC day, so the value is
  // converted out of the server's clock on the way to DATE(). The
  // `since` bound travels the other way — the driver writes the
  // parameter in the server's clock — so the comparison itself stays in
  // one clock and only the bucket label is UTC. Mixing the two shifted
  // every bucket by the server's offset from UTC.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(CONVERT_TZ(ts, @@session.time_zone, '+00:00'), '%Y-%m-%d') AS d, status, COUNT(*) AS c
       FROM query_log
       WHERE ts >= ?
       GROUP BY d, status
       ORDER BY d ASC`,
    [since],
  );
  const byDate = new Map<string, { hit: number; miss: number; invalid: number }>();
  for (const r of rows as Record<string, unknown>[]) {
    // The day label arrives as text on purpose. A DATE column read back
    // through the driver becomes a Date at local midnight, and
    // rendering that as an ISO date shifts the label by the driver's
    // offset — so the driver never gets to see it.
    const d = String(r.d);
    const cur = byDate.get(d) ?? { hit: 0, miss: 0, invalid: 0 };
    const k = r.status as "hit" | "miss" | "invalid";
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

export async function streamQueryLogsCsv(
  pool: Pool,
  q: QueryLogQuery,
  write: (chunk: string) => void,
): Promise<void> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.userId !== undefined) {
    where.push("q.user_id = ?");
    params.push(q.userId);
  }
  if (q.status) {
    where.push("q.status = ?");
    params.push(q.status);
  }
  if (q.ipText) {
    where.push("q.ip_text = ?");
    params.push(q.ipText);
  }
  if (q.startTime) {
    where.push("q.ts >= ?");
    params.push(q.startTime);
  }
  if (q.endTime) {
    where.push("q.ts <= ?");
    params.push(q.endTime);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  write("id,ts,ip_text,status,user_email,api_key_prefix,remote_addr,user_agent\n");
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
        formatDbTimestamp(r.ts as Date),
        JSON.stringify(r.ip_text),
        r.status,
        JSON.stringify(r.user_email ?? ""),
        JSON.stringify(r.api_key_prefix ?? ""),
        JSON.stringify(r.remote_hex ?? ""),
        JSON.stringify(r.user_agent ?? ""),
      ];
      write(cells.join(",") + "\n");
    }
  } finally {
    conn.release();
  }
}
