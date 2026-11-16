"use strict";
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
exports.registerEtlScheduler = registerEtlScheduler;
const cron = __importStar(require("node-cron"));
const pipeline_1 = require("../../etl/pipeline");
const runGuard_1 = require("../../etl/runGuard");
const etlSchedule_1 = require("../../storage/etlSchedule");
/**
 * Register the ETL scheduler.
 *
 * The scheduler is NOT started here. The caller decides when it is
 * appropriate — `buildServer` starts it once the migrations have run
 * (i.e. the database is real), and the setup wizard starts it after it
 * has re-pointed the pool at a working database.
 */
function registerEtlScheduler(app) {
    let task = null;
    // The expression the live timer was armed with. Kept so `start()` can be
    // a no-op when nothing changed, and so the log line names the schedule
    // that is actually running rather than the one in the config file.
    let armedConfig = null;
    /** Resolve the schedule the operator wants right now. The env vars in
     *  `app.cfg.etl` are only the seed for a fresh install; a saved setting
     *  wins. Reading at arm time (rather than capturing at register time)
     *  is what lets a console save take effect on the next resync. */
    const resolveSchedule = async () => {
        try {
            const cfg = await (0, etlSchedule_1.loadEtlScheduleConfig)(app.pool, {
                schedule: app.cfg.etl.schedule,
                timezone: app.cfg.etl.timezone,
            });
            if (cfg.warning)
                app.log.warn({ warning: cfg.warning }, "ETL schedule fell back");
            return { schedule: cfg.schedule, timezone: cfg.timezone, warning: cfg.warning };
        }
        catch (err) {
            // The settings table may not exist yet on a degraded boot. Falling
            // back to the env value keeps the schedule armed either way.
            app.log.warn({ err }, "could not read the saved ETL schedule; using the env seed");
            return {
                schedule: app.cfg.etl.schedule,
                timezone: app.cfg.etl.timezone,
                warning: null,
            };
        }
    };
    const start = () => {
        // Arming is now async (the schedule comes from the database), but the
        // decorated signature stays synchronous so the existing call sites —
        // buildServer and the setup wizard — keep working. The timer is armed
        // as soon as the read resolves; a run that fires before then is
        // impossible, since cron needs the expression first.
        void (async () => {
            if (task)
                return; // already armed
            const resolved = await resolveSchedule();
            if (task)
                return; // a concurrent start() won the race
            const cfg = app.cfg;
            armedConfig = { schedule: resolved.schedule, timezone: resolved.timezone };
            task = cron.schedule(resolved.schedule, async () => {
                app.log.info("cron: triggering ETL");
                try {
                    await (0, pipeline_1.runPipeline)({ cfg });
                }
                catch (err) {
                    // A lock refusal is expected, not an error: the previous run is
                    // simply still going. Say so, rather than logging it as a
                    // failure that an operator has to investigate.
                    if (err instanceof runGuard_1.EtlRunLockedError) {
                        app.log.info({ msg: err.message }, "cron: ETL skipped — another run holds the lock");
                    }
                    else {
                        app.log.error({ err }, "cron: ETL failed");
                    }
                }
            }, { timezone: resolved.timezone });
            app.log.info({ schedule: resolved.schedule, timezone: resolved.timezone }, "ETL schedule armed");
        })();
    };
    const stop = () => {
        if (!task)
            return;
        task.stop();
        task = null;
        armedConfig = null;
        app.log.info("ETL schedule disarmed");
    };
    /** Read the saved schedule and re-arm the timer to match it. An
     *  operator changing the cadence from the console expects it to take
     *  effect immediately, not at the next restart. */
    const resync = async () => {
        const wasArmed = task !== null;
        const resolved = await resolveSchedule();
        const changed = armedConfig === null ||
            armedConfig.schedule !== resolved.schedule ||
            armedConfig.timezone !== resolved.timezone;
        if (!changed)
            return resolved;
        if (wasArmed)
            stop();
        start();
        app.log.info({ schedule: resolved.schedule, timezone: resolved.timezone }, "ETL schedule resynced");
        return resolved;
    };
    app.decorate("startEtlScheduler", start);
    app.decorate("stopEtlScheduler", stop);
    app.decorate("resyncEtlScheduler", resync);
}
//# sourceMappingURL=etlScheduler.js.map