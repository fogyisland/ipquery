#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { Command } from 'commander';
import * as cron from 'node-cron';
import { loadConfig, configSummary } from './config';
import { runPipeline } from './etl/pipeline';
import { buildServer } from './api/server';
import { createPool, lastEtlRun } from './storage/mysql';

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

program.parseAsync().catch((err) => { console.error(err); process.exit(1); });