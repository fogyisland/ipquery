// SPDX-License-Identifier: MIT
import Fastify, { type FastifyInstance } from 'fastify';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import staticPlugin from '@fastify/static';
import * as path from 'node:path';
import type { AppConfig } from '../config';
import { createPool } from '../storage/mysql';
import { registerView } from '../web/plugins/view';
import { registerI18n } from '../web/plugins/i18n';
import { registerSecurityHeaders } from '../web/plugins/security';
import { registerQueryLogWriter } from '../web/plugins/queryLog';
import { registerSession } from '../web/plugins/session';
import { registerAuthGuards } from '../web/plugins/auth';
import { registerCsrf } from '../web/plugins/csrf';
import { registerAuditLog } from '../web/plugins/auditLog';
import { registerSetupGuard } from '../web/plugins/setupGuard';
import { registerSessionPurger } from '../web/plugins/sessionPurger';
import { _resetForTests as resetLoginLimit } from '../web/plugins/loginRateLimit';
import { createMailer } from '../mailer';
import healthRoute from './routes/health';
import lookupRoute from './routes/lookup';
import statsRoute from './routes/stats';
import marketingRoute from '../web/routes/marketing';
import dashboardRoute from '../web/routes/dashboard';
import adminRoute from '../web/routes/admin';
import authRoute from '../web/routes/auth';
import setupRoute from '../web/routes/setup';

declare module 'fastify' {
  interface FastifyInstance {
    cfg: AppConfig;
    pool: ReturnType<typeof createPool>;
    mailer: ReturnType<typeof createMailer>;
    resetLoginLimit: () => void;
    flushQueryLog: () => Promise<void>;
  }
}

export async function buildServer(cfg: AppConfig, opts?: { extraRoutes?: (app: FastifyInstance) => Promise<void> | void }): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  await app.register(cors, { origin: true });
  await app.register(compress);
  await app.register(rateLimit, { max: cfg.api.rateLimit, timeWindow: '1 minute' });

  app.decorate('cfg', cfg);
  app.decorate('pool', createPool(cfg));

  await registerSetupGuard(app);

  await app.register(cookie, { secret: cfg.web.sessionSecret || cfg.web.csrfSecret || 'dev-only-secret-change-me' });
  await app.register(formbody);
  await app.register(staticPlugin, { root: path.join(__dirname, '..', 'web', 'assets'), prefix: '/assets/' });
  await registerView(app, { baseUrl: cfg.web.baseUrl });
  await registerI18n(app);
  await registerSecurityHeaders(app, { cookieSecure: cfg.web.cookieSecure });
  await registerSession(app);
  registerSessionPurger(app, app.pool);
  await registerAuthGuards(app);
  await registerCsrf(app);
  app.decorate('resetLoginLimit', resetLoginLimit);

  app.decorate('mailer', createMailer(cfg));
  const queryLogWriter = registerQueryLogWriter(app, app.pool);
  app.decorate('flushQueryLog', () => queryLogWriter.flush());

  await app.register(healthRoute);
  await app.register(lookupRoute);
  await app.register(statsRoute);
  await app.register(marketingRoute);
  await app.register(dashboardRoute);
  await app.register(adminRoute);
  await app.register(authRoute);
  await app.register(setupRoute);
  registerAuditLog(app);

  if (opts?.extraRoutes) {
    await opts.extraRoutes(app);
  }

  app.addHook('onClose', async () => {
    try { await app.pool.end(); } catch { /* ignore */ }
  });

  await app.ready();

  return app;

}
