// SPDX-License-Identifier: MIT
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import compress from "@fastify/compress";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import staticPlugin from "@fastify/static";
import * as path from "node:path";
import type { AppConfig } from "../config";
import { createPool } from "../storage/mysql";
import { registerView } from "../web/plugins/view";
import { registerI18n } from "../web/plugins/i18n";
import { registerSecurityHeaders } from "../web/plugins/security";
import { registerQueryLogWriter } from "../web/plugins/queryLog";
import { registerSession } from "../web/plugins/session";
import { registerAuthGuards } from "../web/plugins/auth";
import { registerCsrf } from "../web/plugins/csrf";
import { registerAuditLog } from "../web/plugins/auditLog";
import { registerSetupGuard } from "../web/plugins/setupGuard";
import { registerSessionPurger } from "../web/plugins/sessionPurger";
import { registerProbeRetention } from "../web/plugins/probeRetention";
import { registerRandomGenRunner } from "../web/plugins/randomIpGeneratorRunner";
import { _resetForTests as resetLoginLimit } from "../web/plugins/loginRateLimit";
import { createMailer } from "../mailer";
import healthRoute from "./routes/health";
import { createGlobalErrorHandler, createNotFoundHandler } from "./errorHandler";
import lookupRoute from "./routes/lookup";
import statsRoute from "./routes/stats";
import marketingRoute from "../web/routes/marketing";
import dashboardRoute from "../web/routes/dashboard";
import adminRoute from "../web/routes/admin";
import authRoute from "../web/routes/auth";
import setupRoute from "../web/routes/setup";

declare module "fastify" {
  interface FastifyInstance {
    cfg: AppConfig;
    pool: ReturnType<typeof createPool>;
    mailer: ReturnType<typeof createMailer>;
    resetLoginLimit: () => void;
    flushQueryLog: () => Promise<void>;
    randomGenRunner: { tickNow: () => Promise<void>; syncFromSettings: () => Promise<boolean> };
  }
}

/**
 * Strip the `key` query parameter from a URL before it is logged.
 *
 * `/lookup` accepts an API key as a query parameter for backwards
 * compatibility, but a key in the URL lands in the access log, in any
 * reverse proxy's log, in browser history and in the Referer header of
 * every outbound link from the page. A key in the log is a key in
 * someone's hands.
 *
 * The query-parameter form is kept working (removing it would break
 * existing API clients) but it is scrubbed on the way into the log, so
 * the operator's logs hold the path without the secret.
 */
export function redactKeyParam(url: string): string {
  if (!url.includes("key=")) return url;
  return url.replace(/([?&])key=[^&]*/gi, "$1key=REDACTED");
}

export async function buildServer(
  cfg: AppConfig,
  opts?: { extraRoutes?: (app: FastifyInstance) => Promise<void> | void },
): Promise<FastifyInstance> {
  // Fail-fast on missing secrets in production. NODE_ENV=production
  // (or any value other than "development"/"test"/unset) requires
  // real CSRF_SECRET and SESSION_SECRET. In dev/test we fall back
  // to a placeholder so first-run setup still works — the cookie
  // plugin already uses a similar dev fallback.
  const env = process.env.NODE_ENV ?? "development";
  if (env === "production") {
    const missing: string[] = [];
    if (!cfg.web.csrfSecret) missing.push("CSRF_SECRET");
    if (!cfg.web.sessionSecret) missing.push("SESSION_SECRET");
    if (missing.length > 0) {
      throw new Error(`refusing to start in production: missing required env vars: ${missing.join(", ")}`);
    }
  }

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      serializers: {
        req: (req: {
          method: string;
          url: string;
          headers?: Record<string, unknown>;
          hostname?: string;
          ip?: string;
          socket?: { remotePort?: number };
        }) => ({
          method: req.method,
          url: redactKeyParam(req.url),
          version:
            req.headers && typeof req.headers["accept-version"] === "string"
              ? req.headers["accept-version"]
              : undefined,
          hostname: req.hostname,
          remoteAddress: req.ip,
          remotePort: req.socket ? req.socket.remotePort : undefined,
        }),
      },
    },
  });

  // Global error handler. Fastify's fallback serialises error.message
  // into the response body, and for a driver error that message is the
  // raw MySQL text — table names, column names, the database name and
  // the server version, delivered to whoever triggered the error.
  // `/lookup` installs its own narrower handler (plugin encapsulation
  // makes the narrower scope win); this one covers every other route.
  app.setErrorHandler(createGlobalErrorHandler());
  app.setNotFoundHandler(createNotFoundHandler());

  await app.register(cors, { origin: true });
  await app.register(compress);
  await app.register(rateLimit, { max: cfg.api.rateLimit, timeWindow: "1 minute" });

  app.decorate("cfg", cfg);
  app.decorate("pool", createPool(cfg));

  // Close the database pool LAST.
  //
  // Fastify runs `onClose` hooks in REVERSE registration order, so a
  // hook added here — before any plugin registers its own — is the last
  // one to run. That matters: the plugins below flush buffered state on
  // shutdown (the session purger's final sweep, the query-log writer's
  // final batch, the probe-retention sweep). They all need the pool to
  // still be open. When this hook was registered at the end of
  // buildServer(), the pool was closed FIRST and every one of those
  // flushes failed with "Pool is closed." — the query-log writer
  // silently dropped the last buffered rows, and the session purger
  // logged a spurious error on every shutdown.
  app.addHook("onClose", async () => {
    try {
      await app.pool.end();
    } catch (err) {
      // Shutdown is best-effort — a pool that won't close leaks a
      // connection, but the process is exiting either way. Logged so a
      // repeated close failure is visible rather than silent.
      app.log.warn({ err }, "failed to close the database pool");
    }
  });

  await registerSetupGuard(app);

  await app.register(cookie, {
    secret: cfg.web.sessionSecret || cfg.web.csrfSecret || "dev-only-secret-change-me",
  });
  await app.register(formbody);
  await app.register(staticPlugin, { root: path.join(__dirname, "..", "web", "assets"), prefix: "/assets/" });
  await registerView(app, { baseUrl: cfg.web.baseUrl });
  await registerI18n(app);
  await registerSecurityHeaders(app, { cookieSecure: cfg.web.cookieSecure });
  await registerSession(app);
  registerSessionPurger(app, app.pool);
  // Sweep the per-IP probe audit trail so random_probe_log doesn't grow
  // without bound. Retention window defaults to 30 days and is
  // configurable via the `random_probe_retention_days` setting (0 = keep
  // forever).
  registerProbeRetention(app, app.pool);
  const randomGenRunner = registerRandomGenRunner(app, app.pool);
  // Sync the timer against the persisted setting. Default is OFF so
  // no random generation happens until the admin opts in.
  await randomGenRunner.syncFromSettings();
  app.decorate("randomGenRunner", randomGenRunner);
  await registerAuthGuards(app);
  await registerCsrf(app);
  app.decorate("resetLoginLimit", resetLoginLimit);

  app.decorate("mailer", createMailer(cfg));
  const queryLogWriter = registerQueryLogWriter(app, app.pool);
  app.decorate("flushQueryLog", () => queryLogWriter.flush());

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

  await app.ready();

  return app;
}
