export interface ErrorLike {
    statusCode?: number;
    code?: string;
    message?: string;
}
/** The bits of Fastify's logger this handler uses. */
interface LoggerLike {
    error: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
}
/**
 * Build the global error handler.
 *
 * The full error object goes to `req.log` — the operator still gets the
 * stack trace and the SQL text; it just never reaches the client.
 */
export declare function createGlobalErrorHandler(): (err: ErrorLike, req: {
    log: LoggerLike;
}, reply: {
    code: (n: number) => {
        send: (b: unknown) => unknown;
    };
}) => unknown;
/**
 * The 404 handler.
 *
 * Fastify's default not-found reply echoes the request path back:
//   {"message":"Route GET:/nope not found","error":"Not Found",
//    "statusCode":404}
 * That confirms which paths exist to anyone who probes them. The
 * routes the admin UI links to are all documented anyway, so the
 * echo buys nothing and costs a little.
 */
export declare function createNotFoundHandler(): (req: unknown, reply: {
    code: (n: number) => {
        send: (b: unknown) => unknown;
    };
}) => unknown;
export {};
