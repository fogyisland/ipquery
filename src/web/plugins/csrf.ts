// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { generateCsrf } from '../auth/tokens';

declare module 'fastify' {
  interface FastifyRequest {
    csrfToken: string;
  }
}

const CSRF_TTL_MS = 4 * 60 * 60 * 1000;

export async function registerCsrf(app: FastifyInstance): Promise<void> {
  app.decorateRequest('csrfToken', '' as string);

  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    let token = req.cookies?.csrf;
    const issuedRaw = req.cookies?.csrf_issued;
    const issued = issuedRaw ? Number(issuedRaw) : 0;

    if (!token || !issued || Date.now() - issued > CSRF_TTL_MS) {
      token = generateCsrf();
      const now = Date.now();
      reply.setCookie('csrf', token, { httpOnly: false, sameSite: 'lax', path: '/', secure: false });
      reply.setCookie('csrf_issued', String(now), { httpOnly: false, sameSite: 'lax', path: '/', secure: false });
    }
    req.csrfToken = token;
  });
}

export function verifyCsrfRequest(req: FastifyRequest): boolean {
  const cookieToken = req.cookies?.csrf;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const bodyToken = typeof body.csrf === 'string' ? body.csrf : undefined;
  if (!cookieToken || !bodyToken) return false;
  if (cookieToken !== bodyToken) return false;
  const issued = req.cookies?.csrf_issued ? Number(req.cookies.csrf_issued) : 0;
  if (!issued || Date.now() - issued > CSRF_TTL_MS) return false;
  return true;
}
