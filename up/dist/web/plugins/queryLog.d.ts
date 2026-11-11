import type { FastifyInstance } from "fastify";
import type { Pool } from "mysql2/promise";
export interface PendingLookup {
    ip: Buffer;
    ipText: string;
    status: "hit" | "miss" | "invalid";
    userId: number | null;
    apiKeyId: number | null;
    sessionId: string | null;
    remoteAddr: Buffer | null;
    userAgent: string | null;
}
declare module "fastify" {
    interface FastifyRequest {
        pendingLog?: PendingLookup;
    }
}
export declare function registerQueryLogWriter(app: FastifyInstance, pool: Pool, opts?: {
    flushIntervalMs?: number;
    maxBatch?: number;
}): {
    flush: () => Promise<void>;
};
