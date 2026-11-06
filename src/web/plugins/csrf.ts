// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest } from "fastify";
import { generateCsrf, signCsrfBinding } from "../auth/tokens";

declare module "fastify" {
  interface FastifyRequest {
    csrfToken: string;
  }
}

const CSRF_TTL_MS = 4 * 60 * 60 * 1000;

// HMAC key for the csrf_bind cookie. When CSRF_SECRET is unset we
// fall back to the session secret (also config-driven). Dev/test
// still works without env vars; production should always set
// CSRF_SECRET (see server.ts fail-fast check).
function resolveSecret(app: FastifyInstance): string {
  const w = app.cfg.web as { csrfSecret?: string; sessionSecret?: string };
  if (w.csrfSecret) return w.csrfSecret;
  if (w.sessionSecret) return w.sessionSecret;
  return "ipquery-dev-csrf-fallback-do-not-use-in-prod";
}

export async function registerCsrf(app: FastifyInstance): Promise<void> {
  app.decorateRequest("csrfToken", "" as string);

  const cookieSecure = Boolean((app.cfg.web as { cookieSecure?: boolean }).cookieSecure);

  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    const secret = resolveSecret(app);
    let token: string = req.cookies?.csrf ?? "";
    let bind: string = req.cookies?.csrf_bind ?? "";
    const issuedRaw = req.cookies?.csrf_issued;
    const issued = issuedRaw ? Number(issuedRaw) : 0;

    // Rotate when: any cookie missing, expired, or the binding no
    // longer matches the nonce (browser cleared cookies, csrfSecret
    // rotated, etc.). The HMAC binds the nonce to the server-side
    // secret — the bind cookie is httpOnly + secure so XSS can't
    // exfiltrate it via document.cookie.
    let needsRotate =
      !token || !bind || !issued || Date.now() - issued > CSRF_TTL_MS;
    if (!needsRotate && signCsrfBinding(secret, token) !== bind) {
      needsRotate = true;
    }

    if (needsRotate) {
      token = generateCsrf();
      const now = Date.now();
      reply.setCookie("csrf", token, { httpOnly: false, sameSite: "lax", path: "/", secure: cookieSecure });
      reply.setCookie("csrf_issued", String(now), {
        httpOnly: false,
        sameSite: "lax",
        path: "/",
        secure: cookieSecure,
      });
      const binding = signCsrfBinding(secret, token);
      reply.setCookie("csrf_bind", binding, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: cookieSecure,
        maxAge: Math.floor(CSRF_TTL_MS / 1000),
      });
      bind = binding;
    }
    req.csrfToken = token;
  });
}

export function verifyCsrfRequest(req: FastifyRequest): boolean {
  const cookieToken = req.cookies?.csrf;
  const bind = req.cookies?.csrf_bind;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const bodyToken = typeof body.csrf === "string" ? body.csrf : undefined;
  if (!cookieToken || !bodyToken || !bind) return false;
  if (cookieToken !== bodyToken) return false;
  const issued = req.cookies?.csrf_issued ? Number(req.cookies.csrf_issued) : 0;
  if (!issued || Date.now() - issued > CSRF_TTL_MS) return false;
  // Recompute HMAC over (secret, csrf_nonce) and compare to the
  // httpOnly bind cookie. A stolen csrf cookie (XSS read of
  // document.cookie) is useless — the attacker still needs the
  // httpOnly csrf_bind value to POST successfully, and they can't
  // compute it without knowing CSRF_SECRET.
  const secret = resolveSecret(req.server as unknown as FastifyInstance);
  return signCsrfBinding(secret, cookieToken) === bind;
}
