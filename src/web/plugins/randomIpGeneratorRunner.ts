// SPDX-License-Identifier: MIT
//
// Continuous random-IP ingest runner. When enabled via the
// `random_gen_enabled` setting, ticks every 60 seconds and runs
// runRandomGeneration() with count=10.
//
// Why a settings key instead of an env var: the admin can toggle this
// on/off from /admin/unknown-ips without restarting the server. Default
// is OFF — auto-generating 10 IPs/min is a deliberate "burn through
// quota to fill the database" decision the admin should opt into.
//
// State persistence (settings keys):
//   - random_gen_enabled: '0' | '1'
//   - random_gen_last_run_at: ISO timestamp of the most recent tick
//   - random_gen_last_summary: JSON-encoded RandomGenerationSummary
//
// Mirrors src/web/plugins/sessionPurger.ts pattern (setInterval / .unref
// / onClose cleanup) so the timer doesn't block process shutdown or
// pin Node alive on its own.

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { runRandomGeneration } from '../../etl/randomIpGenerator';
import { listProviderConfigs, buildProvidersFromConfig } from '../../storage/ingestProviders';
import { getSetting, setSetting } from '../../storage/settings';

export interface RandomGenRunnerOptions {
  /** Run interval in ms. Default 60s — matches the user's "1分钟10个"
   *  target. Each tick calls runRandomGeneration which itself fans out
   *  per IP, so a single tick of 10 IPs serial takes ~10-20s with 5
   *  providers; the next tick starts at the next minute boundary. */
  intervalMs?: number;
}

export interface RandomGenRunnerHandle {
  /** Trigger an out-of-band tick (e.g. for the admin button's immediate
   *  "run now" path). */
  tickNow: () => Promise<void>;
  /** Read current enabled state from DB and start/stop the timer to
   *  match. Called on init AND after the admin toggles the setting. */
  syncFromSettings: () => Promise<boolean>;
}

const ENABLED_KEY = 'random_gen_enabled';
const LAST_RUN_KEY = 'random_gen_last_run_at';
const LAST_SUMMARY_KEY = 'random_gen_last_summary';

export function registerRandomGenRunner(
  app: FastifyInstance,
  pool: Pool,
  opts: RandomGenRunnerOptions = {},
): RandomGenRunnerHandle {
  const intervalMs = opts.intervalMs ?? 60_000;

  let timer: NodeJS.Timeout | null = null;
  let running = false; // re-entrancy guard

  const tick = async (): Promise<void> => {
    if (running) return; // skip overlapping ticks if the previous one is still in flight
    running = true;
    try {
      const configs = await listProviderConfigs(pool);
      const providers = buildProvidersFromConfig(configs);
      if (providers.length === 0) {
        app.log.warn('[random-gen-runner] no enabled providers; skipping tick');
        return;
      }
      const summary = await runRandomGeneration(pool, providers, {
        count: 10,
        logger: {
          log: (msg) => app.log.info({ msg }, 'random-gen-runner'),
          warn: (msg) => app.log.warn({ msg }, 'random-gen-runner'),
          error: (msg) => app.log.error({ msg }, 'random-gen-runner'),
        },
      });
      const now = new Date().toISOString();
      // Best-effort persistence — if the write fails the tick still
      // counts as a run, the next tick will record its own summary.
      await Promise.all([
        setSetting(pool, LAST_RUN_KEY, now).catch((err) => app.log.warn({ err }, 'random-gen-runner persist lastRunAt')),
        setSetting(pool, LAST_SUMMARY_KEY, JSON.stringify(summary)).catch((err) => app.log.warn({ err }, 'random-gen-runner persist lastSummary')),
      ]);
      app.log.info({
        merged: summary.merged,
        considered: summary.considered,
        disabled: summary.providersDisabled,
      }, 'random-gen-runner tick');
    } catch (err) {
      app.log.error({ err }, 'random-gen-runner tick failed');
    } finally {
      running = false;
    }
  };

  const start = (): void => {
    if (timer) return;
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref();
    app.log.info({ intervalMs }, 'random-gen-runner started');
  };

  const stop = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    app.log.info('random-gen-runner stopped');
  };

  const syncFromSettings = async (): Promise<boolean> => {
    const v = await getSetting(pool, ENABLED_KEY);
    const enabled = v === '1';
    if (enabled) start(); else stop();
    return enabled;
  };

  // Lifecycle: register the timer at boot based on persisted setting,
  // tear it down on server close. If multiple workers run this, each
  // would tick independently — out of scope for the single-process dev
  // deployment, but noted for future multi-instance scaling.
  app.addHook('onClose', () => { stop(); });
  // Initial sync runs after DB is up. Caller is expected to invoke
  // syncFromSettings() once during boot after pool is ready.
  return { tickNow: tick, syncFromSettings };
}

/** Read the persisted state for the admin dashboard. Returns nulls
 *  when the runner has never ticked. */
export async function readRandomGenState(pool: Pool): Promise<{
  enabled: boolean;
  lastRunAt: string | null;
  lastSummary: unknown | null;
}> {
  const [v, lastRun, lastSum] = await Promise.all([
    getSetting(pool, ENABLED_KEY),
    getSetting(pool, LAST_RUN_KEY),
    getSetting(pool, LAST_SUMMARY_KEY),
  ]);
  let lastSummary: unknown = null;
  if (lastSum) {
    try { lastSummary = JSON.parse(lastSum); } catch { /* ignore malformed */ }
  }
  return {
    enabled: v === '1',
    lastRunAt: lastRun,
    lastSummary,
  };
}