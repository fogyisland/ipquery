"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordAuditLog = recordAuditLog;
exports.listAuditLog = listAuditLog;
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
function normalizeTargetId(targetId) {
    if (targetId == null)
        return null;
    const numeric = Number(targetId);
    return Number.isFinite(numeric) ? numeric : null;
}
async function recordAuditLog(pool, input) {
    const actor = input.actor ?? { id: 0, email: "(system)" };
    const targetId = normalizeTargetId(input.targetId);
    const metadata = { ...(input.metadata ?? {}) };
    if (input.targetId != null && targetId === null) {
        // Non-numeric target (provider name, IP text): keep it readable.
        metadata.target = String(input.targetId);
    }
    await pool.query(`INSERT INTO admin_audit_log
       (actor_user_id, actor_email, action, target_type, target_id, metadata, ip, user_agent, status_code)
     VALUES (?,?,?,?,?,?,?,?,?)`, [
        actor.id,
        actor.email,
        input.action,
        input.targetType ?? null,
        targetId,
        Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
        input.ip ?? null,
        input.userAgent ?? null,
        input.statusCode ?? null,
    ]);
}
async function listAuditLog(pool, opts) {
    const where = [];
    const params = [];
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
    const [totalRows] = await pool.query(`SELECT COUNT(*) AS c FROM admin_audit_log ${whereSql}`, params);
    const total = Number(totalRows[0].c);
    const [rows] = await pool.query(`SELECT * FROM admin_audit_log ${whereSql} ORDER BY \`${sortCol}\` ${sortDir} LIMIT ? OFFSET ?`, [...params, opts.limit, opts.offset]);
    return {
        total,
        rows: rows.map((r) => ({
            id: Number(r.id),
            actor_user_id: Number(r.actor_user_id),
            actor_email: r.actor_email,
            action: r.action,
            target_type: (r.target_type ?? null),
            target_id: r.target_id == null ? null : Number(r.target_id),
            metadata: r.metadata == null
                ? null
                : typeof r.metadata === "string"
                    ? JSON.parse(r.metadata)
                    : r.metadata,
            ip: (r.ip ?? null),
            user_agent: (r.user_agent ?? null),
            status_code: r.status_code == null ? null : Number(r.status_code),
            created_at: r.created_at,
        })),
    };
}
//# sourceMappingURL=auditLog.js.map