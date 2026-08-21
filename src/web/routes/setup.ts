// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyCsrfRequest } from '../plugins/csrf';
import { setSetting, getSetting, markInitialized } from '../../storage/settings';
import { bootstrapAdmin } from '../admin/bootstrap';
import { runMigrations } from '../../storage/migrations/runner';

const SITE_NAME_MAX = 128;
const TAGLINE_MAX = 256;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Build the 6-step indicator. Labels are pre-translated here (Phase B Task 6
// finding: avoid {{req.t '...'}} inside {{#each}}).
function buildSteps(req: FastifyRequest, current: number): Array<{ n: number; label: string; href: string; active: boolean }> {
  return [
    { n: 1, label: req.t('setup.steps.1'), href: '/setup', active: current === 1 },
    { n: 2, label: req.t('setup.steps.2'), href: '/setup/database', active: current === 2 },
    { n: 3, label: req.t('setup.steps.3'), href: '/setup/site', active: current === 3 },
    { n: 4, label: req.t('setup.steps.4'), href: '/setup/admin', active: current === 4 },
    { n: 5, label: req.t('setup.steps.5'), href: '/setup/seed', active: current === 5 },
    { n: 6, label: req.t('setup.steps.6'), href: '/setup/complete', active: current === 6 },
  ];
}

// Map ?flash=success|error on redirect to a flash object whose message is the
// translated text for the route-specific key. Returns undefined if no flash.
function getFlash(req: FastifyRequest, successKey: string, errorKey: string): { success?: string; error?: string } {
  const q = req.query as { flash?: string };
  const kind = q.flash;
  if (kind === 'success') return { success: req.t(successKey) };
  if (kind === 'error') return { error: req.t(errorKey) };
  return {};
}

export default async function setupRoutes(app: FastifyInstance): Promise<void> {
  // GET /setup — landing page. No form, no CSRF required.
  app.get('/setup', async (req, reply) => {
    return reply.view('setup/index.hbs', {
      layout: 'layouts/setup',
      title: req.t('setup.welcome.title'),
      csrfToken: req.csrfToken,
      steps: buildSteps(req, 1),
      step: 1,
      total: 6,
      flash: getFlash(req, 'setup.welcome.title', 'setup.welcome.title'),
      req,
    });
  });

  // GET /setup/database — show current DB config (no password) + Test form.
  app.get('/setup/database', async (req, reply) => {
    return reply.view('setup/database.hbs', {
      layout: 'layouts/setup',
      title: req.t('setup.database.title'),
      csrfToken: req.csrfToken,
      steps: buildSteps(req, 2),
      step: 2,
      total: 6,
      db: {
        host: app.cfg.db.host,
        port: app.cfg.db.port,
        user: app.cfg.db.user,
        database: app.cfg.db.database,
      },
      flash: getFlash(req, 'setup.database.success', 'setup.database.failure'),
      error: (req.query as { flash?: string }).flash === 'error' ? req.t('setup.database.failure') : undefined,
      req,
    });
  });

  // POST /setup/database — probe app.pool. On success → /setup/site.
  app.post('/setup/database', async (req, reply) => {
    if (!verifyCsrfRequest(req)) {
      return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/setup', req });
    }
    let conn;
    try {
      conn = await app.pool.getConnection();
      await conn.ping();
    } catch (err) {
      // Sanitize: do not echo a raw mysql error string (could leak DSN/hints).
      return reply.code(302)
        .header('Location', '/setup/database?flash=error')
        .send();
    } finally {
      if (conn) {
        try { conn.release(); } catch { /* ignore */ }
      }
    }
    return reply.code(302)
      .header('Location', '/setup/site?flash=success')
      .send();
  });

  // GET /setup/site — site name + tagline form.
  app.get('/setup/site', async (req, reply) => {
    const [siteName, siteTagline] = await Promise.all([
      getSetting(app.pool, 'site.name'),
      getSetting(app.pool, 'site.tagline'),
    ]);
    return reply.view('setup/site.hbs', {
      layout: 'layouts/setup',
      title: req.t('setup.site.title'),
      csrfToken: req.csrfToken,
      steps: buildSteps(req, 3),
      step: 3,
      total: 6,
      siteName: siteName ?? '',
      siteTagline: siteTagline ?? '',
      flash: getFlash(req, 'setup.site.success', 'setup.site.error'),
      error: (req.query as { flash?: string }).flash === 'error' ? req.t('setup.site.error') : undefined,
      req,
    });
  });

  // POST /setup/site — save site.name and site.tagline.
  app.post('/setup/site', async (req, reply) => {
    if (!verifyCsrfRequest(req)) {
      return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/setup', req });
    }
    const body = req.body as { name?: string; tagline?: string };
    const name = (body.name ?? '').trim();
    const tagline = (body.tagline ?? '').trim();

    if (!name || name.length > SITE_NAME_MAX) {
      return reply.code(302).header('Location', '/setup/site?flash=error').send();
    }
    if (tagline.length > TAGLINE_MAX) {
      return reply.code(302).header('Location', '/setup/site?flash=error').send();
    }
    await setSetting(app.pool, 'site.name', name);
    await setSetting(app.pool, 'site.tagline', tagline);
    return reply.code(302).header('Location', '/setup/admin?flash=success').send();
  });

  // GET /setup/admin — admin bootstrap form.
  app.get('/setup/admin', async (req, reply) => {
    return reply.view('setup/admin.hbs', {
      layout: 'layouts/setup',
      title: req.t('setup.admin.title'),
      csrfToken: req.csrfToken,
      steps: buildSteps(req, 4),
      step: 4,
      total: 6,
      flash: getFlash(req, 'setup.admin.success', 'setup.admin.error'),
      error: (req.query as { flash?: string }).flash === 'error' ? req.t('setup.admin.error') : undefined,
      req,
    });
  });

  // POST /setup/admin — bootstrap admin via bootstrapAdmin().
  app.post('/setup/admin', async (req, reply) => {
    if (!verifyCsrfRequest(req)) {
      return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/setup', req });
    }
    const body = req.body as { email?: string; password?: string; displayName?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    const displayName = (body.displayName ?? '').trim();

    if (!EMAIL_RE.test(email)) {
      return reply.code(302).header('Location', '/setup/admin?flash=error').send();
    }
    if (!displayName || displayName.length > 64) {
      return reply.code(302).header('Location', '/setup/admin?flash=error').send();
    }
    try {
      await bootstrapAdmin(app.pool, { email, password, displayName });
    } catch {
      // bootstrapAdmin throws on weak password or hash failure.
      return reply.code(302).header('Location', '/setup/admin?flash=error').send();
    }
    return reply.code(302).header('Location', '/setup/seed?flash=success').send();
  });

  // GET /setup/seed — radio: load 50 seed IPs (yes/no).
  app.get('/setup/seed', async (req, reply) => {
    return reply.view('setup/seed.hbs', {
      layout: 'layouts/setup',
      title: req.t('setup.seed.title'),
      csrfToken: req.csrfToken,
      steps: buildSteps(req, 5),
      step: 5,
      total: 6,
      flash: getFlash(req, 'setup.seed.success', 'setup.seed.skipped'),
      req,
    });
  });

  // POST /setup/seed — always run migrations (idempotent); load flag is advisory.
  app.post('/setup/seed', async (req, reply) => {
    if (!verifyCsrfRequest(req)) {
      return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/setup', req });
    }
    const body = req.body as { load?: string };
    const load = body.load === 'true';
    await runMigrations(app.pool);
    // Migration 012 already inserted 50 seed rows via INSERT IGNORE. The
    // `load` flag is purely a UI preference; we persist it for the summary
    // page and possible later audit.
    await setSetting(app.pool, 'seed.loaded', load ? 'true' : 'false');
    return reply.code(302).header('Location', '/setup/complete?flash=success').send();
  });

  // GET /setup/complete — summary page.
  app.get('/setup/complete', async (req, reply) => {
    const [siteName, seedLoaded] = await Promise.all([
      getSetting(app.pool, 'site.name'),
      getSetting(app.pool, 'seed.loaded'),
    ]);
    // The admin email isn't in settings (it lives in users.email). For the
    // summary we look it up from the users table — bootstrapAdmin always
    // created exactly one admin row at this point.
    const [rows] = await app.pool.query<import('mysql2').RowDataPacket[]>(
      `SELECT email FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`,
    );
    const adminEmail = (rows[0] as { email?: string } | undefined)?.email ?? '';
    return reply.view('setup/complete.hbs', {
      layout: 'layouts/setup',
      title: req.t('setup.complete.title'),
      csrfToken: req.csrfToken,
      steps: buildSteps(req, 6),
      step: 6,
      total: 6,
      summary: {
        siteName: siteName ?? '',
        adminEmail,
        seedLoaded: seedLoaded === 'true',
      },
      flash: getFlash(req, 'setup.complete.success', 'setup.complete.success'),
      req,
    });
  });

  // POST /setup/complete — flip initialized_at; guard re-reads it onResponse.
  app.post('/setup/complete', async (req, reply) => {
    if (!verifyCsrfRequest(req)) {
      return reply.code(403).view('errors/csrf.hbs', { layout: 'layouts/setup', req });
    }
    await markInitialized(app.pool);
    return reply.code(302).header('Location', '/login?flash=success').send();
  });
}
