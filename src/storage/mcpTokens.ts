// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { McpToken, McpTokenScope, McpTokenStatus } from "../types";

/**
 * Storage for MCP tokens.
 *
 * An MCP token is a credential an AI client presents to the MCP server.
 * It differs from an api_key in two ways that matter:
 *
 *  1. It is not self-serve. The token starts as `pending` and only works
 *     once an administrator approves it, because the MCP tools expose
 *     operational data (query logs with user emails, queue depths, ETL
 *     status) that an api_key never reaches.
 *  2. It carries a scope. A `lookup` token may only call ipquery_lookup;
 *     an `ops` token may call every tool.
 *
 * Only the SHA-256 hash is stored. The plaintext is shown once, at
 * creation time, and cannot be recovered afterwards.
 */

function mapRow(r: RowDataPacket): McpToken {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    label: r.label as string,
    tokenPrefix: r.token_prefix as string,
    status: r.status as McpTokenStatus,
    scope: r.scope as McpTokenScope,
    requestedAt: r.requested_at as Date,
    decidedAt: r.decided_at as Date | null,
    decidedBy: r.decided_by === null || r.decided_by === undefined ? null : Number(r.decided_by),
    decisionNote: r.decision_note as string | null,
    lastUsedAt: r.last_used_at as Date | null,
    revokedAt: r.revoked_at as Date | null,
    createdAt: r.created_at as Date,
  };
}

export async function createMcpToken(
  pool: Pool,
  userId: number,
  label: string,
  tokenHash: string,
  tokenPrefix: string,
  scope: McpTokenScope,
): Promise<McpToken> {
  const [res] = await pool.query<ResultSetHeader>(
    `INSERT INTO mcp_tokens (user_id, label, token_hash, token_prefix, status, scope)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [userId, label, tokenHash, tokenPrefix, scope],
  );
  const token = await findMcpTokenById(pool, res.insertId);
  if (!token) throw new Error("mcp token vanished after insert");
  return token;
}

export async function findMcpTokenById(pool: Pool, id: number): Promise<McpToken | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM mcp_tokens WHERE id = ?`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Look up a token by hash for authentication. Only an `approved` token
 * that has not been revoked can authenticate — a pending, rejected or
 * revoked token returns null here, which is the single choke point that
 * keeps unapproved credentials out of the MCP server.
 */
export async function findApprovedMcpTokenByHash(
  pool: Pool,
  tokenHash: string,
): Promise<McpToken | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM mcp_tokens WHERE token_hash = ? AND status = 'approved' AND revoked_at IS NULL`,
    [tokenHash],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listMcpTokensForUser(pool: Pool, userId: number): Promise<McpToken[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM mcp_tokens WHERE user_id = ? ORDER BY id DESC`,
    [userId],
  );
  return rows.map(mapRow);
}

export interface ListMcpTokensOptions {
  offset: number;
  limit: number;
  status?: McpTokenStatus;
  scope?: McpTokenScope;
}

export async function listAllMcpTokens(
  pool: Pool,
  opts: ListMcpTokensOptions,
): Promise<{ rows: (McpToken & { ownerEmail: string })[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    where.push("t.status = ?");
    params.push(opts.status);
  }
  if (opts.scope) {
    where.push("t.scope = ?");
    params.push(opts.scope);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT t.*, u.email AS owner_email
       FROM mcp_tokens t JOIN users u ON u.id = t.user_id
       ${whereSql}
      ORDER BY FIELD(t.status, 'pending', 'approved', 'rejected', 'revoked'), t.id DESC
      LIMIT ? OFFSET ?`,
    [...params, opts.limit, opts.offset],
  );
  const [totalRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM mcp_tokens t ${whereSql}`,
    params,
  );
  return {
    rows: rows.map((r) => ({ ...mapRow(r), ownerEmail: r.owner_email as string })),
    total: Number((totalRows[0] as { c: number }).c),
  };
}

export async function countMcpTokensByStatus(pool: Pool): Promise<Record<McpTokenStatus, number>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT status, COUNT(*) AS c FROM mcp_tokens GROUP BY status`,
  );
  const counts: Record<McpTokenStatus, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
    revoked: 0,
  };
  for (const row of rows) {
    const status = row.status as McpTokenStatus;
    if (status in counts) counts[status] = Number(row.c);
  }
  return counts;
}

/**
 * Approve or reject a pending token. Returns the number of rows changed
 * so the caller can tell "I decided it" from "it was already decided" —
 * a token that was already approved must not be silently re-decided.
 */
export async function decideMcpToken(
  pool: Pool,
  id: number,
  decision: "approved" | "rejected",
  adminUserId: number,
  note: string | null,
): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(
    `UPDATE mcp_tokens
        SET status = ?, decided_at = NOW(3), decided_by = ?, decision_note = ?
      WHERE id = ? AND status = 'pending'`,
    [decision, adminUserId, note, id],
  );
  return res.affectedRows;
}

/** Withdraw an approved token. Already-revoked tokens are no-ops. */
export async function revokeMcpToken(pool: Pool, id: number): Promise<number> {
  const [res] = await pool.query<ResultSetHeader>(
    `UPDATE mcp_tokens SET status = 'revoked', revoked_at = NOW(3)
      WHERE id = ? AND status = 'approved'`,
    [id],
  );
  return res.affectedRows;
}

/** Bulk-revoke up to 100 approved tokens in one UPDATE.
 *  Returns the number of rows actually revoked. */
export async function revokeMcpTokensBulk(pool: Pool, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const capped = ids.slice(0, 100);
  const [res] = await pool.query<ResultSetHeader>(
    `UPDATE mcp_tokens SET status = 'revoked', revoked_at = NOW(3)
      WHERE id IN (?) AND status = 'approved'`,
    [capped],
  );
  return res.affectedRows;
}

/**
 * Throttle for `touchMcpToken`, mirroring the api_keys behaviour: the
 * dashboard shows when a token was last exercised, and a write on every
 * request buys nothing a reader can perceive.
 */
const TOUCH_THROTTLE_MS = 60_000;

const lastTouched = new Map<number, number>();

export async function touchMcpToken(pool: Pool, id: number): Promise<void> {
  const now = Date.now();
  const last = lastTouched.get(id);
  if (last !== undefined && now - last < TOUCH_THROTTLE_MS) return;
  // Record the intent BEFORE the write: if the write fails, the next
  // call retries rather than waiting out the interval.
  lastTouched.set(id, now);
  try {
    await pool.query(`UPDATE mcp_tokens SET last_used_at = NOW(3) WHERE id = ?`, [id]);
  } catch (err) {
    lastTouched.delete(id);
    throw err;
  }
}

/** Clear the throttle state. Test-only. */
export function _resetMcpTokenTouchThrottle(): void {
  lastTouched.clear();
}
