import type { FastifyInstance, FastifyRequest } from "fastify";
declare module "fastify" {
    interface FastifyRequest {
        csrfToken: string;
    }
}
export declare function registerCsrf(app: FastifyInstance): Promise<void>;
/**
 * Does this request carry a token that proves it came from our own page?
 *
 * `bodyFields` lets a caller supply the token when `req.body` is not
 * populated. A multipart request has no body object at all — its token is
 * one of the parts — and the caller has already read it into a plain
 * object. Passing it here keeps the check identical to the one a plain
 * form gets: the same cookie triple and the same HMAC binding.
 */
export declare function verifyCsrfRequest(req: FastifyRequest, bodyFields?: Record<string, unknown>): boolean;
