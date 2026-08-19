// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2';
import { lastEtlRun } from '../../storage/mysql';
import { parseIp, isValidIp } from '../../ip';
import { findRange } from '../../storage/mysql';
import { verifyCsrfRequest } from '../plugins/csrf';

export default async function marketingRoutes(app: FastifyInstance): Promise<void> {
  // Task 14: tool-style landing. Replaces marketing/home.hbs with the new
  // top-level home.hbs rendered inside layouts/app (the Task 4 shell that
  // includes the redesigned sidebar). query_log column is `ts`, not
  // `created_at` (migration 008). CSRF token is exposed via req.csrfToken
  // (decoration registered by registerCsrf in src/web/plugins/csrf.ts).
  app.get('/', async (req, reply) => {
    const [ipCountRows] = await app.pool.query<RowDataPacket[]>('SELECT COUNT(*) AS c FROM ip_ranges');
    const [q24Rows] = await app.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS c FROM query_log WHERE ts >= ?`,
      [new Date(Date.now() - 86400_000)],
    );
    const ipCount = Number((ipCountRows[0] as { c: number }).c);
    const q24 = Number((q24Rows[0] as { c: number }).c);
    return reply.view('home.hbs', {
      layout: 'layouts/app', title: req.t('home.title'),
      ipCount, q24, csrfToken: req.csrfToken, viewBaseUrl: app.viewBaseUrl, req,
    });
  });
  app.get('/about', async (req, reply) => {
    return reply.view('marketing/about.hbs', {
      layout: 'layouts/public', title: '关于', req, viewBaseUrl: app.viewBaseUrl,
    });
  });
  // Task 14: tool-style docs page rendered inside layouts/app. Lists the 4
  // public API endpoints (lookup, lookup/:ip, stats, healthz) with curl
  // examples. Mirrors Task 5 dashboard pattern (rendered view, no async data).
  app.get('/docs', async (req, reply) => {
    return reply.view('docs.hbs', {
      layout: 'layouts/app', title: req.t('docs.title'), req,
    });
  });
  // /pricing removed in Task 14 — see brief. /status, /about, /try stay on
  // layouts/public per spec §2.1 "保留,无大改" (preserve, no major changes).
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
