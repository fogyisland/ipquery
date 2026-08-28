// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import type { RowDataPacket } from 'mysql2';
import { lastEtlRun, recentEtlRuns } from '../../storage/mysql';
import { parseIp, isValidIp } from '../../ip';
import { findRange } from '../../storage/mysql';
import { verifyCsrfRequest } from '../plugins/csrf';

export default async function marketingRoutes(app: FastifyInstance): Promise<void> {
  // Marketing redesign: all 5 public pages render inside layouts/marketing
  // (light commercial chrome, top nav + footer). isHome/isDocs/isTry/
  // isStatus/isAbout flags drive the active-nav indicator (a regression
  // where nav-active was always unset and links looked inert).
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
      isHome: true,
      showCodeTabs: true,
    });
  });

  app.get('/about', async (req, reply) => {
    return reply.view('marketing/about.hbs', {
      layout: 'layouts/marketing',
      title: req.t('nav.about'),
      req,
      viewBaseUrl: app.viewBaseUrl,
      isAbout: true,
      timeline: [
        { year: '2024', title: req.t('about.timeline.2024.title'), desc: req.t('about.timeline.2024.desc') },
        { year: '2025', title: req.t('about.timeline.2025.title'), desc: req.t('about.timeline.2025.desc') },
        { year: '2026', title: req.t('about.timeline.2026.title'), desc: req.t('about.timeline.2026.desc') },
      ],
    });
  });

  app.get('/docs', async (req, reply) => {
    return reply.view('marketing/docs.hbs', {
      layout: 'layouts/marketing',
      title: req.t('docs.title'),
      req,
      viewBaseUrl: app.viewBaseUrl,
      isDocs: true,
      showCodeTabs: true,
    });
  });

  app.get('/status', async (req, reply) => {
    // Live health probes — not hardcoded greens. dbOk drives the banner;
    // apiOk derives from dbOk (if DB is down the API is degraded).
    let dbOk = false;
    try {
      await app.pool.query('SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const apiOk = dbOk;
    const [lastRun, recent] = await Promise.all([
      lastEtlRun(app.pool),
      recentEtlRuns(app.pool, 10).catch(() => [] as Awaited<ReturnType<typeof recentEtlRuns>>),
    ]);
    // Normalize timeline bars to a 0-100% height (relative to max mergedRecords).
    const maxMerged = recent.reduce((m, r) => Math.max(m, r.mergedRecords ?? 0), 0);
    const recentRuns = recent.map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      status: r.status,
      mergedRecords: r.mergedRecords ?? 0,
      barHeight: maxMerged > 0 ? Math.max(8, Math.round(((r.mergedRecords ?? 0) / maxMerged) * 100)) : 8,
    }));
    return reply.view('marketing/status.hbs', {
      layout: 'layouts/marketing',
      title: req.t('nav.status'),
      lastRun,
      recentRuns,
      dbOk,
      apiOk,
      req,
      viewBaseUrl: app.viewBaseUrl,
      isStatus: true,
    });
  });

  app.get('/try', async (req, reply) => {
    return reply.view('marketing/try.hbs', {
      layout: 'layouts/marketing',
      title: req.t('nav.try'),
      req,
      viewBaseUrl: app.viewBaseUrl,
      isTry: true,
    });
  });

  app.post('/try', async (req, reply) => {
    if (!verifyCsrfRequest(req)) return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/marketing', req });
    const ip = ((req.body as { ip?: string }).ip ?? '').trim();
    if (!isValidIp(ip)) {
      return reply.view('marketing/try.hbs', {
        layout: 'layouts/marketing',
        title: req.t('nav.try'),
        isTry: true,
        invalid: true,
        ip,
        invalidMsg: req.t('lookup.invalid'),
        viewBaseUrl: app.viewBaseUrl,
        req,
      });
    }
    const buf = parseIp(ip);
    const row = buf ? await findRange(app.pool, buf) : null;
    if (!row) {
      return reply.view('marketing/try.hbs', {
        layout: 'layouts/marketing',
        title: req.t('nav.try'),
        isTry: true,
        notFound: true,
        ip,
        notFoundMsg: req.t('lookup.notfound', { ip }),
        viewBaseUrl: app.viewBaseUrl,
        req,
      });
    }
    const ipLookupUrl = `${app.viewBaseUrl}/lookup?ip=${encodeURIComponent(ip)}`;
    const countryName = row.countryName || row.countryCode || '';
    return reply.view('marketing/try.hbs', {
      layout: 'layouts/marketing',
      title: req.t('nav.try'),
      isTry: true,
      viewBaseUrl: app.viewBaseUrl,
      result: {
        ip,
        ipLookupUrl,
        // Pre-format heading on the server — Handlebars {{req.t key ip=...}}
        // doesn't pass hash args through (req.t is a method call, not a
        // registered helper), so the placeholder substitution has to happen
        // here.
        heading: req.t('lookup.found', { ip, country: countryName }),
        country: {
          code: row.countryCode,
          name: countryName,
          source: row.countrySource ?? 'maxmind',
        },
        region: row.region,
        city: row.city ? { name: row.city, source: row.citySource ?? 'maxmind' } : undefined,
        isp: row.isp ? { name: row.isp, source: row.ispSource ?? 'maxmind' } : undefined,
        asn: row.asn !== undefined ? { number: row.asn, org: row.asnOrg, source: row.asnSource ?? 'maxmind' } : undefined,
      },
      req,
    });
  });
}
