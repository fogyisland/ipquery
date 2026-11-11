#!/usr/bin/env node
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
// SPDX-License-Identifier: MIT
const commander_1 = require("commander");
const cron = __importStar(require("node-cron"));
const config_1 = require("./config");
const pipeline_1 = require("./etl/pipeline");
const runGuard_1 = require("./etl/runGuard");
const server_1 = require("./api/server");
const mysql_1 = require("./storage/mysql");
const runner_1 = require("./storage/migrations/runner");
const demoSeed_1 = require("./storage/seed/demoSeed");
const bootstrap_1 = require("./web/admin/bootstrap");
const settings_1 = require("./storage/settings");
const users_1 = require("./storage/users");
const download_1 = require("./etl/download");
const program = new commander_1.Command();
program.name("ipq").description("IP geolocation aggregator").version("0.1.0");
program
    .command("update")
    .description("Run ETL pipeline once and exit")
    .action(async () => {
    const cfg = (0, config_1.loadConfig)();
    console.log((0, config_1.configSummary)(cfg));
    try {
        await (0, pipeline_1.runPipeline)({ cfg });
    }
    catch (e) {
        // A lock refusal means another ETL is already running. Exit 0 —
        // this is not a failure of the command, and a cron-style caller
        // should not treat it as one.
        if (e instanceof runGuard_1.EtlRunLockedError) {
            console.log(`[update] ETL skipped: ${e.message}`);
            return;
        }
        throw e;
    }
});
program
    .command("serve")
    .description("Start HTTP API server (runs ETL on schedule)")
    .option("--once", "Run one ETL pass before serving")
    .action(async (opts) => {
    const cfg = (0, config_1.loadConfig)();
    console.log((0, config_1.configSummary)(cfg));
    if (opts.once) {
        try {
            await (0, pipeline_1.runPipeline)({ cfg });
        }
        catch (e) {
            console.error("initial ETL failed (continuing to serve):", e);
        }
    }
    cron.schedule(cfg.etl.schedule, async () => {
        console.log("[cron] triggering ETL");
        try {
            await (0, pipeline_1.runPipeline)({ cfg });
        }
        catch (e) {
            // A lock refusal is expected, not an error: the previous run is
            // simply still going. Say so, rather than logging it as a
            // failure that an operator has to investigate.
            if (e instanceof runGuard_1.EtlRunLockedError) {
                console.log(`[cron] ETL skipped: ${e.message}`);
            }
            else {
                console.error("[cron] ETL failed:", e);
            }
        }
    }, { timezone: cfg.etl.timezone });
    const app = await (0, server_1.buildServer)(cfg);
    await app.listen({ port: cfg.api.port, host: "0.0.0.0" });
    console.log(`[api] listening on :${cfg.api.port}`);
});
program
    .command("status")
    .description("Show last ETL run status")
    .action(async () => {
    const cfg = (0, config_1.loadConfig)();
    const pool = (0, mysql_1.createPool)(cfg);
    try {
        const last = await (0, mysql_1.lastEtlRun)(pool);
        if (!last) {
            console.log("No ETL runs recorded.");
            return;
        }
        console.log(JSON.stringify(last, null, 2));
    }
    finally {
        await pool.end();
    }
});
program
    .command("migrate")
    .description("Apply pending database migrations")
    .action(async () => {
    const cfg = (0, config_1.loadConfig)();
    const pool = (0, mysql_1.createPool)(cfg);
    try {
        const result = await (0, runner_1.runMigrations)(pool);
        if (result.applied.length === 0) {
            console.log("database already up to date");
        }
        else {
            console.log(`applied ${result.applied.length} migration(s)`);
        }
    }
    finally {
        await pool.end();
    }
});
program
    .command("migrate:status")
    .description("Show migration status (applied vs pending)")
    .action(async () => {
    const cfg = (0, config_1.loadConfig)();
    const pool = (0, mysql_1.createPool)(cfg);
    try {
        const s = await (0, runner_1.migrationStatus)(pool);
        const files = await (0, runner_1.listMigrationFiles)();
        const labelOf = (version) => files.find((f) => f.startsWith(version)) ?? version;
        const applied = [...s.applied].sort();
        const pending = [...s.pending].sort();
        for (const v of applied)
            console.log(`${labelOf(v).padEnd(28)} applied`);
        for (const v of pending)
            console.log(`${labelOf(v).padEnd(28)} pending`);
    }
    finally {
        await pool.end();
    }
});
program
    .command("seed:demo")
    .description("Load 50 demo IP ranges (development only — production should run `update` to load the real library)")
    .action(async () => {
    const cfg = (0, config_1.loadConfig)();
    const pool = (0, mysql_1.createPool)(cfg);
    try {
        // The demo rows live in a plain .sql file next to the migrations,
        // not in a migration: a production database must never end up
        // with them by accident.
        await (0, runner_1.runMigrations)(pool);
        const result = await (0, demoSeed_1.loadDemoSeed)(pool);
        console.log(`[seed:demo] ${result.total} demo rows present (${result.added} newly added)`);
    }
    finally {
        await pool.end();
    }
});
program
    .command("create-admin")
    .description("Create or promote an admin user (idempotent)")
    .requiredOption("--email <email>")
    .requiredOption("--password <password>")
    .option("--name <name>")
    .action(async (opts) => {
    const cfg = (0, config_1.loadConfig)();
    const pool = (0, mysql_1.createPool)(cfg);
    try {
        const r = await (0, bootstrap_1.bootstrapAdmin)(pool, {
            email: opts.email,
            password: opts.password,
            displayName: opts.name,
        });
        console.log(`admin user ready: ${opts.email} (id=${r.id})`);
    }
    finally {
        await pool.end();
    }
});
program
    .command("init")
    .description("Non-interactive first-run bootstrap: migrate, seed (optional), create admin, mark initialized")
    .requiredOption("--email <email>", "admin email")
    .requiredOption("--password <password>", "admin password (10+ chars, letter + digit)")
    .option("--name <name>", "display name (defaults to email)")
    .option("--seed", "load the 50 demo IP ranges (development only; production should run `update`)", false)
    .option("--reinit", "proceed even if the system is already initialized; --email must match the existing admin (does NOT wipe data)", false)
    .action(async (opts) => {
    const cfg = (0, config_1.loadConfig)();
    const pool = (0, mysql_1.createPool)(cfg);
    let markedInitial = false;
    try {
        await (0, runner_1.runMigrations)(pool);
        const already = await (0, settings_1.isInitialized)(pool);
        if (already && !opts.reinit) {
            console.log("already initialized; pass --reinit to re-run");
            return;
        }
        if (opts.reinit) {
            const existing = await (0, users_1.findUserByEmail)(pool, opts.email);
            const anyAdmin = existing
                ? existing
                : await pool
                    .query("SELECT id, email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
                    .then(([rows]) => rows[0]);
            if (anyAdmin && anyAdmin.email !== opts.email) {
                throw new Error(`--reinit: existing admin is ${anyAdmin.email}; pass --email ${anyAdmin.email} to rotate its password, or drop the user manually first`);
            }
        }
        const r = await (0, bootstrap_1.bootstrapAdmin)(pool, {
            email: opts.email,
            password: opts.password,
            displayName: opts.name,
        });
        // --seed actually loads the rows now. It used to only be
        // reported in the log line: migration 012 had already inserted
        // the demo rows during `migrate`, so the flag changed nothing
        // about what was in the database.
        if (opts.seed) {
            await (0, demoSeed_1.loadDemoSeed)(pool);
        }
        if (!already) {
            await (0, settings_1.markInitialized)(pool);
            markedInitial = true;
        }
        console.log(`initialized admin=${opts.email} (id=${r.id}), seed=${opts.seed ? "yes" : "no"}, marked_initialized=${markedInitial ? "yes" : "no"}`);
    }
    finally {
        await pool.end();
    }
});
const SPEC_BY_KIND = Object.fromEntries(download_1.DEFAULT_SPECS.map((s) => [s.kind, s]));
program
    .command("download")
    .description("Fetch the free DB-IP CSV.gz files (city-lite, country-lite, asn-lite) into data/raw/ for the ETL pipeline")
    .option("--only <kinds>", "comma-separated subset: city,country,asn (default: all)")
    .option("--out <dir>", "override output directory (default: ${DATA_DIR}/raw)")
    .action(async (opts) => {
    const cfg = (0, config_1.loadConfig)();
    const outDir = opts.out ?? `${cfg.etl.dataDir}/raw`;
    const kinds = opts.only
        ? opts.only
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : download_1.DEFAULT_SPECS.map((s) => s.kind);
    const bad = kinds.filter((k) => !(k in SPEC_BY_KIND));
    if (bad.length > 0) {
        console.error(`unknown --only value(s): ${bad.join(", ")}; valid: ${Object.keys(SPEC_BY_KIND).join(", ")}`);
        process.exit(2);
    }
    const specs = kinds.map((k) => SPEC_BY_KIND[k]);
    console.log(`[download] target dir: ${outDir}`);
    const { results, failures } = await (0, download_1.downloadAll)(specs, outDir);
    if (failures.length > 0) {
        console.error(`[download] ${failures.length}/${specs.length} file(s) failed`);
        process.exit(1);
    }
    const total = results.reduce((s, r) => s + r.bytes, 0);
    console.log(`[download] done: ${results.length} file(s), ${(total / 1024 / 1024).toFixed(1)} MB total`);
});
program.parseAsync().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map