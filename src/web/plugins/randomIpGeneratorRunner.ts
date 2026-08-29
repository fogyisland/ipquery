// SPDX-License-Identifier: MIT
//
// Continuous random-IP ingest runner. When enabled via the
// `random_gen_enabled` setting, ticks every `random_gen_interval_sec`
// seconds (default 60) and runs runRandomGeneration() with the configured
// batch size (`random_gen_batch_size`, default 10).
//
// Why settings keys instead of env vars: the admin can toggle this
// on/off and tune the schedule from /admin/unknown-ips without restarting
// the server. Default is OFF — auto-generating IPs is a deliberate
// "burn through quota to fill the database" decision the admin should
// opt into.
//
// State persistence:
//   - random_gen_enabled: '0' | '1'
//   - random_gen_last_run_at: ISO timestamp of the most recent tick
//   - random_gen_last_summary: JSON-encoded RandomGenerationSummary
//   - random_gen_last_skipped_at: ISO timestamp of the most recent
//                                 SKIPPED tick (cooldown gate fired)
//   - random_gen_last_skip_reason: short string explaining the skip
//   - random_gen_interval_sec, random_gen_batch_size,
//     random_gen_cooldown_minutes, random_gen_cb_linkage — see migration 018
//
// Mirrors src/web/plugins/sessionPurger.ts pattern (setInterval / .unref
// / onClose cleanup) so the timer doesn't block process shutdown or
// pin Node alive on its own.

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { runRandomGeneration } from '../../etl/randomIpGenerator';
import { listProviderConfigs, buildProvidersFromConfig } from '../../storage/ingestProviders';
import { getSetting, setSetting } from '../../storage/settings';
import { loadRandomGenConfig, type RandomGenConfig } from '../../storage/randomProbeLog';

export interface RandomGenRunnerOptions {
  /** Override intervalMs at construction (e.g. tests). When unset, the
   *  runner reads `random_gen_interval_sec` from settings each time
   *  syncFromSettings runs. */
  intervalMs?: number;
}

export interface RandomGenRunnerHandle {
  /** Trigger an out-of-band tick (e.g. for the admin button's immediate
   *  "run now" path). Bypasses the cooldown gate so the admin can always
   *  force a tick. */
  tickNow: () => Promise<void>;
  /** Read current settings and start/stop the timer to match. Called on
   *  init AND after the admin toggles any of the random_gen_* keys. */
  syncFromSettings: () => Promise<boolean>;
}

const ENABLED_KEY = 'random_gen_enabled';
const LAST_RUN_KEY = 'random_gen_last_run_at';
const LAST_SUMMARY_KEY = 'random_gen_last_summary';
const LAST_SKIPPED_AT_KEY = 'random_gen_last_skipped_at';
const LAST_SKIP_REASON_KEY = 'random_gen_last_skip_reason';

export function registerRandomGenRunner(
  app: FastifyInstance,
  pool: Pool,
  opts: RandomGenRunnerOptions = {},
): RandomGenRunnerHandle {
  let intervalMs = opts.intervalMs ?? 60_000;
  let timer: NodeJS.Timeout | null = null;
  let running = false; // re-entrancy guard
  let lastRunAtMs = 0; // epoch ms of last completed or attempted tick
  let lastSkippedProvider: string | null = null; // provider name from the last skip

  const persistSkip = async (reason: string, provider: string | null): Promise<void> => {
    lastSkippedProvider = provider;
    const now = new Date().toISOString();
    await Promise.all([
      setSetting(pool, LAST_SKIPPED_AT_KEY, now).catch((err) => app.log.warn({ err }, 'random-gen-runner persist skipAt')),
      setSetting(pool, LAST_SKIP_REASON_KEY, reason).catch((err) => app.log.warn({ err }, 'random-gen-runner persist skipReason')),
    ]);
  };

  const tick = async (): Promise<void> => {
    if (running) return; // skip overlapping ticks if the previous one is still in flight
    running = true;
    try {
      const config = await loadRandomGenConfig(pool);
      const configs = await listProviderConfigs(pool);
      const providers = buildProvidersFromConfig(configs);
      if (providers.length === 0) {
        app.log.warn('[random-gen-runner] no enabled providers; skipping tick');
        return;
      }
      // Cooldown gate: if a provider was auto-disabled in the PREVIOUS
      // tick (within `cooldownMinutes`) AND CB linkage is on, skip this
      // tick to avoid hammering a still-recovering provider. The skip
      // reason captures the offending provider for the UI.
      if (config.cbLinkage && lastSkippedProvider) {
        const elapsedMin = lastRunAtMs > 0 ? (Date.now() - lastRunAtMs) / 60_000 : Infinity;
        if (elapsedMin < config.cooldownMinutes) {
          const remainingMin = Math.max(0, Math.ceil(config.cooldownMinutes - elapsedMin));
          await persistSkip(`provider ${lastSkippedProvider} disabled (${remainingMin}m remaining)`, lastSkippedProvider);
          app.log.info({ provider: lastSkippedProvider, remainingMin }, 'random-gen-runner tick skipped (cooldown)');
          return;
        }
      }
      // Reset skip state once we actually proceed past the gate — the
      // previous tick's disabled-provider is no longer relevant.
      lastSkippedProvider = null;
      const summary = await runRandomGeneration(pool, providers, {
        count: config.batchSize,
        logger: {
          log: (msg) => app.log.info({ msg }, 'random-gen-runner'),
          warn: (msg) => app.log.warn({ msg }, 'random-gen-runner'),
          error: (msg) => app.log.error({ msg }, 'random-gen-runner'),
        },
      });
      const now = new Date().toISOString();
      lastRunAtMs = Date.now();
      // Track the first disabled provider from this run so the next
      // tick's cooldown gate has something to check. The summary's
      // providersDisabled list is populated by disableRateLimitedProviders
      // in unknownIpBackfill.
      if (config.cbLinkage && summary.providersDisabled.length > 0) {
        lastSkippedProvider = summary.providersDisabled[0] ?? null;
      }
      // Best-effort persistence — if the write fails the tick still
      // counts as a run, the next tick will record its own summary.
      await Promise.all([
        setSetting(pool, LAST_RUN_KEY, now).catch((err) => app.log.warn({ err }, 'random-gen-runner persist lastRunAt')),
        setSetting(pool, LAST_SUMMARY_KEY, JSON.stringify(summary)).catch((err) => app.log.warn({ err }, 'random-gen-runner persist lastSummary')),
        // Clear any prior skip — this tick actually ran.
        setSetting(pool, LAST_SKIPPED_AT_KEY, '').catch(() => { /* ignore */ }),
        setSetting(pool, LAST_SKIP_REASON_KEY, '').catch(() => { /* ignore */ }),
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

  /** Read the latest settings (enabled + interval/batch/cooldown/cbLinkage)
   *  and restart the timer to match. If the interval changed we clear the
   *  old setInterval and start a new one; otherwise we leave the existing
   *  timer alone (the next tick will pick up the new settings). */
  const syncFromSettings = async (): Promise<boolean> => {
    const [enabledRaw, config] = await Promise.all([
      getSetting(pool, ENABLED_KEY),
      loadRandomGenConfig(pool),
    ]);
    const enabled = enabledRaw === '1';
    const newIntervalMs = config.intervalSec * 1000;
    if (newIntervalMs !== intervalMs) {
      const wasRunning = timer !== null;
      if (wasRunning) stop();
      intervalMs = newIntervalMs;
      if (wasRunning || enabled) start();
    } else if (enabled) {
      start();
    } else {
      stop();
    }
    app.log.info({ enabled, config }, 'random-gen-runner synced');
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
 *  when the runner has never ticked. Cooldown state is computed from
 *  the skip timestamp + the configured cooldown window so the UI
 *  shows a live "X minutes remaining" badge without needing a
 *  push channel. */
export async function readRandomGenState(pool: Pool): Promise<{
  enabled: boolean;
  lastRunAt: string | null;
  lastSummary: unknown | null;
  lastSkippedAt: string | null;
  lastSkipReason: string | null;
  cooldownRemainingMin: number | null;
  config: RandomGenConfig;
}> {
  const [v, lastRun, lastSum, skippedAt, skipReason, config] = await Promise.all([
    getSetting(pool, ENABLED_KEY),
    getSetting(pool, LAST_RUN_KEY),
    getSetting(pool, LAST_SUMMARY_KEY),
    getSetting(pool, LAST_SKIPPED_AT_KEY),
    getSetting(pool, LAST_SKIP_REASON_KEY),
    loadRandomGenConfig(pool),
  ]);
  let lastSummary: unknown = null;
  if (lastSum) {
    try { lastSummary = JSON.parse(lastSum); } catch { /* ignore malformed */ }
  }
  // Compute remaining cooldown minutes from the skip timestamp + cooldown
  // window. Only meaningful if the runner is currently enabled AND the
  // skip happened within the window; otherwise return null.
  let cooldownRemainingMin: number | null = null;
  if (v === '1' && skippedAt && config.cooldownMinutes > 0) {
    const skippedMs = Date.parse(skippedAt);
    if (!Number.isNaN(skippedMs)) {
      const elapsedMin = (Date.now() - skippedMs) / 60_000;
      const remaining = config.cooldownMinutes - elapsedMin;
      if (remaining > 0) cooldownRemainingMin = Math.ceil(remaining);
    }
  }
  return {
    enabled: v === '1',
    lastRunAt: lastRun,
    lastSummary,
    lastSkippedAt: skippedAt || null,
    lastSkipReason: skipReason || null,
    cooldownRemainingMin,
    config,
  };
}