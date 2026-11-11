import type { FastifyInstance } from "fastify";
import type { Pool } from "mysql2/promise";
import { type RandomGenConfig } from "../../storage/randomProbeLog";
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
    /** Force the provider reaper to run now (admin button / tests).
     *  Returns the number of providers re-enabled. */
    reapNow: () => Promise<number>;
}
/** Auto-re-enable providers whose `auto_reenable_at` has elapsed. The
 *  circuit breaker (see unknownIpBackfill.disableRateLimitedProviders)
 *  flips a provider to enabled=0 + auto_reenable_at = NOW()+N minutes
 *  when it gets 429'd or when the failure rate trips. Without this
 *  reaper the cooldown would be dead — the provider would just stay
 *  disabled until the admin manually re-enables it.
 *
 *  Idempotent — only matches enabled=0 AND auto_reenable_at IS NOT NULL
 *  AND auto_reenable_at <= NOW(3), so calling more than once per minute
 *  is harmless. Returns the count re-enabled for the caller's logs. */
export declare function reapProviders(pool: Pool): Promise<number>;
export declare function registerRandomGenRunner(app: FastifyInstance, pool: Pool, opts?: RandomGenRunnerOptions): RandomGenRunnerHandle;
/** Read the persisted state for the admin dashboard. Returns nulls
 *  when the runner has never ticked. Cooldown state is computed from
 *  the skip timestamp + the configured cooldown window so the UI
 *  shows a live "X minutes remaining" badge without needing a
 *  push channel. */
export declare function readRandomGenState(pool: Pool): Promise<{
    enabled: boolean;
    lastRunAt: string | null;
    lastSummary: unknown | null;
    lastSkippedAt: string | null;
    lastSkipReason: string | null;
    cooldownRemainingMin: number | null;
    config: RandomGenConfig;
}>;
