#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { Command } from "commander";
import * as cron from "node-cron";
import { loadConfig, configSummary } from "./config";
import { runPipeline } from "./etl/pipeline";
import { EtlRunLockedError } from "./etl/runGuard";
import { buildServer } from "./api/server";
import { createPool, lastEtlRun } from "./storage/mysql";
import { runMigrations, migrationStatus, listMigrationFiles } from "./storage/migrations/runner";
import { bootstrapAdmin } from "./web/admin/bootstrap";
import { isInitialized, markInitialized } from "./storage/settings";
import { findUserByEmail } from "./storage/users";
import { downloadAll, DEFAULT_SPECS, type DownloadSpec } from "./etl/download";

const program = new Command();
program.name("ipq").description("IP geolocation aggregator").version("0.1.0");

program
  .command("update")
  .description("Run ETL pipeline once and exit")
  .action(async () => {
    const cfg = loadConfig();
    console.log(configSummary(cfg));
    try {
      await runPipeline({ cfg });
    } catch (e) {
      // A lock refusal means another ETL is already running. Exit 0 —
      // this is not a failure of the command, and a cron-style caller
      // should not treat it as one.
      if (e instanceof EtlRunLockedError) {
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
  .action(async (opts: { once?: boolean }) => {
    const cfg = loadConfig();
    console.log(configSummary(cfg));
    if (opts.once) {
      try {
        await runPipeline({ cfg });
      } catch (e) {
        console.error("initial ETL failed (continuing to serve):", e);
      }
    }
    cron.schedule(
      cfg.etl.schedule,
      async () => {
        console.log("[cron] triggering ETL");
        try {
          await runPipeline({ cfg });
        } catch (e) {
          // A lock refusal is expected, not an error: the previous run is
          // simply still going. Say so, rather than logging it as a
          // failure that an operator has to investigate.
          if (e instanceof EtlRunLockedError) {
            console.log(`[cron] ETL skipped: ${e.message}`);
          } else {
            console.error("[cron] ETL failed:", e);
          }
        }
      },
      { timezone: cfg.etl.timezone },
    );
    const app = await buildServer(cfg);
    await app.listen({ port: cfg.api.port, host: "0.0.0.0" });
    console.log(`[api] listening on :${cfg.api.port}`);
  });

program
  .command("status")
  .description("Show last ETL run status")
  .action(async () => {
    const cfg = loadConfig();
    const pool = createPool(cfg);
    try {
      const last = await lastEtlRun(pool);
      if (!last) {
        console.log("No ETL runs recorded.");
        return;
      }
      console.log(JSON.stringify(last, null, 2));
    } finally {
      await pool.end();
    }
  });

program
  .command("migrate")
  .description("Apply pending database migrations")
  .action(async () => {
    const cfg = loadConfig();
    const pool = createPool(cfg);
    try {
      const result = await runMigrations(pool);
      if (result.applied.length === 0) {
        console.log("database already up to date");
      } else {
        console.log(`applied ${result.applied.length} migration(s)`);
      }
    } finally {
      await pool.end();
    }
  });

program
  .command("migrate:status")
  .description("Show migration status (applied vs pending)")
  .action(async () => {
    const cfg = loadConfig();
    const pool = createPool(cfg);
    try {
      const s = await migrationStatus(pool);
      const files = await listMigrationFiles();
      const labelOf = (version: string): string => files.find((f) => f.startsWith(version)) ?? version;
      const applied = [...s.applied].sort();
      const pending = [...s.pending].sort();
      for (const v of applied) console.log(`${labelOf(v).padEnd(28)} applied`);
      for (const v of pending) console.log(`${labelOf(v).padEnd(28)} pending`);
    } finally {
      await pool.end();
    }
  });

program
  .command("create-admin")
  .description("Create or promote an admin user (idempotent)")
  .requiredOption("--email <email>")
  .requiredOption("--password <password>")
  .option("--name <name>")
  .action(async (opts: { email: string; password: string; name?: string }) => {
    const cfg = loadConfig();
    const pool = createPool(cfg);
    try {
      const r = await bootstrapAdmin(pool, {
        email: opts.email,
        password: opts.password,
        displayName: opts.name,
      });
      console.log(`admin user ready: ${opts.email} (id=${r.id})`);
    } finally {
      await pool.end();
    }
  });

program
  .command("init")
  .description(
    "Non-interactive first-run bootstrap: migrate, seed (optional), create admin, mark initialized",
  )
  .requiredOption("--email <email>", "admin email")
  .requiredOption("--password <password>", "admin password (10+ chars, letter + digit)")
  .option("--name <name>", "display name (defaults to email)")
  .option("--seed", "include the seed migration (loads ~50 demo IP ranges)", false)
  .option(
    "--reinit",
    "proceed even if the system is already initialized; --email must match the existing admin (does NOT wipe data)",
    false,
  )
  .action(
    async (opts: { email: string; password: string; name?: string; seed: boolean; reinit: boolean }) => {
      const cfg = loadConfig();
      const pool = createPool(cfg);
      let markedInitial = false;
      try {
        await runMigrations(pool);
        const already = await isInitialized(pool);
        if (already && !opts.reinit) {
          console.log("already initialized; pass --reinit to re-run");
          return;
        }
        if (opts.reinit) {
          const existing = await findUserByEmail(pool, opts.email);
          const anyAdmin = existing
            ? existing
            : await pool
                .query<import("mysql2").RowDataPacket[]>(
                  "SELECT id, email FROM users WHERE role = 'admin' ORDER BY id LIMIT 1",
                )
                .then(([rows]) => rows[0] as { id: number; email: string } | undefined);
          if (anyAdmin && anyAdmin.email !== opts.email) {
            throw new Error(
              `--reinit: existing admin is ${anyAdmin.email}; pass --email ${anyAdmin.email} to rotate its password, or drop the user manually first`,
            );
          }
        }
        const r = await bootstrapAdmin(pool, {
          email: opts.email,
          password: opts.password,
          displayName: opts.name,
        });
        if (!already) {
          await markInitialized(pool);
          markedInitial = true;
        }
        console.log(
          `initialized admin=${opts.email} (id=${r.id}), seed=${opts.seed ? "yes" : "no"}, marked_initialized=${markedInitial ? "yes" : "no"}`,
        );
      } finally {
        await pool.end();
      }
    },
  );

const SPEC_BY_KIND: Record<DownloadSpec["kind"], DownloadSpec> = Object.fromEntries(
  DEFAULT_SPECS.map((s) => [s.kind, s] as const),
) as Record<DownloadSpec["kind"], DownloadSpec>;

program
  .command("download")
  .description(
    "Fetch the free DB-IP CSV.gz files (city-lite, country-lite, asn-lite) into data/raw/ for the ETL pipeline",
  )
  .option("--only <kinds>", "comma-separated subset: city,country,asn (default: all)")
  .option("--out <dir>", "override output directory (default: ${DATA_DIR}/raw)")
  .action(async (opts: { only?: string; out?: string }) => {
    const cfg = loadConfig();
    const outDir = opts.out ?? `${cfg.etl.dataDir}/raw`;
    const kinds = opts.only
      ? opts.only
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_SPECS.map((s) => s.kind);
    const bad = kinds.filter((k) => !(k in SPEC_BY_KIND));
    if (bad.length > 0) {
      console.error(
        `unknown --only value(s): ${bad.join(", ")}; valid: ${Object.keys(SPEC_BY_KIND).join(", ")}`,
      );
      process.exit(2);
    }
    const specs = kinds.map((k) => SPEC_BY_KIND[k as DownloadSpec["kind"]]);
    console.log(`[download] target dir: ${outDir}`);
    const { results, failures } = await downloadAll(specs, outDir);
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
