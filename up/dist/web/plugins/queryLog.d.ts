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
        /** The row(s) this request contributes to the query log.
         *
         *  A single lookup contributes one row. A batch contributes one row
         *  per address, because the log's job is to say which addresses were
         *  asked about — a batch of a hundred addresses that logged one row
         *  would understate the traffic by a factor of a hundred, and the
         *  "top addresses" page would be wrong. */
        pendingLog?: PendingLookup | PendingLookup[];
    }
}
export declare function registerQueryLogWriter(app: FastifyInstance, pool: Pool | (() => Pool), opts?: {
    flushIntervalMs?: number;
    maxBatch?: number;
}): {
    flush: () => Promise<void>;
};
