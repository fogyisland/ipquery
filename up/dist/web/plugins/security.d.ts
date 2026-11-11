import type { FastifyInstance } from "fastify";
export declare function registerSecurityHeaders(app: FastifyInstance, opts: {
    cookieSecure: boolean;
}): Promise<void>;
