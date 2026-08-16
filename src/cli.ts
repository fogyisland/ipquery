#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { Command } from 'commander';
import * as cron from 'node-cron';
import { loadConfig, configSummary } from './config';
import { runPipeline } from './etl/pipeline';
import { buildServer } from './api/server';
import { createPool, lastEtlRun } from './storage/mysql';
import { runMigrations, migrationStatus, listMigrationFiles } from './storage/migrations/runner';
import { bootstrapAdmin } from './web/admin/bootstrap';

const program = new Command();
program
  .name('ipq')
  .description('IP geolocation aggregator')
  .version('0.1.0');

program
  .command('update')
  .description('Run ETL pipeline once and exit')
  .action(async () => {
    const cfg = loadConfig();
    console.log(configSummary(cfg));
    await runPipeline({ cfg });
  });

program
  .command('serve')
  .description('Start HTTP API server (runs ETL on schedule)')
  .option('--once', 'Run one ETL pass before serving')
  .action(async (opts: { once?: boolean }) => {
    const cfg = loadConfig();
    console.log(configSummary(cfg));
    if (opts.once) {
      try { await runPipeline({ cfg }); } catch (e) { console.error('initial ETL failed (continuing to serve):', e); }
    }
    cron.schedule(cfg.etl.schedule, async () => {
      console.log('[cron] triggering ETL');
      try { await runPipeline({ cfg }); } catch (e) { console.error('[cron] ETL failed:', e); }
    }, { timezone: cfg.etl.timezone });
    const app = await buildServer(cfg);
    await app.listen({ port: cfg.api.port, host: '0.0.0.0' });
    console.log(`[api] listening on :${cfg.api.port}`);
  });

program
  .command('status')
  .description('Show last ETL run status')
  .action(async () => {
    const cfg = loadConfig();
    const pool = createPool(cfg);
    try {
      const last = await lastEtlRun(pool);
      if (!last) { console.log('No ETL runs recorded.'); return; }
      console.log(JSON.stringify(last, null, 2));
    } finally { await pool.end(); }
  });

program
  .command('migrate')
  .description('Apply pending database migrations')
  .action(async () => {
    const cfg = loadConfig();
    const pool = createPool(cfg);
    try {
      const result = await runMigrations(pool);
      if (result.applied.length === 0) {
        console.log('database already up to date');
      } else {
        console.log(`applied ${result.applied.length} migration(s)`);
      }
    } finally { await pool.end(); }
  });

program
  .command('migrate:status')
  .description('Show migration status (applied vs pending)')
  .action(async () => {
    const cfg = loadConfig();
    const pool = createPool(cfg);
    try {
      const s = await migrationStatus(pool);
      const files = await listMigrationFiles();
      const labelOf = (version: string): string =>
        files.find((f) => f.startsWith(version)) ?? version;
      const applied = [...s.applied].sort();
      const pending = [...s.pending].sort();
      for (const v of applied) console.log(`${labelOf(v).padEnd(28)} applied`);
      for (const v of pending) console.log(`${labelOf(v).padEnd(28)} pending`);
    } finally { await pool.end(); }
  });

program
  .command('create-admin')
  .description('Create or promote an admin user (idempotent)')
  .requiredOption('--email <email>')
  .requiredOption('--password <password>')
  .option('--name <name>')
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
    } finally { await pool.end(); }
  });

program.parseAsync().catch((err) => { console.error(err); process.exit(1); });
