import type { FastifyInstance } from "fastify";
export declare function registerView(app: FastifyInstance, cfg: {
    baseUrl: string;
}): Promise<void>;
declare module "fastify" {
    interface FastifyInstance {
        viewBaseUrl: string;
    }
}
