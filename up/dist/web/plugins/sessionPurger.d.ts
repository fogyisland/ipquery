import type { FastifyInstance } from "fastify";
import type { Pool } from "mysql2/promise";
export declare function registerSessionPurger(app: FastifyInstance, pool: Pool | (() => Pool), opts?: {
    intervalMs?: number;
}): {
    purgeNow: () => Promise<number>;
};
