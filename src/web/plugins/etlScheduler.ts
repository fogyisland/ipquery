// SPDX-License-Identifier: MIT
//
// The ETL schedule, owned by the server.
//
// Why this is a plugin and not a few lines in the CLI: the schedule has
// to be ARMED AFTER the wizard has configured the database, not only at
// boot. A server that came up in degraded mode has no database to talk to,
// so it cannot start an ETL timer — and when the operator fills in the
// connection at step 2 of the wizard, the timer has to start then, without
// a restart.
//
// Putting the schedule in the CLI made that impossible: the CLI armed the
// cron before it knew whether the database was up, so the two cases were
// mutually exclusive — either the cron fires against a dead pool, or it
// never fires at all. This plugin is armed from the same place that
// decides the database is usable, so the two cannot drift.

import type { FastifyInstance } from "fastify";
import * as cron from "node-cron";
import type { AppConfig } from "../../config";
import { runPipeline } from "../../etl/pipeline";
import { EtlRunLockedError } from "../../etl/runGuard";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Arm the ETL schedule. Idempotent — calling it twice does not create
     * two timers.
     */
    startEtlScheduler: () => void;
    /**
     * Disarm the ETL schedule. Used when the database goes away.
     */
    stopEtlScheduler: () => void;
  }
}

/**
 * Register the ETL scheduler.
 *
 * The scheduler is NOT started here. The caller decides when it is
 * appropriate — `buildServer` starts it once the migrations have run
 * (i.e. the database is real), and the setup wizard starts it after it
 * has re-pointed the pool at a working database.
 */
export function registerEtlScheduler(app: FastifyInstance): void {
  let task: cron.ScheduledTask | null = null;

  const start = (): void => {
    if (task) return; // already armed
    const cfg = app.cfg;
    task = cron.schedule(
      cfg.etl.schedule,
      async () => {
        app.log.info("cron: triggering ETL");
        try {
          await runPipeline({ cfg });
        } catch (err) {
          // A lock refusal is expected, not an error: the previous run is
          // simply still going. Say so, rather than logging it as a
          // failure that an operator has to investigate.
          if (err instanceof EtlRunLockedError) {
            app.log.info({ msg: err.message }, "cron: ETL skipped — another run holds the lock");
          } else {
            app.log.error({ err }, "cron: ETL failed");
          }
        }
      },
      { timezone: cfg.etl.timezone },
    );
    app.log.info({ schedule: cfg.etl.schedule, timezone: cfg.etl.timezone }, "ETL schedule armed");
  };

  const stop = (): void => {
    if (!task) return;
    task.stop();
    task = null;
    app.log.info("ETL schedule disarmed");
  };

  app.decorate("startEtlScheduler", start);
  app.decorate("stopEtlScheduler", stop);
}
