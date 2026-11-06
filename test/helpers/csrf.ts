// SPDX-License-Identifier: MIT
// Shared CSRF cookie helper for integration tests.
//
// The CSRF plugin (src/web/plugins/csrf.ts) requires THREE cookies on
// every POST: `csrf` (the nonce, also echoed in the body), `csrf_issued`
// (rotation timestamp), and `csrf_bind` (HMAC(secret, nonce), httpOnly).
// Helpers that only replay `csrf` + `csrf_issued` get 403 on every POST
// because the binding check fails.
import type { FastifyInstance } from "fastify";

export interface CsrfPair {
  cookie: string;
  token: string;
}

/** Extract the full CSRF cookie triple from a response's set-cookie header. */
export function csrfTripleFrom(setCookie: string[]): CsrfPair {
  const csrf = setCookie.find((c) => c.startsWith("csrf="));
  const issued = setCookie.find((c) => c.startsWith("csrf_issued="));
  const bind = setCookie.find((c) => c.startsWith("csrf_bind="));
  if (!csrf || !issued || !bind) {
    throw new Error("CSRF cookies missing from response — did the csrf plugin run?");
  }
  const token = /csrf=([a-f0-9]+)/.exec(csrf)![1]!;
  return { cookie: `${csrf.split(";")[0]}; ${issued.split(";")[0]}; ${bind.split(";")[0]}`, token };
}

/** GET a page (with optional session cookie) and return its CSRF triple. */
export async function fetchCsrfTriple(
  app: FastifyInstance,
  path: string,
  cookie?: string,
): Promise<CsrfPair> {
  const res = await app.inject({ method: "GET", url: path, ...(cookie ? { headers: { cookie } } : {}) });
  return csrfTripleFrom(res.headers["set-cookie"] as string[]);
}
