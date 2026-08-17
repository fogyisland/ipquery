// SPDX-License-Identifier: MIT
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

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

export async function recordAuditLog(pool: Pool, input: AuditLogInput): Promise<void> {
  const actor = input.actor ?? { id: 0, email: '(system)' };
  await pool.query<ResultSetHeader>(
    `INSERT INTO admin_audit_log
       (actor_user_id, actor_email, action, target_type, target_id, metadata, ip, user_agent, status_code)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      actor.id, actor.email, input.action,
      input.targetType ?? null,
      input.targetId == null ? null : Number(input.targetId),
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.ip ?? null, input.userAgent ?? null, input.statusCode ?? null,
    ],
  );
}

export async function listAuditLog(pool: Pool, opts: {
  offset: number; limit: number;
  actorUserId?: number; action?: string; targetType?: string;
  since?: Date; until?: Date;
}): Promise<{ rows: AuditLogEntry[]; total: number }> {
  const where: string[] = []; const params: unknown[] = [];
  if (opts.actorUserId !== undefined) { where.push('actor_user_id = ?'); params.push(opts.actorUserId); }
  if (opts.action) { where.push('action = ?'); params.push(opts.action); }
  if (opts.targetType) { where.push('target_type = ?'); params.push(opts.targetType); }
  if (opts.since) { where.push('created_at >= ?'); params.push(opts.since); }
  if (opts.until) { where.push('created_at <= ?'); params.push(opts.until); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [totalRows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM admin_audit_log ${whereSql}`, params,
  );
  const total = Number((totalRows[0] as { c: number }).c);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM admin_audit_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit, opts.offset],
  );
  return {
    total,
    rows: rows.map((r) => ({
      id: Number(r.id), actor_user_id: Number(r.actor_user_id), actor_email: r.actor_email as string,
      action: r.action as string, target_type: (r.target_type ?? null) as string | null,
      target_id: r.target_id == null ? null : Number(r.target_id),
      metadata: r.metadata == null
        ? null
        : typeof r.metadata === 'string'
          ? JSON.parse(r.metadata)
          : (r.metadata as Record<string, unknown>),
      ip: (r.ip ?? null) as string | null, user_agent: (r.user_agent ?? null) as string | null,
      status_code: r.status_code == null ? null : Number(r.status_code),
      created_at: r.created_at as Date,
    })),
  };
}
