// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { RowDataPacket } from "mysql2";
import * as path from "node:path";
import { verifyCsrfRequest } from "../plugins/csrf";
import { setSetting, getSetting, markInitialized } from "../../storage/settings";
import { bootstrapAdmin } from "../admin/bootstrap";
import { runMigrations } from "../../storage/migrations/runner";
import { loadDemoSeed } from "../../storage/seed/demoSeed";
import { runPipeline } from "../../etl/pipeline";
import { findRunningEtlRun } from "../../etl/runGuard";
import { recordEtlStart } from "../../storage/mysql";
import { downloadAll, DEFAULT_SPECS } from "../../etl/download";

const SITE_NAME_MAX = 128;
const TAGLINE_MAX = 256;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Build the 6-step boot-log indicator. Labels are pre-translated here (Phase B
// Task 6 finding: avoid {{req.t '...'}} inside {{#each}}). `done` marks every
// step before the current one so the rail can show [ok] and filled ticks.
function buildSteps(
  req: FastifyRequest,
  current: number,
): Array<{ n: number; label: string; href: string; active: boolean; done: boolean }> {
  const steps: Array<[string, string]> = [
    [req.t("setup.steps.1"), "/init"],
    [req.t("setup.steps.2"), "/init/database"],
    [req.t("setup.steps.3"), "/init/site"],
    [req.t("setup.steps.4"), "/init/admin"],
    [req.t("setup.steps.5"), "/init/seed"],
    [req.t("setup.steps.6"), "/init/complete"],
  ];
  return steps.map(([label, href], index) => {
    const n = index + 1;
    return { n, label, href, active: n === current, done: n < current };
  });
}

// Every CSRF failure still renders inside the boot console. Give the layout
// the same rail/step/total data its GET page uses so a 403 never shows an
// empty step list or a broken progress line.
function renderCsrfError(req: FastifyRequest, reply: FastifyReply, step: number) {
  return reply.code(403).view("errors/csrf.hbs", {
    layout: "layouts/init",
    title: req.t("error.csrf.title"),
    csrfToken: req.csrfToken,
    steps: buildSteps(req, step),
    step,
    total: 6,
    req,
  });
}

// Map ?flash=success|error on redirect to a flash object whose message is the
// translated text for the route-specific key. Returns undefined if no flash.
function getFlash(
  req: FastifyRequest,
  successKey: string,
  errorKey: string,
): { success?: string; error?: string } {
  const q = req.query as { flash?: string };
  const kind = q.flash;
  if (kind === "success") return { success: req.t(successKey) };
  if (kind === "error") return { error: req.t(errorKey) };
  return {};
}

interface EtlRunLite {
  id: number;
  status: "running" | "success" | "failed";
  startedAt: Date;
  finishedAt: Date | null;
  mergedRecords: number | null;
  errorMessage: string | null;
}

// Read the most recent ETL run row (any status). Returns null if the table is
// empty (i.e. the wizard has never triggered an ETL during this install).
async function readLatestRun(pool: import("mysql2/promise").Pool): Promise<EtlRunLite | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, status, started_at, finished_at, merged_records, error_message
       FROM etl_runs ORDER BY id DESC LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    status: r.status as EtlRunLite["status"],
    startedAt: r.started_at as Date,
    finishedAt: (r.finished_at as Date | null) ?? null,
    mergedRecords: r.merged_records == null ? null : Number(r.merged_records),
    errorMessage: (r.error_message as string | null) ?? null,
  };
}

// Spawn a background ETL run for the wizard. The wizard's POST handler calls
// this and redirects immediately; the progress page polls /init/seed while
// a `running` row exists in etl_runs.
//
// Guarded: refuses to start if another ETL is already in progress (etl_runs
// row with status='running'). Without this guard, double-clicking submit
// would spawn two pipelines that race on truncateNew + atomicSwapRanges.
async function startBackgroundEtl(app: FastifyInstance): Promise<{ runId: number } | { busy: true }> {
  // Shared guard: refuses to start if another ETL is already in progress
  // (an etl_runs row with status='running'). Without this guard,
  // double-clicking submit would spawn two pipelines that race on
  // truncateNew + atomicSwapRanges.
  const runningRunId = await findRunningEtlRun(app.pool);
  if (runningRunId !== null) return { busy: true };

  // Pre-create the run row so the progress page can find it the instant the
  // client lands on /init/seed after the redirect.
  const runId = await recordEtlStart(app.pool);
  await setSetting(app.pool, "etl.setup.inProgress", "true");

  // Fire-and-forget. The setup wizard should NEVER block on this — full
  // DB-IP city-lite ingest takes 5-15 minutes. setImmediate moves the task
  // out of the current microtask so the response handler returns first.
  setImmediate(() => {
    void (async (): Promise<void> => {
      try {
        // Step 1: download DB-IP free CSVs (best-effort per file; failures
        // don't throw, they're returned in `failures`).
        const outDir = path.join(app.cfg.etl.dataDir, "raw");
        const dl = await downloadAll(DEFAULT_SPECS, outDir);
        app.log.info(
          { results: dl.results.length, failures: dl.failures.length, runId },
          "setup: DB-IP download complete",
        );

        // Step 2: run the pipeline against the freshly-downloaded files.
        // runPipeline creates its own pool and ends it — fine, the web server
        // keeps using app.pool. It updates the pre-created runId row.
        await runPipeline({ cfg: app.cfg, runId });
      } catch (err) {
        app.log.error({ err, runId }, "setup: background ETL failed");
      } finally {
        await setSetting(app.pool, "etl.setup.inProgress", "false").catch(() => undefined);
      }
    })();
  });

  return { runId };
}

export default async function initRoutes(app: FastifyInstance): Promise<void> {
  // GET /init — landing page. No form, no CSRF required.
  app.get("/init", async (req, reply) => {
    return reply.view("init/index.hbs", {
      layout: "layouts/init",
      title: req.t("setup.welcome.title"),
      csrfToken: req.csrfToken,
      steps: buildSteps(req, 1),
      step: 1,
      total: 6,
      flash: getFlash(req, "setup.welcome.title", "setup.welcome.title"),
      req,
    });
  });

  // GET /init/database — show current DB config (no password) + Test form.
  app.get("/init/database", async (req, reply) => {
    return reply.view("init/database.hbs", {
      layout: "layouts/init",
      title: req.t("setup.database.title"),
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
      flash: getFlash(req, "setup.database.success", "setup.database.failure"),
      error:
        (req.query as { flash?: string }).flash === "error" ? req.t("setup.database.failure") : undefined,
      req,
    });
  });

  // POST /init/database — probe app.pool. On success → /init/site.
  app.post("/init/database", async (req, reply) => {
    if (!verifyCsrfRequest(req)) {
      return renderCsrfError(req, reply, 2);
    }
    let conn;
    try {
      conn = await app.pool.getConnection();
      await conn.ping();
    } catch (err) {
      // Sanitize: do not echo a raw mysql error string (could leak DSN/hints).
      return reply.code(302).header("Location", "/init/database?flash=error").send();
    } finally {
      if (conn) {
        try {
          conn.release();
        } catch {
          /* ignore */
        }
      }
    }
    return reply.code(302).header("Location", "/init/site?flash=success").send();
  });

  // GET /init/site — site name + tagline form.
  app.get("/init/site", async (req, reply) => {
    const [siteName, siteTagline] = await Promise.all([
      getSetting(app.pool, "site.name"),
      getSetting(app.pool, "site.tagline"),
    ]);
    return reply.view("init/site.hbs", {
      layout: "layouts/init",
      title: req.t("setup.site.title"),
      csrfToken: req.csrfToken,
      steps: buildSteps(req, 3),
      step: 3,
      total: 6,
      siteName: siteName ?? "",
      siteTagline: siteTagline ?? "",
      flash: getFlash(req, "setup.site.success", "setup.site.error"),
      error: (req.query as { flash?: string }).flash === "error" ? req.t("setup.site.error") : undefined,
      req,
    });
  });

  // POST /init/site — save site.name and site.tagline.
  app.post("/init/site", async (req, reply) => {
    if (!verifyCsrfRequest(req)) {
      return renderCsrfError(req, reply, 3);
    }
    const body = req.body as { name?: string; tagline?: string };
    const name = (body.name ?? "").trim();
    const tagline = (body.tagline ?? "").trim();

    // On validation failure, re-render the form directly (200) with the
    // user's input preserved — better UX than redirect+flash+empty form.
    let fieldError: string | undefined;
    if (!name) fieldError = req.t("setup.errors.site_name_required");
    else if (name.length > SITE_NAME_MAX || tagline.length > TAGLINE_MAX)
      fieldError = req.t("setup.site.error");
    if (fieldError) {
      return reply.view("init/site.hbs", {
        layout: "layouts/init",
        title: req.t("setup.site.title"),
        csrfToken: req.csrfToken,
        steps: buildSteps(req, 3),
        step: 3,
        total: 6,
        siteName: name,
        siteTagline: tagline,
        error: fieldError,
        req,
      });
    }
    await setSetting(app.pool, "site.name", name);
    await setSetting(app.pool, "site.tagline", tagline);
    return reply.code(302).header("Location", "/init/admin?flash=success").send();
  });

  // GET /init/admin — admin bootstrap form.
  app.get("/init/admin", async (req, reply) => {
    return reply.view("init/admin.hbs", {
      layout: "layouts/init",
      title: req.t("setup.admin.title"),
      csrfToken: req.csrfToken,
      steps: buildSteps(req, 4),
      step: 4,
      total: 6,
      flash: getFlash(req, "setup.admin.success", "setup.admin.error"),
      req,
    });
  });

  // POST /init/admin — bootstrap admin via bootstrapAdmin().
  app.post("/init/admin", async (req, reply) => {
    if (!verifyCsrfRequest(req)) {
      return renderCsrfError(req, reply, 4);
    }
    const body = req.body as { email?: string; password?: string; displayName?: string };
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    const displayName = (body.displayName ?? "").trim();

    // On validation failure, re-render the form directly (200) with email
    // and displayName preserved (password is intentionally NOT echoed back).
    let fieldError: string | undefined;
    if (!EMAIL_RE.test(email)) fieldError = req.t("setup.errors.email_invalid");
    else if (!displayName || displayName.length > 64) fieldError = req.t("setup.errors.displayName_invalid");
    else {
      try {
        await bootstrapAdmin(app.pool, { email, password, displayName });
      } catch {
        fieldError = req.t("setup.errors.password_weak");
      }
    }
    if (fieldError) {
      return reply.view("init/admin.hbs", {
        layout: "layouts/init",
        title: req.t("setup.admin.title"),
        csrfToken: req.csrfToken,
        steps: buildSteps(req, 4),
        step: 4,
        total: 6,
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
    const latest = await readLatestRun(app.pool);
    const inProgress = latest?.status === "running";
    const etlSetting = await getSetting(app.pool, "etl.setup.inProgress");

    // While a background ETL is in flight, render the progress page and let
    // it auto-refresh until the run finishes.
    if (inProgress || etlSetting === "true") {
      return reply.view("init/seed.hbs", {
        layout: "layouts/init",
        title: req.t("setup.seed.title"),
        csrfToken: req.csrfToken,
        steps: buildSteps(req, 5),
        step: 5,
        total: 6,
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
      steps: buildSteps(req, 5),
      step: 5,
      total: 6,
      flash: getFlash(req, "setup.seed.success", "setup.seed.skipped"),
      req,
    });
  });

  // POST /init/seed — three modes: demo (instant), etl (background), skip.
  // Accepts both `mode=demo|etl|skip` (new) and legacy `load=true|false` for
  // backwards compat with the existing test suite.
  app.post("/init/seed", async (req, reply) => {
    if (!verifyCsrfRequest(req)) {
      return renderCsrfError(req, reply, 5);
    }
    const body = req.body as { mode?: string; load?: string };
    await runMigrations(app.pool);

    const mode = body.mode ?? (body.load === "true" ? "demo" : body.load === "false" ? "skip" : undefined);

    if (mode === "demo") {
      // Load the 50 demo rows for real. This used to only set a flag,
      // because migration 012 had already inserted them during
      // `migrate` — which meant "skip the demo data" never actually
      // skipped anything. Now the rows only exist if they were asked
      // for.
      await loadDemoSeed(app.pool);
      await setSetting(app.pool, "seed.loaded", "true");
      return reply.code(302).header("Location", "/init/complete?flash=success").send();
    }

    if (mode === "skip") {
      await setSetting(app.pool, "seed.loaded", "false");
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
      await setSetting(app.pool, "seed.loaded", "true");
      return reply.code(302).header("Location", "/init/complete?flash=success").send();
    }

    // Unknown mode — re-render the form with a generic error.
    return reply.view("init/seed.hbs", {
      layout: "layouts/init",
      title: req.t("setup.seed.title"),
      csrfToken: req.csrfToken,
      steps: buildSteps(req, 5),
      step: 5,
      total: 6,
      error: req.t("setup.seed.invalidMode"),
      req,
    });
  });

  // GET /init/complete — summary page.
  app.get("/init/complete", async (req, reply) => {
    const [siteName, seedLoaded] = await Promise.all([
      getSetting(app.pool, "site.name"),
      getSetting(app.pool, "seed.loaded"),
    ]);
    // The admin email isn't in settings (it lives in users.email). For the
    // summary we look it up from the users table — bootstrapAdmin always
    // created exactly one admin row at this point.
    const [rows] = await app.pool.query<import("mysql2").RowDataPacket[]>(
      `SELECT email FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`,
    );
    const adminEmail = (rows[0] as { email?: string } | undefined)?.email ?? "";
    return reply.view("init/complete.hbs", {
      layout: "layouts/init",
      title: req.t("setup.complete.title"),
      csrfToken: req.csrfToken,
      steps: buildSteps(req, 6),
      step: 6,
      total: 6,
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
    if (!verifyCsrfRequest(req)) {
      return renderCsrfError(req, reply, 6);
    }
    await markInitialized(app.pool);
    return reply.code(302).header("Location", "/login?flash=success").send();
  });
}
