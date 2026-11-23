import type { FastifyInstance } from "fastify";
import type { Pool } from "mysql2/promise";
export declare function registerRangeCountRefresher(app: FastifyInstance, pool: Pool | (() => Pool), opts?: {
    intervalMs?: number;
}): {
    refreshNow: () => Promise<number | null>;
};
