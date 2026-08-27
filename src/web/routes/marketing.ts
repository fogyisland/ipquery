// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2';
import { lastEtlRun } from '../../storage/mysql';
import { parseIp, isValidIp } from '../../ip';
import { findRange } from '../../storage/mysql';
import { verifyCsrfRequest } from '../plugins/csrf';

export default async function marketingRoutes(app: FastifyInstance): Promise<void> {
  // Marketing redesign: all 5 public pages now render inside layouts/marketing
  // (light commercial chrome, top nav + footer). The old layouts/app and
  // layouts/public shells are still used by admin/dashboard/auth — those
  // weren't part of this redesign.
  app.get('/', async (req, reply) => {
    const [ipCountRows] = await app.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS c FROM ip_ranges');
    const ipCount = Number((ipCountRows[0] as { c: number }).c);
    return reply.view('home.hbs', {
      layout: 'layouts/marketing',
      title: req.t('home.title'),
      ipCount,
      csrfToken: req.csrfToken,
      viewBaseUrl: app.viewBaseUrl,
      req,
      showCodeTabs: true,
    });
  });
  app.get('/about', async (req, reply) => {
    return reply.view('marketing/about.hbs', {
      layout: 'layouts/marketing', title: req.t('nav.about'), req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  app.get('/docs', async (req, reply) => {
    return reply.view('marketing/docs.hbs', {
      layout: 'layouts/marketing',
      title: req.t('docs.title'),
      req,
      viewBaseUrl: app.viewBaseUrl,
      showCodeTabs: true,
    });
  });
  app.get('/status', async (req, reply) => {
    const lastRun = await lastEtlRun(app.pool);
    return reply.view('marketing/status.hbs', {
      layout: 'layouts/marketing', title: req.t('nav.status'), lastRun, req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  app.get('/try', async (req, reply) => {
    return reply.view('marketing/try.hbs', {
      layout: 'layouts/marketing', title: req.t('nav.try'), req,
    });
  });

  app.post('/try', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/marketing', req });
    const ip = (req.body as { ip?: string }).ip ?? '';
    if (!isValidIp(ip)) {
      return reply.view('marketing/try.hbs', { layout: false, invalid: true, ip, req });
    }
    const buf = parseIp(ip);
    const row = buf ? await findRange(app.pool, buf) : null;
    if (!row) {
      return reply.view('marketing/try.hbs', { layout: false, notFound: true, ip, req });
    }
    return reply.view('marketing/try.hbs', {
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