"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactKeyParam = redactKeyParam;
exports.buildServer = buildServer;
// SPDX-License-Identifier: MIT
const fastify_1 = __importDefault(require("fastify"));
const compress_1 = __importDefault(require("@fastify/compress"));
const cors_1 = __importDefault(require("@fastify/cors"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const cookie_1 = __importDefault(require("@fastify/cookie"));
const formbody_1 = __importDefault(require("@fastify/formbody"));
const static_1 = __importDefault(require("@fastify/static"));
const path = __importStar(require("node:path"));
const mysql_1 = require("../storage/mysql");
const runner_1 = require("../storage/migrations/runner");
const view_1 = require("../web/plugins/view");
const i18n_1 = require("../web/plugins/i18n");
const security_1 = require("../web/plugins/security");
const queryLog_1 = require("../web/plugins/queryLog");
const session_1 = require("../web/plugins/session");
const auth_1 = require("../web/plugins/auth");
const csrf_1 = require("../web/plugins/csrf");
const auditLog_1 = require("../web/plugins/auditLog");
const initGuard_1 = require("../web/plugins/initGuard");
const sessionPurger_1 = require("../web/plugins/sessionPurger");
const probeRetention_1 = require("../web/plugins/probeRetention");
const randomIpGeneratorRunner_1 = require("../web/plugins/randomIpGeneratorRunner");
const loginRateLimit_1 = require("../web/plugins/loginRateLimit");
const mailer_1 = require("../mailer");
const health_1 = __importDefault(require("./routes/health"));
const errorHandler_1 = require("./errorHandler");
const lookup_1 = __importDefault(require("./routes/lookup"));
const stats_1 = __importDefault(require("./routes/stats"));
const marketing_1 = __importDefault(require("../web/routes/marketing"));
const dashboard_1 = __importDefault(require("../web/routes/dashboard"));
const admin_1 = __importDefault(require("../web/routes/admin"));
const auth_2 = __importDefault(require("../web/routes/auth"));
const init_1 = __importDefault(require("../web/routes/init"));
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
function redactKeyParam(url) {
    if (!url.includes("key="))
        return url;
    return url.replace(/([?&])key=[^&]*/gi, "$1key=REDACTED");
}
/**
 * The public API paths — the only routes the global rate limit applies to.
 *
 * These three are what an external caller hits: a range lookup per
 * request, an unauthenticated endpoint by design. They are the abuseable
 * surface, and they are what the 60/minute budget exists to protect.
 *
 * Everything else — HTML pages, static assets, the MCP tool surface
 * (a separate process), and admin routes (which carry their own
 * route-level limits) — is either cheap to serve or already limited
 * more precisely.
 *
 * The comparison is on the path alone, query string stripped, so
 * `/lookup?ip=…` is still limited.
 */
const PUBLIC_API_PATHS = new Set(["/healthz", "/lookup", "/stats"]);
function isPublicApiPath(url) {
    const pathOnly = url.split("?")[0];
    return PUBLIC_API_PATHS.has(pathOnly);
}
async function buildServer(cfg, opts) {
    // Fail-fast on missing secrets in production. NODE_ENV=production
    // (or any value other than "development"/"test"/unset) requires
    // real CSRF_SECRET and SESSION_SECRET. In dev/test we fall back
    // to a placeholder so first-run setup still works — the cookie
    // plugin already uses a similar dev fallback.
    const env = process.env.NODE_ENV ?? "development";
    if (env === "production") {
        const missing = [];
        if (!cfg.web.csrfSecret)
            missing.push("CSRF_SECRET");
        if (!cfg.web.sessionSecret)
            missing.push("SESSION_SECRET");
        if (missing.length > 0) {
            throw new Error(`refusing to start in production: missing required env vars: ${missing.join(", ")}`);
        }
    }
    const app = (0, fastify_1.default)({
        logger: {
            level: process.env.LOG_LEVEL ?? "info",
            serializers: {
                req: (req) => ({
                    method: req.method,
                    url: redactKeyParam(req.url),
                    version: req.headers && typeof req.headers["accept-version"] === "string"
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
    app.setErrorHandler((0, errorHandler_1.createGlobalErrorHandler)());
    app.setNotFoundHandler((0, errorHandler_1.createNotFoundHandler)());
    await app.register(cors_1.default, { origin: true });
    await app.register(compress_1.default);
    await app.register(rate_limit_1.default, {
        max: cfg.api.rateLimit,
        timeWindow: "1 minute",
        // Only the public API is rate limited. Static assets and HTML pages
        // are not.
        //
        // The global limit counts every request by source IP, so a single
        // page load spent several of the 60/minute allowance on stylesheets
        // and scripts. An anonymous visitor could burn most of the budget on
        // CSS and then be refused the page that was meant to deliver it.
        //
        // What a 429 on an asset looks like is worse than a slow page: the
        // rate limiter answers with a JSON body, so the browser reports
        // "Refused to apply style ... MIME type 'application/json' is not a
        // supported stylesheet MIME type" — the stylesheet silently never
        // applies and the page renders unstyled.
        //
        // The split follows what actually needs protecting. The API is the
        // expensive, abuseable surface: it does a range lookup per request
        // and is what an external caller would hammer. Page and asset
        // requests are bounded by human browsing speed and cost a cheap
        // render or a file read.
        //
        // The exemption is by path, so it cannot be used to dodge the limit
        // on the API itself. Admin routes keep their own route-level limits
        // (see ADMIN_POLL_RATE_LIMIT in web/routes/admin.ts).
        allowList: (request) => !isPublicApiPath(request.url),
    });
    app.decorate("cfg", cfg);
    app.decorate("pool", (0, mysql_1.createPool)(cfg));
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
        }
        catch (err) {
            // Shutdown is best-effort — a pool that won't close leaks a
            // connection, but the process is exiting either way. Logged so a
            // repeated close failure is visible rather than silent.
            app.log.warn({ err }, "failed to close the database pool");
        }
    });
    // A brand-new install points at an empty database: no tables at all. The
    // first-run wizard is what walks the operator through setup, but two of its
    // six steps read tables (etl_runs, users) before any POST has run the
    // migrations — /init/seed and /init/complete both 500'd on a fresh
    // database, leaving the wizard unfinishable. Bootstrap the schema here so
    // that the very first request to the wizard lands on a working install.
    //
    // Migration is idempotent and cheap when everything is already applied (one
    // SELECT against schema_migrations), so this costs a single round trip on
    // every subsequent boot. The wizard re-runs it at seed time regardless.
    await (0, runner_1.runMigrations)(app.pool);
    await (0, initGuard_1.registerInitGuard)(app);
    await app.register(cookie_1.default, {
        secret: cfg.web.sessionSecret || cfg.web.csrfSecret || "dev-only-secret-change-me",
    });
    await app.register(formbody_1.default);
    await app.register(static_1.default, { root: path.join(__dirname, "..", "web", "assets"), prefix: "/assets/" });
    await (0, view_1.registerView)(app, { baseUrl: cfg.web.baseUrl });
    await (0, i18n_1.registerI18n)(app);
    await (0, security_1.registerSecurityHeaders)(app, { cookieSecure: cfg.web.cookieSecure });
    await (0, session_1.registerSession)(app);
    (0, sessionPurger_1.registerSessionPurger)(app, app.pool);
    // Sweep the per-IP probe audit trail so random_probe_log doesn't grow
    // without bound. Retention window defaults to 30 days and is
    // configurable via the `random_probe_retention_days` setting (0 = keep
    // forever).
    (0, probeRetention_1.registerProbeRetention)(app, app.pool);
    const randomGenRunner = (0, randomIpGeneratorRunner_1.registerRandomGenRunner)(app, app.pool);
    // Sync the timer against the persisted setting. Default is OFF so
    // no random generation happens until the admin opts in.
    await randomGenRunner.syncFromSettings();
    app.decorate("randomGenRunner", randomGenRunner);
    await (0, auth_1.registerAuthGuards)(app);
    await (0, csrf_1.registerCsrf)(app);
    app.decorate("resetLoginLimit", loginRateLimit_1._resetForTests);
    app.decorate("mailer", (0, mailer_1.createMailer)(cfg));
    const queryLogWriter = (0, queryLog_1.registerQueryLogWriter)(app, app.pool);
    app.decorate("flushQueryLog", () => queryLogWriter.flush());
    await app.register(health_1.default);
    await app.register(lookup_1.default);
    await app.register(stats_1.default);
    await app.register(marketing_1.default);
    await app.register(dashboard_1.default);
    await app.register(admin_1.default);
    await app.register(auth_2.default);
    await app.register(init_1.default);
    (0, auditLog_1.registerAuditLog)(app);
    if (opts?.extraRoutes) {
        await opts.extraRoutes(app);
    }
    await app.ready();
    return app;
}
//# sourceMappingURL=server.js.map