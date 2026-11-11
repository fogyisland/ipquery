import type { Pool } from "mysql2/promise";
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
    actor: {
        id: number;
        email: string;
    } | null;
    action: string;
    targetType?: string;
    targetId?: number | string;
    metadata?: Record<string, unknown> | null;
    ip?: string | null;
    userAgent?: string | null;
    statusCode?: number;
}
export declare function recordAuditLog(pool: Pool, input: AuditLogInput): Promise<void>;
export declare function listAuditLog(pool: Pool, opts: {
    offset: number;
    limit: number;
    actorUserId?: number;
    action?: string;
    targetType?: string;
    since?: Date;
    until?: Date;
    sort?: {
        col: "id" | "created_at";
        dir: "asc" | "desc";
    };
}): Promise<{
    rows: AuditLogEntry[];
    total: number;
}>;
