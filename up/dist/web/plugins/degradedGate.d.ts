import type { FastifyInstance } from "fastify";
/**
 * Register the degraded-mode gate.
 *
 * Must be called BEFORE `registerSession` / `registerAuthGuards` /
 * `registerCsrf`, so that a degraded server answers 503 instead of
 * letting those hooks query a database that is not there.
 */
export declare function registerDegradedGate(app: FastifyInstance): void;
