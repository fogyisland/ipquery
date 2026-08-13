// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import { lastEtlRun } from '../../storage/mysql';
import { parseIp, isValidIp } from '../../ip';
import { findRange } from '../../storage/mysql';
import { verifyCsrfRequest } from '../plugins/csrf';

export default async function marketingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    return reply.view('marketing/home.hbs', {
      layout: 'layouts/public', title: '首页', req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  app.get('/about', async (req, reply) => {
    return reply.view('marketing/about.hbs', {
      layout: 'layouts/public', title: '关于', req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  app.get('/docs', async (req, reply) => {
    return reply.view('marketing/docs.hbs', {
      layout: 'layouts/public', title: 'API 文档', req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  app.get('/pricing', async (req, reply) => {
    return reply.view('marketing/pricing.hbs', {
      layout: 'layouts/public', title: '定价', req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  app.get('/status', async (req, reply) => {
    const lastRun = await lastEtlRun(app.pool);
    return reply.view('marketing/status.hbs', {
      layout: 'layouts/public', title: '状态', lastRun, req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  app.get('/try', async (req, reply) => {
    return reply.view('marketing/try.hbs', { layout: 'layouts/public', title: '在线试查', req });
  });

  app.post('/try', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/public', req });
    const ip = (req.body as { ip?: string }).ip ?? '';
    if (!isValidIp(ip)) {
      return reply.view('marketing/_try-result.hbs', { layout: false, invalid: true, ip, req });
    }
    const buf = parseIp(ip);
    const row = buf ? await findRange(app.pool, buf) : null;
    if (!row) {
      return reply.view('marketing/_try-result.hbs', { layout: false, notFound: true, ip, req });
    }
    return reply.view('marketing/_try-result.hbs', {
      layout: false,
      result: {
        ip,
        country: { code: row.countryCode, name: row.countryName, source: row.countrySource ?? 'maxmind' },
        region: row.region,
        city: row.city ? { name: row.city, source: row.citySource ?? 'maxmind' } : undefined,
        isp: row.isp ? { name: row.isp, source: row.ispSource ?? 'maxmind' } : undefined,
        asn: row.asn !== undefined ? { number: row.asn, org: row.asnOrg, source: row.asnSource ?? 'maxmind' } : undefined,
      },
      req,
    });
  });
}
