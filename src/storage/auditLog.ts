// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

export interface AuditLogEntry {
  id: number;
  actor_user_id: number;
  actor_email: string;
  action: string;
  target_type: string | null;
  target_id: number | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  status_code: number | null;
  created_at: Date;
}

export interface AuditLogInput {
  actor: { id: number; email: string } | null;
  action: string;
  targetType?: string;
  targetId?: number | string;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  statusCode?: number;
}

/**
 * Normalise `target_id` for the BIGINT column.
 *
 * `targetId` is typed `number | string` because callers audit both numeric
 * row ids (user id, api key id) and human-readable names (provider name,
 * an IP text). Only the numeric form fits the column: `Number("ip-api")`
 * is NaN, and mysql2 renders NaN as the literal `NaN`, which MySQL rejects
 * with ER_BAD_FIELD_ERROR ("Unknown column 'NaN' in 'field list'").
 *
 * So a non-numeric target becomes NULL here, and the readable value is kept
 * in `metadata.target` so the audit trail still says *what* was touched.
 */
function normalizeTargetId(targetId: number | string | undefined | null): number | null {
  if (targetId == null) return null;
  const numeric = Number(targetId);
  return Number.isFinite(numeric) ? numeric : null;
}

export async function recordAuditLog(pool: Pool, input: AuditLogInput): Promise<void> {
  const actor = input.actor ?? { id: 0, email: "(system)" };
  const targetId = normalizeTargetId(input.targetId);
  const metadata = { ...(input.metadata ?? {}) };
  if (input.targetId != null && targetId === null) {
    // Non-numeric target (provider name, IP text): keep it readable.
    metadata.target = String(input.targetId);
  }
  await pool.query<ResultSetHeader>(
    `INSERT INTO admin_audit_log
       (actor_user_id, actor_email, action, target_type, target_id, metadata, ip, user_agent, status_code)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      actor.id,
      actor.email,
      input.action,
      input.targetType ?? null,
      targetId,
      Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
      input.ip ?? null,
      input.userAgent ?? null,
      input.statusCode ?? null,
    ],
  );
}

export async function listAuditLog(
  pool: Pool,
  opts: {
    offset: number;
    limit: number;
    actorUserId?: number;
    action?: string;
    targetType?: string;
    since?: Date;
    until?: Date;
    sort?: { col: "id" | "created_at"; dir: "asc" | "desc" };
  },
): Promise<{ rows: AuditLogEntry[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.actorUserId !== undefined) {
    where.push("actor_user_id = ?");
    params.push(opts.actorUserId);
  }
  if (opts.action) {
    where.push("action = ?");
    params.push(opts.action);
  }
  if (opts.targetType) {
    where.push("target_type = ?");
    params.push(opts.targetType);
  }
  if (opts.since) {
    where.push("created_at >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    where.push("created_at <= ?");
    params.push(opts.until);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // Whitelist sort col/dir; fall back to id DESC for backward compatibility.
  const sortCol = opts.sort?.col === "created_at" ? "created_at" : "id";
  const sortDir = opts.sort?.dir === "asc" ? "ASC" : "DESC";

  const [totalRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM admin_audit_log ${whereSql}`,
    params,
  );
  const total = Number((totalRows[0] as { c: number }).c);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM admin_audit_log ${whereSql} ORDER BY \`${sortCol}\` ${sortDir} LIMIT ? OFFSET ?`,
    [...params, opts.limit, opts.offset],
  );
  return {
    total,
    rows: rows.map((r) => ({
      id: Number(r.id),
      actor_user_id: Number(r.actor_user_id),
      actor_email: r.actor_email as string,
      action: r.action as string,
      target_type: (r.target_type ?? null) as string | null,
      target_id: r.target_id == null ? null : Number(r.target_id),
      metadata:
        r.metadata == null
          ? null
          : typeof r.metadata === "string"
            ? JSON.parse(r.metadata)
            : (r.metadata as Record<string, unknown>),
      ip: (r.ip ?? null) as string | null,
      user_agent: (r.user_agent ?? null) as string | null,
      status_code: r.status_code == null ? null : Number(r.status_code),
      created_at: r.created_at as Date,
    })),
  };
}
