import type { FastifyInstance } from "fastify";
declare module "fastify" {
    interface FastifyInstance {
        requireSetup: boolean;
    }
}
export declare function registerInitGuard(app: FastifyInstance): Promise<void>;
