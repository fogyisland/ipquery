import type { FastifyInstance } from "fastify";
import type { Pool } from "mysql2/promise";
export declare function registerUploadSweeper(app: FastifyInstance, pool: Pool | (() => Pool), opts?: {
    intervalMs?: number;
}): {
    sweepNow: () => Promise<number>;
};
