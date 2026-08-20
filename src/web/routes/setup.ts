// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import { verifyCsrfRequest } from '../plugins/csrf';
import { setSetting, getSetting, markInitialized } from '../../storage/settings';
import { bootstrapAdmin } from '../admin/bootstrap';
import { runMigrations } from '../../storage/migrations/runner';

const SITE_NAME_MAX = 128;
const TAGLINE_MAX = 256;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function setupRoutes(app: FastifyInstance): Promise<void> {
  // GET /setup — landing page. No form, no CSRF required.
  app.get('/setup', async (req, reply) => {
    return reply.view('setup/index.hbs', {
      layout: 'layouts/setup',
      title: req.t('setup.welcome.title'),
      csrfToken: req.csrfToken,
      req,
    });
  });

  // GET /setup/database — show current DB config (no password) + Test form.
  app.get('/setup/database', async (req, reply) => {
    return reply.view('setup/database.hbs', {
      layout: 'layouts/setup',
      title: req.t('setup.database.title'),
      csrfToken: req.csrfToken,
      db: {
        host: app.cfg.db.host,
        port: app.cfg.db.port,
        user: app.cfg.db.user,
        database: app.cfg.db.database,
      },
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
      siteName: siteName ?? '',
      siteTagline: siteTagline ?? '',
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
      summary: {
        siteName: siteName ?? '',
        adminEmail,
        seedLoaded: seedLoaded === 'true',
      },
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
