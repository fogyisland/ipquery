// SPDX-License-Identifier: MIT
//
// Global error handler.
//
// Fastify's fallback error handler serialises `error.message` straight
// into the response body. For a driver error that message is the raw
// MySQL text:
//
//   {"statusCode":500,"code":"ER_PARSE_ERROR","error":"Internal Server
//    Error","message":"ER_PARSE_ERROR: You have an error in your SQL
//    syntax near 'SELECT * FROM secret_table' at line 1"}
//
// That leaks table names, column names, index names, the database name
// and the server's MySQL version fingerprint to whoever triggered the
// error. `GET /stats` is public and unauthenticated, so an exhausted
// connection pool or a missing table was enough to hand that to an
// anonymous caller.
//
// `/lookup` already installs its own handler (`lookupErrorHandler`) that
// collapses unknown errors to `{ error: "internal_error" }`. This
// module provides the same guarantee for every other route.
//
// Fastify plugin encapsulation: `setErrorHandler` inside a plugin
// applies to that plugin's routes only, and the narrower scope wins.
// `/lookup` is registered as its own plugin, so its handler still
// takes precedence there — this global one covers everything else.

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
 * Errors whose `code` is a deliberate, client-facing outcome rather
 * than an internal fault. These keep their message so the caller can
 * act on it (e.g. "invalid_api_key" is meaningless without context).
 */
const CLIENT_FACING_CODES = new Set([
  "invalid_ip",
  "not_found",
  "invalid_api_key",
  "unauthorized",
  "forbidden",
  "bad_request",
  "validation_failed",
  "rate_limited",
  "conflict",
]);

/**
 * Build the global error handler.
 *
 * The full error object goes to `req.log` — the operator still gets the
 * stack trace and the SQL text; it just never reaches the client.
 */
export function createGlobalErrorHandler(): (
  err: ErrorLike,
  req: { log: LoggerLike },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => unknown {
  return function globalErrorHandler(err, req, reply) {
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;

    // 4xx is the caller's problem and its own message is safe to
    // return. 5xx is ours: log it in full, return nothing specific.
    if (statusCode >= 500) {
      req.log.error({ err }, "unhandled error");
      return reply.code(statusCode).send({ error: "internal_error" });
    }

    if (err.code && CLIENT_FACING_CODES.has(err.code)) {
      return reply.code(statusCode).send({ error: err.code, message: err.message });
    }

    // A 4xx with an unrecognised code: the message may still carry
    // internal detail, so log it and return the code alone.
    req.log.warn({ err }, "request rejected");
    return reply.code(statusCode).send({ error: err.code ?? "bad_request" });
  };
}

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
export function createNotFoundHandler(): (
  req: unknown,
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
) => unknown {
  return function notFoundHandler(_req, reply) {
    return reply.code(404).send({ error: "not_found" });
  };
}
