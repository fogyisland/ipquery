import type { FastifyInstance, FastifyRequest } from "fastify";
declare module "fastify" {
    interface FastifyRequest {
        apiKey?: {
            keyId: number;
            userId: number;
            prefix: string;
        };
    }
}
export declare function lookupErrorHandler(err: unknown, _req: unknown, reply: {
    code: (n: number) => {
        send: (b: unknown) => unknown;
    };
    send: (b: unknown) => unknown;
}): unknown;
/** Recognisable caller — an API key owner or a signed-in web session.
 *  The distinction matters for what gets written below: an API key
 *  attributes to both the user and the key, a session attributes to the
 *  user and the session id, and an anonymous caller gets no row at all. */
interface Caller {
    userId: number;
    apiKeyId: number | null;
    sessionId: string | null;
}
/**
 * Who is making this request, if anyone can be identified.
 *
 * This is the single place that decides whether a query is attributable.
 * It is shared by the API route and the browser's /try form so the two
 * cannot drift apart: the form used to log nothing at all, which meant
 * the analytics page counted no browser traffic.
 */
export declare function callerOf(req: FastifyRequest): Caller | null;
export default function lookupRoute(app: FastifyInstance): Promise<void>;
export {};
