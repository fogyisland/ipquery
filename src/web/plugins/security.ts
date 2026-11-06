// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";

export async function registerSecurityHeaders(
  app: FastifyInstance,
  opts: { cookieSecure: boolean },
): Promise<void> {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join("; ");
  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Content-Security-Policy", csp);
    if (opts.cookieSecure) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });
}
