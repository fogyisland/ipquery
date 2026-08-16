// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parseIp, isValidIp } from '../../ip';
import { findRange, lastSuccessfulEtl } from '../../storage/mysql';
import { findActiveApiKeyByHash } from '../../storage/apiKeys';
import { hashToken } from '../../web/auth/tokens';
import type { LookupResult } from '../../types';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: { keyId: number; userId: number; prefix: string };
  }
}

async function doLookup(app: FastifyInstance, ip: string): Promise<LookupResult> {
  const buf = parseIp(ip);
  if (!buf) {
    const err = new Error(`invalid ip: ${ip}`);
    (err as any).statusCode = 400;
    (err as any).code = 'invalid_ip';
    throw err;
  }
  const row = await findRange(app.pool, buf);
  if (!row) {
    const err = new Error(`not found: ${ip}`);
    (err as any).statusCode = 404;
    (err as any).code = 'not_found';
    (err as any).ip = ip;
    throw err;
  }
  const lastRun = await lastSuccessfulEtl(app.pool);
  const etag = lastRun ? lastRun.toISOString() : 'never';
  return {
    ip,
    country: { code: row.countryCode, name: row.countryName, source: row.countrySource ?? 'maxmind' },
    region: row.region,
    city: row.city ? { name: row.city, source: row.citySource ?? 'maxmind' } : undefined,
    postalCode: row.postalCode,
    location: row.latitude !== undefined && row.longitude !== undefined
      ? { lat: row.latitude, lon: row.longitude, source: row.geoSource ?? 'maxmind' }
      : undefined,
    timezone: row.timezone,
    isp: row.isp ? { name: row.isp, source: row.ispSource ?? 'maxmind' } : undefined,
    asn: row.asn !== undefined ? { number: row.asn, org: row.asnOrg, source: row.asnSource ?? 'maxmind' } : undefined,
    etag,
  };
}

export function lookupErrorHandler(err: unknown, _req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown }; send: (b: unknown) => unknown }): unknown {
  const statusCode = (err as any).statusCode ?? 500;
  const code = (err as any).code;
  if (code === 'invalid_ip' || code === 'not_found' || code === 'invalid_api_key') {
    return reply.code(statusCode).send({ error: code });
  }
  return reply.code(statusCode).send({ error: 'internal_error' });
}

function extractKey(req: { query: unknown; headers: Record<string, string | string[] | undefined> }): string | null {
  const q = (req.query as Record<string, unknown> | undefined)?.key;
  if (typeof q === 'string' && q.length > 0) return q;
  const h = req.headers['authorization'];
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

function ipFromReq(req: FastifyRequest): string | undefined {
  const q = (req.query as { ip?: string }).ip;
  if (q) return q;
  const p = (req.params as { ip?: string } | undefined)?.ip;
  if (p) return p;
  return undefined;
}

export default async function lookupRoute(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(lookupErrorHandler);

  const preHandler = async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const raw = extractKey(req);
    if (!raw) return;
    const found = await findActiveApiKeyByHash(app.pool, hashToken(raw));
    if (!found) {
      const err = new Error('invalid api key') as Error & { statusCode: number; code: string };
      err.statusCode = 401;
      err.code = 'invalid_api_key';
      throw err;
    }
    req.apiKey = { keyId: found.id, userId: found.userId, prefix: found.keyPrefix };
  };

  const logOnSend = async (req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
    if (!req.apiKey) return payload;
    // In Fastify 4, payload is already serialized to a string by the time onSend runs.
    // Detect status from reply.statusCode + request context (which IP was asked).
    const statusCode = reply.statusCode;
    const ipText = ipFromReq(req);
    let status: 'hit' | 'miss' | 'invalid';
    if (statusCode === 200) {
      status = 'hit';
    } else if (statusCode === 404) {
      status = 'miss';
    } else if (statusCode === 400) {
      status = 'invalid';
    } else {
      // 401 invalid_api_key or other auth failures → don't log
      return payload;
    }
    if (!ipText) return payload;
    const buf = parseIp(ipText);
    if (!buf) return payload;
    const remoteBuf = req.ip ? parseIp(req.ip) : null;
    req.pendingLog = {
      ip: buf,
      ipText,
      status,
      userId: req.apiKey.userId,
      apiKeyId: req.apiKey.keyId,
      sessionId: null,
      remoteAddr: remoteBuf,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    };
    return payload;
  };

  app.get('/lookup', { preHandler, onSend: logOnSend }, async (req, reply) => {
    const ip = (req.query as { ip?: string }).ip;
    if (!ip || !isValidIp(ip)) return reply.code(400).send({ error: 'invalid_ip', message: ip ?? 'missing' });
    return doLookup(app, ip);
  });
  app.get<{ Params: { ip: string } }>('/lookup/:ip', { preHandler, onSend: logOnSend }, async (req, reply) => {
    const ip = req.params.ip;
    if (!isValidIp(ip)) return reply.code(400).send({ error: 'invalid_ip', message: ip });
    return doLookup(app, ip);
  });
}