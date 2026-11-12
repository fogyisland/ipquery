#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { Command } from "commander";
import { loadConfig, configSummary } from "./config";
import { runPipeline } from "./etl/pipeline";
import { EtlRunLockedError } from "./etl/runGuard";
import { buildServer } from "./api/server";
import { createPool, lastEtlRun } from "./storage/mysql";
import { runMigrations, migrationStatus, listMigrationFiles } from "./storage/migrations/runner";
import { loadDemoSeed } from "./storage/seed/demoSeed";
import { bootstrapAdmin } from "./web/admin/bootstrap";
import { isInitialized, markInitialized } from "./storage/settings";
import { findUserByEmail } from "./storage/users";
import { downloadAll, DEFAULT_SPECS, type DownloadSpec } from "./etl/download";
import { databaseIsReachable, explainCliDbFailure, probeConnection, writeDbCredentialsToEnv } from "./api/dbBootstrap";

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
    // The ETL needs a database. When the database is not reachable, running
    // it here would either throw or sit in the driver's connect timeout —
    // and both happen BEFORE the server starts, which is exactly the
    // situation the degraded boot exists to survive. The operator's way in
    // is the wizard at /init, and the wizard is served by the server.
    //
    // So: probe first. If the database answers, do the normal thing. If it
    // does not, skip the ETL and let the server come up in setup-only mode.
    const dbUp = await databaseIsReachable(cfg);
    if (!dbUp) {
      console.log(
        "[serve] the database is not reachable — skipping the ETL and starting in setup-only mode.",
      );
    }

    if (opts.once && dbUp) {
      try {
        await runPipeline({ cfg });
      } catch (e) {
        console.error("initial ETL failed (continuing to serve):", e);
      }
    }

    // The recurring ETL schedule is NOT armed here. It lives in the server
    // (src/web/plugins/etlScheduler.ts), because it has to be armed at the
    // moment the database becomes usable — which may be minutes after
    // boot, when the operator finishes step 2 of the setup wizard. A cron
    // started from the CLI could not be re-armed at that point without a
    // restart, so the daily ETL would silently never run on an install
    // that began without a database.

    const app = await buildServer(cfg);
    await app.listen({ port: cfg.api.port, host: "0.0.0.0" });
    console.log(`[api] listening on :${cfg.api.port}`);
    if (app.dbDegraded) {
      // Say it plainly on stdout. The operator is looking at a server
      // that answers 503 everywhere except /init, and they need to know
      // that the way in is the wizard — not that something is broken.
      console.log(
        "[api] the database could not be reached — running in setup-only mode.\n" +
          `[api] open http://localhost:${cfg.api.port}/init to configure the connection.\n` +
          "[api] the rest of the application answers 503 until you do.",
      );
    }
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
  .command("db")
  .description(
    "Set the database connection and write it to .env (tested before it is persisted)",
  )
  .option("--host <host>", "database host")
  .option("--port <port>", "database port")
  .option("--user <user>", "database user")
  .option("--password <password>", "database password")
  .option("--name <name>", "database name")
  .option("--save", "write the connection to .env (without this, only the connection is tested)", false)
  .action(
    async (opts: {
      host?: string;
      port?: string;
      user?: string;
      password?: string;
      name?: string;
      save: boolean;
    }) => {
      const cfg = loadConfig();

      // Missing values fall back to what is already configured, so
      // `--host 10.0.0.5` alone is enough to move a working install to
      // another host. The password falls back to the configured one too —
      // so changing only the host or the database name does not require
      // re-typing it.
      //
      // The password is deliberately NOT read from the command line by
      // default: argv lands in the shell history and in `ps` output. Pass
      // `--password` only when there is no way around it, and prefer
      // DB_PASSWORD in the environment (which this falls back to through
      // the config loader).
      const host = (opts.host ?? cfg.db.host).trim();
      const user = (opts.user ?? cfg.db.user).trim();
      const database = (opts.name ?? cfg.db.database).trim();
      const portRaw = (opts.port ?? String(cfg.db.port)).trim();
      const port = Number(portRaw);
      const password = opts.password ?? cfg.db.password;

      if (!host || !user || !database) {
        console.error(
          "[db] host, user and database name are required (pass --host, --user, --name)",
        );
        process.exit(2);
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`[db] --port must be an integer between 1 and 65535 (got "${portRaw}")`);
        process.exit(2);
      }

      const target = { host, port, user, password, database };

      // Test BEFORE persisting. A .env that cannot connect is worse than
      // no .env: the next boot dies on it with no way back.
      console.log(`[db] testing ${user}@${host}:${port}/${database} …`);
      const probe = await probeConnection(target, cfg.db.poolSize);
      if (!probe.ok) {
        console.error(`[db] the connection failed: ${probe.reason}`);
        console.error("[db] nothing was written to .env");
        process.exit(1);
      }
      console.log("[db] the connection works");

      if (!opts.save) {
        console.log("[db] --save was not given: nothing was written to .env");
        return;
      }

      // Apply the schema FIRST, and write .env only once it worked.
      //
      // The order matters: a connection can succeed and the migration
      // still fail (no DDL rights, conflicting schema). If .env were
      // written first, the next `serve` would try to migrate that
      // database again, fail the same way, and take the server down —
      // leaving the operator with a dead process and a .env they have
      // to hand-edit. Migrating first means .env is only ever written
      // for a database that is known to work.
      cfg.db.host = host;
      cfg.db.port = port;
      cfg.db.user = user;
      cfg.db.password = password;
      cfg.db.database = database;

      const pool = createPool(cfg);
      try {
        const result = await runMigrations(pool);
        console.log(
          result.applied.length === 0
            ? "[db] the schema was already up to date"
            : `[db] applied ${result.applied.length} migration(s)`,
        );
      } catch (err) {
        console.error(`[db] the schema could not be built: ${(err as Error).message}`);
        console.error("[db] nothing was written to .env");
        process.exitCode = 1;
        return;
      } finally {
        await pool.end();
      }

      const envPath = writeDbCredentialsToEnv(target);
      console.log(`[db] connection written to ${envPath}`);
      console.log("[db] done — the connection is live for the next `serve`");
    },
  );

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
  .command("seed:demo")
  .description(
    "Load 50 demo IP ranges (development only — production should run `update` to load the real library)",
  )
  .action(async () => {
    const cfg = loadConfig();
    const pool = createPool(cfg);
    try {
      // The demo rows live in a plain .sql file next to the migrations,
      // not in a migration: a production database must never end up
      // with them by accident.
      await runMigrations(pool);
      const result = await loadDemoSeed(pool);
      console.log(`[seed:demo] ${result.total} demo rows present (${result.added} newly added)`);
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
  .option("--seed", "load the 50 demo IP ranges (development only; production should run `update`)", false)
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
        // --seed actually loads the rows now. It used to only be
        // reported in the log line: migration 012 had already inserted
        // the demo rows during `migrate`, so the flag changed nothing
        // about what was in the database.
        if (opts.seed) {
          await loadDemoSeed(pool);
        }
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
  // A database that cannot be reached is the single most common failure
  // during a first install, and the driver's raw error ("connect
  // ECONNREFUSED 127.0.0.1:3306") does not tell an operator what to do
  // about it in the context of this application. Translate it into a
  // pointer at the setup wizard, which is where the database gets
  // configured.
  //
  // Anything that is NOT a reachability failure is a real error and keeps
  // its stack trace — a bug should look like a bug.
  const explanation = explainCliDbFailure(err);
  if (explanation) {
    console.error(`\n[ipq] ${explanation}\n`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
