// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { ApiKey } from "../types";

function mapRow(r: RowDataPacket): ApiKey {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    label: r.label as string,
    keyPrefix: r.key_prefix as string,
    lastUsedAt: r.last_used_at as Date | null,
    revokedAt: r.revoked_at as Date | null,
    createdAt: r.created_at as Date,
  };
}

export async function createApiKey(
  pool: Pool,
  userId: number,
  label: string,
  keyHash: string,
  keyPrefix: string,
): Promise<ApiKey> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO api_keys (user_id, label, key_hash, key_prefix) VALUES (?, ?, ?, ?)`,
    [userId, label, keyHash, keyPrefix],
  );
  const k = await findApiKeyById(pool, res.insertId);
  if (!k) throw new Error("api key vanished");
  return k;
}

export async function findApiKeyById(pool: Pool, id: number): Promise<ApiKey | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM api_keys WHERE id = ?`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findActiveApiKeyByHash(pool: Pool, keyHash: string): Promise<ApiKey | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
    [keyHash],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Throttle for `touchApiKey`.
 *
 * `last_used_at` exists so the dashboard can show when each key was
 * last exercised. Writing it on every request costs a DB round-trip
 * and a row lock per request, which is pure overhead: nobody can
 * perceive the difference between "used 3 seconds ago" and "used 30
 * seconds ago" on a dashboard.
 *
 * Each key is therefore stamped at most once per interval. The stamp
 * is written on the FIRST request after the interval expires, so the
 * value is never more than one interval stale.
 */
const TOUCH_THROTTLE_MS = 60_000;

/** keyId → the timestamp (epoch ms) of the last stamp we wrote. */
const lastTouched = new Map<number, number>();

export async function touchApiKey(pool: Pool, id: number): Promise<void> {
  const now = Date.now();
  const last = lastTouched.get(id);
  if (last !== undefined && now - last < TOUCH_THROTTLE_MS) return;
  // Record the intent BEFORE the write. If the write fails, the next
  // request retries rather than waiting out the interval — a failed
  // stamp must not suppress the next one.
  lastTouched.set(id, now);
  try {
    await pool.query(`UPDATE api_keys SET last_used_at = NOW(3) WHERE id = ?`, [id]);
  } catch (err) {
    lastTouched.delete(id);
    throw err;
  }
}

/**
 * Clear the throttle state. Test-only.
 */
export function _resetApiKeyTouchThrottle(): void {
  lastTouched.clear();
}

export async function revokeApiKey(pool: Pool, id: number): Promise<void> {
  await pool.query(`UPDATE api_keys SET revoked_at = NOW(3) WHERE id = ? AND revoked_at IS NULL`, [id]);
}

/** Bulk-revoke up to 100 keys in one UPDATE. Returns the number of rows
 *  actually revoked (already-revoked keys are no-ops and don't count).
 *  The caller caps the input length; we re-cap defensively in case the
 *  caller forgets. */
export async function revokeApiKeysBulk(pool: Pool, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const capped = ids.slice(0, 100);
  const [res] = await pool.query<ResultSetHeader>(
    `UPDATE api_keys SET revoked_at = NOW(3) WHERE id IN (?) AND revoked_at IS NULL`,
    [capped],
  );
  return res.affectedRows;
}

export async function listApiKeysForUser(pool: Pool, userId: number): Promise<ApiKey[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC`,
    [userId],
  );
  return rows.map(mapRow);
}

export async function listAllApiKeys(
  pool: Pool,
  opts: {
    offset: number;
    limit: number;
    userId?: number;
  },
): Promise<{ rows: (ApiKey & { ownerEmail: string })[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.userId) {
    where.push("k.user_id = ?");
    params.push(opts.userId);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT k.*, u.email AS owner_email FROM api_keys k JOIN users u ON u.id = k.user_id ${whereSql} ORDER BY k.id DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit, opts.offset],
  );
  const [totalRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM api_keys k ${whereSql}`,
    params,
  );
  return {
    rows: rows.map((r) => ({ ...mapRow(r), ownerEmail: r.owner_email as string })),
    total: Number((totalRows[0] as { c: number }).c),
  };
}

export async function countActiveApiKeys(pool: Pool): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM api_keys WHERE revoked_at IS NULL`,
  );
  return Number((rows[0] as { c: number }).c);
}
