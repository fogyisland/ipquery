import type { FastifyInstance } from "fastify";
declare module "fastify" {
    interface FastifyInstance {
        /**
         * Arm the ETL schedule. Idempotent — calling it twice does not create
         * two timers.
         */
        startEtlScheduler: () => void;
        /**
         * Disarm the ETL schedule. Used when the database goes away.
         */
        stopEtlScheduler: () => void;
    }
}
/**
 * Register the ETL scheduler.
 *
 * The scheduler is NOT started here. The caller decides when it is
 * appropriate — `buildServer` starts it once the migrations have run
 * (i.e. the database is real), and the setup wizard starts it after it
 * has re-pointed the pool at a working database.
 */
export declare function registerEtlScheduler(app: FastifyInstance): void;
