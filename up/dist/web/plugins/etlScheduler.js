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
    const start = () => {
        if (task)
            return; // already armed
        const cfg = app.cfg;
        task = cron.schedule(cfg.etl.schedule, async () => {
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
        }, { timezone: cfg.etl.timezone });
        app.log.info({ schedule: cfg.etl.schedule, timezone: cfg.etl.timezone }, "ETL schedule armed");
    };
    const stop = () => {
        if (!task)
            return;
        task.stop();
        task = null;
        app.log.info("ETL schedule disarmed");
    };
    app.decorate("startEtlScheduler", start);
    app.decorate("stopEtlScheduler", stop);
}
//# sourceMappingURL=etlScheduler.js.map