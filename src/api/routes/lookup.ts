// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import { parseIp, isValidIp } from '../../ip';
import { findRange } from '../../storage/mysql';
import type { LookupResult } from '../../types';

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
  const etag = `unknown`; // Replaced in Task 15 (stats endpoint provides etag source)
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

export default async function lookupRoute(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err, _req, reply) => {
    const statusCode = (err as any).statusCode ?? 500;
    const code = (err as any).code;
    if (code === 'invalid_ip' || code === 'not_found') {
      return reply.code(statusCode).send({ error: code });
    }
    return reply.code(statusCode).send({ error: code ?? err.message });
  });
  app.get('/lookup', async (req, reply) => {
    const ip = (req.query as { ip?: string }).ip;
    if (!ip || !isValidIp(ip)) return reply.code(400).send({ error: 'invalid_ip', message: ip ?? 'missing' });
    return doLookup(app, ip);
  });
  app.get<{ Params: { ip: string } }>('/lookup/:ip', async (req, reply) => {
    const ip = req.params.ip;
    if (!isValidIp(ip)) return reply.code(400).send({ error: 'invalid_ip', message: ip });
    return doLookup(app, ip);
  });
}
