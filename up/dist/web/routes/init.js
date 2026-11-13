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
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = initRoutes;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const csrf_1 = require("../plugins/csrf");
const settings_1 = require("../../storage/settings");
const dbBootstrap_1 = require("../../api/dbBootstrap");
const bootstrap_1 = require("../admin/bootstrap");
const runner_1 = require("../../storage/migrations/runner");
const demoSeed_1 = require("../../storage/seed/demoSeed");
const pipeline_1 = require("../../etl/pipeline");
const runGuard_1 = require("../../etl/runGuard");
const mysql_1 = require("../../storage/mysql");
const download_1 = require("../../etl/download");
const SITE_NAME_MAX = 128;
const TAGLINE_MAX = 256;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Build the 7-step boot-log indicator. Labels are pre-translated here (Phase B
// Task 6 finding: avoid {{req.t '...'}} inside {{#each}}). `done` marks every
// step before the current one so the rail can show [ok] and filled ticks.
function buildSteps(req, current) {
    const steps = [
        [req.t("setup.steps.1"), "/init"],
        [req.t("setup.steps.2"), "/init/env"],
        [req.t("setup.steps.3"), "/init/database"],
        [req.t("setup.steps.4"), "/init/site"],
        [req.t("setup.steps.5"), "/init/admin"],
        [req.t("setup.steps.6"), "/init/seed"],
        [req.t("setup.steps.7"), "/init/complete"],
    ];
    return steps.map(([label, href], index) => {
        const n = index + 1;
        return { n, label, href, active: n === current, done: n < current };
    });
}
// Every CSRF failure still renders inside the boot console. Give the layout
// the same rail/step/total data its GET page uses so a 403 never shows an
// empty step list or a broken progress line.
function renderCsrfError(req, reply, step) {
    return reply.code(403).view("errors/csrf.hbs", {
        layout: "layouts/init",
        title: req.t("error.csrf.title"),
        csrfToken: req.csrfToken,
        steps: buildSteps(req, step),
        step,
        total: 7,
        req,
    });
}
// Map ?flash=success|error on redirect to a flash object whose message is the
// translated text for the route-specific key. Returns undefined if no flash.
//
// `flash=restart` is a third kind: the .env was written with a port that
// differs from the one this process booted with, so the new port only
// takes effect after a restart. It is a notice, not a failure — the
// wizard carries on and the operator restarts once at the end.
function getFlash(req, successKey, errorKey, vars) {
    const q = req.query;
    const kind = q.flash;
    if (kind === "success")
        return { success: req.t(successKey) };
    if (kind === "error")
        return { error: req.t(errorKey) };
    if (kind === "restart")
        return { notice: req.t("setup.env.restartNeeded", vars) };
    return {};
}
// The port the .env on disk holds right now.
//
// Read from the FILE rather than from the request or the config: the
// file is what the next boot will use, so it is the only answer to
// "what port will this service listen on after a restart". Falls back
// to the running port if the file cannot be read or has no port.
function readEnvPort(app) {
    try {
        const values = (0, dbBootstrap_1.parseEnvFile)(fs.readFileSync((0, dbBootstrap_1.envFilePath)(), "utf8"));
        const port = values.PORT?.trim();
        if (port !== undefined && /^\d{1,5}$/.test(port))
            return port;
    }
    catch {
        // An unreadable .env is the startup generator's problem, not this
        // page's. Fall through to the running port.
    }
    return String(app.cfg.api.port);
}
// Read the most recent ETL run row (any status). Returns null if the table is
// empty (i.e. the wizard has never triggered an ETL during this install).
async function readLatestRun(pool) {
    const [rows] = await pool.query(`SELECT id, status, started_at, finished_at, merged_records, error_message
       FROM etl_runs ORDER BY id DESC LIMIT 1`);
    const r = rows[0];
    if (!r)
        return null;
    return {
        id: Number(r.id),
        status: r.status,
        startedAt: r.started_at,
        finishedAt: r.finished_at ?? null,
        mergedRecords: r.merged_records == null ? null : Number(r.merged_records),
        errorMessage: r.error_message ?? null,
    };
}
// Spawn a background ETL run for the wizard. The wizard's POST handler calls
// this and redirects immediately; the progress page polls /init/seed while
// a `running` row exists in etl_runs.
//
// Guarded: refuses to start if another ETL is already in progress (etl_runs
// row with status='running'). Without this guard, double-clicking submit
// would spawn two pipelines that race on truncateNew + atomicSwapRanges.
async function startBackgroundEtl(app) {
    // Shared guard: refuses to start if another ETL is already in progress
    // (an etl_runs row with status='running'). Without this guard,
    // double-clicking submit would spawn two pipelines that race on
    // truncateNew + atomicSwapRanges.
    const runningRunId = await (0, runGuard_1.findRunningEtlRun)(app.pool);
    if (runningRunId !== null)
        return { busy: true };
    // Pre-create the run row so the progress page can find it the instant the
    // client lands on /init/seed after the redirect.
    const runId = await (0, mysql_1.recordEtlStart)(app.pool);
    await (0, settings_1.setSetting)(app.pool, "etl.setup.inProgress", "true");
    // Fire-and-forget. The setup wizard should NEVER block on this — full
    // DB-IP city-lite ingest takes 5-15 minutes. setImmediate moves the task
    // out of the current microtask so the response handler returns first.
    setImmediate(() => {
        void (async () => {
            try {
                // Step 1: download DB-IP free CSVs (best-effort per file; failures
                // don't throw, they're returned in `failures`).
                const outDir = path.join(app.cfg.etl.dataDir, "raw");
                const dl = await (0, download_1.downloadAll)(download_1.DEFAULT_SPECS, outDir);
                app.log.info({ results: dl.results.length, failures: dl.failures.length, runId }, "setup: DB-IP download complete");
                // Step 2: run the pipeline against the freshly-downloaded files.
                // runPipeline creates its own pool and ends it — fine, the web server
                // keeps using app.pool. It updates the pre-created runId row.
                await (0, pipeline_1.runPipeline)({ cfg: app.cfg, runId });
            }
            catch (err) {
                app.log.error({ err, runId }, "setup: background ETL failed");
            }
            finally {
                await (0, settings_1.setSetting)(app.pool, "etl.setup.inProgress", "false").catch(() => undefined);
            }
        })();
    });
    return { runId };
}
/**
 * The public address the operator is reaching the wizard on.
 *
 * The startup-generated .env carries `WEB_BASE_URL=http://localhost:3880`
 * — a placeholder, because at boot time the server has no way to know
 * what domain it will be served on. Left alone, that placeholder ends
 * up in three places the operator will actually read:
 *
 *   - the verification and password-reset links in outgoing email, which
 *     would point a real user at http://localhost:3880/verify?token=...
 *   - the API endpoint template on the dashboard keys page, which would
 *     hand remote callers an address they cannot reach.
 *
 * So the form suggests the address the browser is actually using.
 *
 * **Why reading these headers here is safe, while `trustProxy` is off.**
 * `trustProxy` decides whether `req.ip` — the peer address — may be
 * taken from `X-Forwarded-For`. If that header is forged, the forger
 * picks which rate-limit bucket and which access check they land in,
 * so the answer has to be yes for everyone. That decision is still the
 * operator's to make (see up/BAOTA.md).
 *
 * This function asks a different question: "what text should we prefill
 * into a box the operator is looking at?" A forged header can only put
 * a wrong string in that box, and the operator reads it before saving.
 * The value never reaches an access-control decision, and it is
 * validated below — the host must look like a host, and the scheme must
 * be one of the two we recognise.
 *
 * The scheme needs `X-Forwarded-Proto` because behind a TLS-terminating
 * proxy the connection to Node is plain http even though the public
 * site is https. Without it every https deployment would be suggested
 * as `http://`, and the operator would have to know to correct it.
 *
 * Returns undefined when the host is unusable — missing, or not shaped
 * like a host at all.
 */
function suggestBaseUrl(req) {
    const host = req.headers.host?.trim();
    if (!host)
        return undefined;
    // Reject a Host header that is not a plain host[:port]. It lands in
    // the .env and then in outgoing email, so anything with a scheme, a
    // path, credentials or a space in it is not a host.
    if (!/^[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(host))
        return undefined;
    // The scheme: the proxy's word first (it knows what the browser used),
    // then the connection we actually see.
    //
    // A forwarded value can be a comma-separated list, because a chain of
    // proxies appends to it. The FIRST entry is the original client's
    // scheme — that is the one describing the public address.
    const forwarded = req.headers["x-forwarded-proto"];
    const forwardedProto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
        ?.split(",")[0]
        ?.trim()
        .toLowerCase();
    let protocol;
    if (forwardedProto === "https" || forwardedProto === "http") {
        protocol = forwardedProto;
    }
    else {
        protocol = req.protocol === "https" ? "https" : "http";
    }
    return `${protocol}://${host}`;
}
/**
 * Read the current values of the keys the wizard owns out of the .env.
 *
 * Returns the values AND whether secrets are already present, because
 * the form has to say two different things depending on the answer:
 * "these will be generated for you" versus "these already exist and
 * will be kept". Silently replacing an operator's session secret would
 * log everyone out; silently keeping a placeholder would ship a
 * deployment signing cookies with a value that is in the repository.
 *
 * The secret VALUES are deliberately not returned. A secret that reaches
 * a template is one template edit away from being rendered into an HTML
 * page — where it lands in the browser cache, in a pasted "view source",
 * and in every proxy log along the way. The server generates them and
 * writes them straight to disk; it never shows them. The form only needs
 * to know that they are there.
 *
 * `suggestedBaseUrl` is what the form offers when the .env still holds
 * the localhost placeholder. It only replaces the placeholder — a base
 * URL the operator has already set is never second-guessed.
 */
function readEnvState(baseUrl, suggestedBaseUrl) {
    let existing = {};
    try {
        const file = (0, dbBootstrap_1.envFilePath)();
        if (fs.existsSync(file))
            existing = (0, dbBootstrap_1.parseEnvFile)(fs.readFileSync(file, "utf8"));
    }
    catch {
        // A missing or unreadable .env is not an error here — it is exactly
        // the fresh-install case this form exists for.
        existing = {};
    }
    const sessionSecret = existing.SESSION_SECRET ?? "";
    const csrfSecret = existing.CSRF_SECRET ?? "";
    const hasSecrets = sessionSecret.trim() !== "" && csrfSecret.trim() !== "";
    const configured = existing.WEB_BASE_URL?.trim();
    // The generated placeholder is loopback. If that is all we have, the
    // operator is better served by the address they are actually using.
    const isPlaceholder = !configured ||
        /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(configured);
    const useSuggestion = isPlaceholder && suggestedBaseUrl !== undefined;
    return {
        env: {
            baseUrl: useSuggestion ? suggestedBaseUrl : configured || baseUrl,
            hasSecrets,
            // True when the value shown is our guess rather than something the
            // operator has confirmed. The view uses it to say "check the
            // scheme" — a guessed https:// on a plain-http deployment would
            // break every link the site generates.
            baseUrlSuggested: useSuggestion,
        },
    };
}
async function initRoutes(app) {
    // GET /init — landing page. No form, no CSRF required.
    app.get("/init", async (req, reply) => {
        return reply.view("init/index.hbs", {
            layout: "layouts/init",
            title: req.t("setup.welcome.title"),
            csrfToken: req.csrfToken,
            steps: buildSteps(req, 1),
            step: 1,
            total: 7,
            flash: getFlash(req, "setup.welcome.title", "setup.welcome.title"),
            req,
        });
    });
    // GET /init/env — the form that generates the .env.
    //
    // This is step 1 of the wizard and it exists so that a fresh install
    // needs no shell and no editor: unpack, start the server, open the
    // browser, and the file that holds every setting is written for you.
    //
    // The secrets are shown as empty password fields rather than as
    // generated values. A secret that has been rendered into an HTML page
    // is in the browser cache, in the "view source" the operator might
    // paste into a chat window, and in any proxy log along the way. The
    // server generates them on submit and never displays them.
    app.get("/init/env", async (req, reply) => {
        const state = readEnvState(app.cfg.web.baseUrl, suggestBaseUrl(req));
        return reply.view("init/env.hbs", {
            layout: "layouts/init",
            title: req.t("setup.env.title"),
            csrfToken: req.csrfToken,
            steps: buildSteps(req, 2),
            step: 2,
            total: 7,
            env: state.env,
            envCreated: false,
            req,
        });
    });
    // POST /init/env — write the .env.
    //
    // The base URL comes from the form; the port comes from the running
    // config; the two secrets are generated here and never shown to the
    // operator. Existing values win: an install that already has a .env
    // keeps its port, its base URL and its secrets, and only the missing
    // pieces are filled in.
    //
    // There is no port FIELD. The port the Node process listens on is an
    // internal detail whenever a reverse proxy is in front — the operator
    // never needs to type it, and the value in .env is generated. Having
    // it as a form field only invited a mistake: an operator would enter
    // the PUBLIC port (443), which is the PROXY's port, not Node's, and
    // then the two would fight over it.
    app.post("/init/env", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req)) {
            return renderCsrfError(req, reply, 1);
        }
        const body = req.body;
        const baseUrl = (body.baseUrl ?? "").trim();
        // The port is never taken from the form. If an old bookmark or a
        // stale tab still submits one, it is ignored — the running config
        // is the authority on which port this process uses.
        const port = app.cfg.api.port;
        let fieldError;
        if (baseUrl === "") {
            fieldError = req.t("setup.errors.base_url_required");
        }
        if (fieldError) {
            const state = readEnvState(app.cfg.web.baseUrl, suggestBaseUrl(req));
            return reply.code(400).view("init/env.hbs", {
                layout: "layouts/init",
                title: req.t("setup.env.title"),
                csrfToken: req.csrfToken,
                steps: buildSteps(req, 2),
                step: 2,
                total: 7,
                // Echo back what the operator typed, not what we would have
                // suggested — they are being told their input was wrong, so
                // replacing it under them would hide what they actually wrote.
                // The suggestion flag goes with it: a value that came from the
                // form is not a guess.
                env: {
                    ...state.env,
                    baseUrl: baseUrl === "" ? state.env.baseUrl : baseUrl,
                    baseUrlSuggested: false,
                },
                envCreated: false,
                error: fieldError,
                req,
            });
        }
        const result = (0, dbBootstrap_1.ensureEnvFile)({
            port,
            baseUrl,
            sessionSecret: (0, dbBootstrap_1.generateSecret)(),
            csrfSecret: (0, dbBootstrap_1.generateSecret)(),
        });
        app.log.info({ envPath: result.path, created: result.created, port, baseUrl }, "setup: the environment file was written");
        // The wizard always advances.
        //
        // This used to re-render THIS step with a "restart needed" notice
        // whenever the port differed from the boot port, and the wizard
        // dead-ended there: the operator clicked "generate and continue",
        // the page came back identical, and there was no forward path. The
        // only way out was to type the boot port back — losing the setting
        // they had just entered.
        //
        // The dead-end was a symptom of a worse mistake: the port was a
        // FORM FIELD at all. The port the Node process listens on is an
        // internal detail whenever a reverse proxy is in front, and having
        // it editable invited an operator to enter the PUBLIC port (443) —
        // which is the proxy's port, not Node's — and then have the two
        // fight over it. The port now comes from the running config and is
        // never editable here.
        //
        // There is still a case for telling the operator that the .env on
        // disk says something the running process does not: an install
        // whose .env was hand-edited before the wizard ever ran. But that
        // is not a reason to block the wizard, so the notice rides along to
        // the next step as a flash instead of a wall.
        const portChanged = port !== app.cfg.api.port;
        if (portChanged) {
            app.log.warn({ bootPort: app.cfg.api.port, requestedPort: port }, "setup: the port in the .env differs from the running port; it takes effect after a restart");
            return reply.redirect("/init/database?flash=restart");
        }
        return reply.redirect("/init/database");
    });
    // GET /init/database — show the current DB config (no password) AND a
    // form that can change it.
    //
    // This used to be a read-only page with a "test connection" button, and
    // the answer to "where do I set the password?" was "edit .env and
    // restart". That is a terrible answer for a first-run wizard whose whole
    // job is to make a first run possible: the operator has no credentials
    // yet, the service cannot start without them, and the page that would
    // tell them so is behind the service.
    //
    // So the page now collects the connection and applies it.
    app.get("/init/database", async (req, reply) => {
        return reply.view("init/database.hbs", {
            layout: "layouts/init",
            title: req.t("setup.database.title"),
            csrfToken: req.csrfToken,
            steps: buildSteps(req, 3),
            step: 3,
            total: 7,
            db: {
                host: app.cfg.db.host,
                port: app.cfg.db.port,
                user: app.cfg.db.user,
                database: app.cfg.db.database,
            },
            // True when the server came up without a database. The page says so
            // loudly, because it changes what the operator has to do: fill in
            // the form below, rather than "the connection failed, check .env".
            degraded: app.dbDegraded,
            // Whether a .env file exists yet. The hint under the form tells the
            // operator where the credentials will land — and a fresh unpack has
            // no .env at all (only .env.example), so it needs a different
            // sentence than "your .env will be updated".
            envExists: (0, dbBootstrap_1.envFileExists)(),
            flash: getFlash(req, "setup.database.success", "setup.database.failure", {
                // The port the .env now holds — what the operator asked for.
                port: readEnvPort(app),
                // The port this process is actually on. dotenv ran at import
                // time, so a changed port cannot take effect until a restart.
                bootPort: String(app.cfg.api.port),
            }),
            error: req.query.flash === "error" ? req.t("setup.database.failure") : undefined,
            req,
        });
    });
    // POST /init/database — take the connection details, prove they work,
    // apply them, and persist them.
    //
    // The order matters:
    //   1. probe FIRST — never persist credentials that do not connect.
    //      A .env that cannot connect is worse than no .env, because the
    //      next boot dies on it with no way back.
    //   2. re-point the pool — so the rest of the wizard works right now,
    //      without a restart.
    //   3. run the migrations — the new database has no schema, and steps
    //      3-6 all read tables.
    //   4. write the .env LAST — so the setting survives a restart. The
    //      password cannot live in the database (the database may be the
    //      thing that is broken) and must not live in git.
    //
    // Steps 3 and 4 are in that order deliberately: a connection can work
    // and the migration still fail (no DDL rights, conflicting schema).
    // Writing .env first would leave the next boot trying to migrate the
    // same broken database and dying on it. See the comment at step 3.
    app.post("/init/database", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req)) {
            return renderCsrfError(req, reply, 2);
        }
        const body = req.body;
        const host = (body.host ?? "").trim();
        const user = (body.user ?? "").trim();
        const database = (body.database ?? "").trim();
        const password = body.password ?? "";
        const portRaw = (body.port ?? "").trim();
        const port = portRaw === "" ? app.cfg.db.port : Number(portRaw);
        // Validate before touching anything. An empty host or user is a
        // typo, not a configuration.
        let fieldError;
        if (!host)
            fieldError = req.t("setup.errors.db_host_required");
        else if (!user)
            fieldError = req.t("setup.errors.db_user_required");
        else if (!database)
            fieldError = req.t("setup.errors.db_name_required");
        else if (!Number.isInteger(port) || port < 1 || port > 65535)
            fieldError = req.t("setup.errors.db_port_invalid");
        if (fieldError) {
            return reply.view("init/database.hbs", {
                layout: "layouts/init",
                title: req.t("setup.database.title"),
                csrfToken: req.csrfToken,
                steps: buildSteps(req, 3),
                step: 3,
                total: 7,
                db: { host, port, user, database },
                degraded: app.dbDegraded,
                envExists: (0, dbBootstrap_1.envFileExists)(),
                error: fieldError,
                req,
            });
        }
        const target = { host, port, user, password, database };
        // 1. Prove it connects. A failure here is the common case on a
        // first run, so the message says what to check.
        const probe = await (0, dbBootstrap_1.probeConnection)(target, app.cfg.db.poolSize);
        if (!probe.ok) {
            app.log.warn({ host, port, user, database, reason: probe.reason }, "setup: database probe failed");
            return reply.view("init/database.hbs", {
                layout: "layouts/init",
                title: req.t("setup.database.title"),
                csrfToken: req.csrfToken,
                steps: buildSteps(req, 3),
                step: 3,
                total: 7,
                db: { host, port, user, database },
                degraded: app.dbDegraded,
                envExists: (0, dbBootstrap_1.envFileExists)(),
                // The password is intentionally NOT echoed back into the form.
                error: req.t("setup.database.failureReason", { reason: probe.reason }),
                req,
            });
        }
        // 2. Re-point the live pool. From here on the rest of the wizard
        // works against the new database, with no restart.
        await (0, dbBootstrap_1.repointPool)(app, target);
        // 3. Bring the schema up on the new database. Steps 3-6 read
        // tables, and a fresh database has none.
        //
        // This runs BEFORE the credentials are written to .env, and the
        // order matters. A migration can still fail even though the
        // connection works — the account may lack DDL rights, or the
        // database may hold a conflicting schema. If .env already pointed
        // at that database, the NEXT boot would try to migrate it again,
        // fail the same way, and take the server down with it: the
        // operator would come back to a dead process and would have to hand
        // edit .env to recover.
        //
        // Migrating first means .env is only ever written for a database
        // that is known to work. A failure here leaves .env exactly as it
        // was, and the wizard can be retried.
        try {
            await (0, runner_1.runMigrations)(app.pool);
        }
        catch (err) {
            app.log.error({ err }, "setup: migrations failed after re-pointing the pool");
            // The pool now points at a database whose schema could not be
            // built. Keep the server in degraded mode — the wizard stays
            // reachable so the operator can correct the account or point at a
            // different database.
            app.dbDegraded = true;
            return reply.view("init/database.hbs", {
                layout: "layouts/init",
                title: req.t("setup.database.title"),
                csrfToken: req.csrfToken,
                steps: buildSteps(req, 3),
                step: 3,
                total: 7,
                db: { host, port, user, database },
                degraded: true,
                envExists: (0, dbBootstrap_1.envFileExists)(),
                error: req.t("setup.database.migrationFailed"),
                req,
            });
        }
        // 4. Persist to .env so the setting survives a restart.
        //
        // This comes AFTER the migration, deliberately — see step 3. The
        // database is now known to work, so the credentials on disk cannot
        // be the reason the next boot fails.
        const envPath = (0, dbBootstrap_1.writeDbCredentialsToEnv)(target);
        app.log.info({ envPath, host, port, user, database }, "setup: database credentials written to .env");
        // The database now works — lift the degraded gate so the rest of the
        // application is reachable.
        //
        // The setup guard is already installed (it has to be: Fastify refuses
        // to add a decorator or a hook after the server has started). What
        // the degraded boot could not do was read the initialization state —
        // and it did not need to: an install whose database could not be
        // reached has not been initialized, so the wizard is open and
        // `requireSetup` is already true.
        //
        // Flipping `dbDegraded` is what opens the rest of the application:
        // the gate in src/web/plugins/degradedGate.ts sends everything that is not the
        // wizard to a 503 until this flag is false.
        app.dbDegraded = false;
        // The random-IP runner reads its settings from the database, which
        // was not available at boot. Now it is.
        await app.randomGenRunner.syncFromSettings().catch((err) => {
            app.log.warn({ err }, "setup: random-generator sync failed after connecting");
        });
        // The ETL schedule could not be armed at boot — there was no database
        // to run an ETL against. Now there is. Arming it here is what makes
        // the daily ETL run on a server that was installed without a database,
        // with no restart in between.
        app.startEtlScheduler();
        return reply.code(302).header("Location", "/init/site?flash=success").send();
    });
    // GET /init/site — site name + tagline form.
    app.get("/init/site", async (req, reply) => {
        // The site name lives in the database, so this page needs one. The
        // wizard is allowed through the degraded gate even without a database
        // (that is how the operator reaches step 3 in the first place), so
        // this page can be asked for before step 3 has run. Answering 500
        // there tells the operator nothing; an empty form with a note that
        // the database is not connected yet tells them what to do.
        const [siteName, siteTagline] = await Promise.all([
            (0, settings_1.getSetting)(app.pool, "site.name").catch(() => null),
            (0, settings_1.getSetting)(app.pool, "site.tagline").catch(() => null),
        ]);
        return reply.view("init/site.hbs", {
            layout: "layouts/init",
            title: req.t("setup.site.title"),
            csrfToken: req.csrfToken,
            steps: buildSteps(req, 4),
            step: 4,
            total: 7,
            siteName: siteName ?? "",
            siteTagline: siteTagline ?? "",
            flash: getFlash(req, "setup.site.success", "setup.site.error"),
            error: req.query.flash === "error" ? req.t("setup.site.error") : undefined,
            req,
        });
    });
    // POST /init/site — save site.name and site.tagline.
    app.post("/init/site", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req)) {
            return renderCsrfError(req, reply, 3);
        }
        const body = req.body;
        const name = (body.name ?? "").trim();
        const tagline = (body.tagline ?? "").trim();
        // On validation failure, re-render the form directly (200) with the
        // user's input preserved — better UX than redirect+flash+empty form.
        let fieldError;
        if (!name)
            fieldError = req.t("setup.errors.site_name_required");
        else if (name.length > SITE_NAME_MAX || tagline.length > TAGLINE_MAX)
            fieldError = req.t("setup.site.error");
        if (fieldError) {
            return reply.view("init/site.hbs", {
                layout: "layouts/init",
                title: req.t("setup.site.title"),
                csrfToken: req.csrfToken,
                steps: buildSteps(req, 4),
                step: 4,
                total: 7,
                siteName: name,
                siteTagline: tagline,
                error: fieldError,
                req,
            });
        }
        await (0, settings_1.setSetting)(app.pool, "site.name", name);
        await (0, settings_1.setSetting)(app.pool, "site.tagline", tagline);
        return reply.code(302).header("Location", "/init/admin?flash=success").send();
    });
    // GET /init/admin — admin bootstrap form.
    app.get("/init/admin", async (req, reply) => {
        return reply.view("init/admin.hbs", {
            layout: "layouts/init",
            title: req.t("setup.admin.title"),
            csrfToken: req.csrfToken,
            steps: buildSteps(req, 5),
            step: 5,
            total: 7,
            flash: getFlash(req, "setup.admin.success", "setup.admin.error"),
            req,
        });
    });
    // POST /init/admin — bootstrap admin via bootstrapAdmin().
    app.post("/init/admin", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req)) {
            return renderCsrfError(req, reply, 4);
        }
        const body = req.body;
        const email = (body.email ?? "").trim().toLowerCase();
        const password = body.password ?? "";
        const displayName = (body.displayName ?? "").trim();
        // On validation failure, re-render the form directly (200) with email
        // and displayName preserved (password is intentionally NOT echoed back).
        let fieldError;
        if (!EMAIL_RE.test(email))
            fieldError = req.t("setup.errors.email_invalid");
        else if (!displayName || displayName.length > 64)
            fieldError = req.t("setup.errors.displayName_invalid");
        else {
            try {
                await (0, bootstrap_1.bootstrapAdmin)(app.pool, { email, password, displayName });
            }
            catch {
                fieldError = req.t("setup.errors.password_weak");
            }
        }
        if (fieldError) {
            return reply.view("init/admin.hbs", {
                layout: "layouts/init",
                title: req.t("setup.admin.title"),
                csrfToken: req.csrfToken,
                steps: buildSteps(req, 5),
                step: 5,
                total: 7,
                email,
                displayName,
                error: fieldError,
                req,
            });
        }
        return reply.code(302).header("Location", "/init/seed?flash=success").send();
    });
    // GET /init/seed — three-mode form OR progress view if an ETL is running.
    //
    // Modes:
    //   demo  — load the 50 hand-picked seed rows from migration 012 (instant)
    //   etl   — trigger a real DB-IP ETL run; page renders progress until done
    //   skip  — leave ip_ranges empty; cron will pick it up later
    app.get("/init/seed", async (req, reply) => {
        // Same reasoning as /init/site: the wizard is reachable before the
        // database is configured, so this page has to survive a pool that
        // cannot answer. "No run yet" is the honest answer in that case —
        // there is genuinely no ETL run, because no ETL could have started.
        const [latest, etlSetting] = await Promise.all([
            readLatestRun(app.pool).catch(() => null),
            (0, settings_1.getSetting)(app.pool, "etl.setup.inProgress").catch(() => null),
        ]);
        const inProgress = latest?.status === "running";
        // While a background ETL is in flight, render the progress page and let
        // it auto-refresh until the run finishes.
        if (inProgress || etlSetting === "true") {
            return reply.view("init/seed.hbs", {
                layout: "layouts/init",
                title: req.t("setup.seed.title"),
                csrfToken: req.csrfToken,
                steps: buildSteps(req, 6),
                step: 6,
                total: 7,
                progress: {
                    run: latest,
                    // Pre-row state: a click happened but recordEtlStart hasn't been
                    // observed yet (sub-second window). Show "starting…" instead of a
                    // blank spinner.
                    starting: !latest,
                },
                req,
            });
        }
        return reply.view("init/seed.hbs", {
            layout: "layouts/init",
            title: req.t("setup.seed.title"),
            csrfToken: req.csrfToken,
            steps: buildSteps(req, 6),
            step: 6,
            total: 7,
            flash: getFlash(req, "setup.seed.success", "setup.seed.skipped"),
            req,
        });
    });
    // POST /init/seed — three modes: demo (instant), etl (background), skip.
    // Accepts both `mode=demo|etl|skip` (new) and legacy `load=true|false` for
    // backwards compat with the existing test suite.
    app.post("/init/seed", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req)) {
            return renderCsrfError(req, reply, 5);
        }
        const body = req.body;
        await (0, runner_1.runMigrations)(app.pool);
        const mode = body.mode ?? (body.load === "true" ? "demo" : body.load === "false" ? "skip" : undefined);
        if (mode === "demo") {
            // Load the 50 demo rows for real. This used to only set a flag,
            // because migration 012 had already inserted them during
            // `migrate` — which meant "skip the demo data" never actually
            // skipped anything. Now the rows only exist if they were asked
            // for.
            await (0, demoSeed_1.loadDemoSeed)(app.pool);
            await (0, settings_1.setSetting)(app.pool, "seed.loaded", "true");
            return reply.code(302).header("Location", "/init/complete?flash=success").send();
        }
        if (mode === "skip") {
            await (0, settings_1.setSetting)(app.pool, "seed.loaded", "false");
            return reply.code(302).header("Location", "/init/complete?flash=success").send();
        }
        if (mode === "etl") {
            const started = await startBackgroundEtl(app);
            if ("busy" in started) {
                // Another ETL is already running; just send the user to the progress
                // page where they'll see the existing run.
                return reply.code(302).header("Location", "/init/seed").send();
            }
            return reply.code(302).header("Location", `/init/seed?runId=${started.runId}`).send();
        }
        if (mode === "etl-done") {
            // Confirmation step after the background ETL finished. Persist the
            // flag and proceed to /init/complete. Distinct from `etl` so a
            // double-submit can't re-trigger the pipeline.
            await (0, settings_1.setSetting)(app.pool, "seed.loaded", "true");
            return reply.code(302).header("Location", "/init/complete?flash=success").send();
        }
        // Unknown mode — re-render the form with a generic error.
        return reply.view("init/seed.hbs", {
            layout: "layouts/init",
            title: req.t("setup.seed.title"),
            csrfToken: req.csrfToken,
            steps: buildSteps(req, 6),
            step: 6,
            total: 7,
            error: req.t("setup.seed.invalidMode"),
            req,
        });
    });
    // GET /init/complete — summary page.
    app.get("/init/complete", async (req, reply) => {
        // The summary reads the database, so it has to survive a pool that
        // cannot answer. The wizard is reachable before the database is
        // configured; showing an empty summary is honest, showing a 500 is
        // just noise.
        const [siteName, seedLoaded] = await Promise.all([
            (0, settings_1.getSetting)(app.pool, "site.name").catch(() => null),
            (0, settings_1.getSetting)(app.pool, "seed.loaded").catch(() => null),
        ]);
        // The admin email isn't in settings (it lives in users.email). For the
        // summary we look it up from the users table — bootstrapAdmin always
        // created exactly one admin row at this point.
        const adminEmail = await app.pool
            .query(`SELECT email FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`)
            .then(([rows]) => rows[0]?.email ?? "")
            .catch(() => "");
        return reply.view("init/complete.hbs", {
            layout: "layouts/init",
            title: req.t("setup.complete.title"),
            csrfToken: req.csrfToken,
            steps: buildSteps(req, 7),
            step: 7,
            total: 7,
            summary: {
                siteName: siteName ?? "",
                adminEmail,
                seedLoaded: seedLoaded === "true",
            },
            flash: getFlash(req, "setup.complete.success", "setup.complete.success"),
            req,
        });
    });
    // POST /init/complete — flip initialized_at; guard re-reads it onResponse.
    app.post("/init/complete", async (req, reply) => {
        if (!(0, csrf_1.verifyCsrfRequest)(req)) {
            return renderCsrfError(req, reply, 6);
        }
        await (0, settings_1.markInitialized)(app.pool);
        return reply.code(302).header("Location", "/login?flash=success").send();
    });
}
//# sourceMappingURL=init.js.map