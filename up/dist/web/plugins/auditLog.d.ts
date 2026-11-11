import type { FastifyInstance } from "fastify";
declare module "fastify" {
    interface FastifyRequest {
        auditAction?: {
            action: string;
            targetType?: string;
            targetId?: number | string;
            metadata?: Record<string, unknown>;
        };
    }
}
export declare function registerAuditLog(app: FastifyInstance): void;
