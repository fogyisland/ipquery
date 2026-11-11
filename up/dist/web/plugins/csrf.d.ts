import type { FastifyInstance, FastifyRequest } from "fastify";
declare module "fastify" {
    interface FastifyRequest {
        csrfToken: string;
    }
}
export declare function registerCsrf(app: FastifyInstance): Promise<void>;
export declare function verifyCsrfRequest(req: FastifyRequest): boolean;
