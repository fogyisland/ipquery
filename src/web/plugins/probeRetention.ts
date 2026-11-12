// SPDX-License-Identifier: MIT
//
// Daily sweep of random_probe_log. The table is an audit trail of every
// per-IP provider fan-out (see src/storage/randomProbeLog.ts and migration
// 018) and grows ~20k rows/day at worst case. The retention window
// defaults to 30 days and is configurable via the
// `random_probe_retention_days` setting — 0 disables the sweep entirely
// (keep forever).
//
// Mirrors the sessionPurger pattern (setInterval / .unref / onClose) so
// the timer never blocks process shutdown and doesn't pin Node alive on
// its own. The interval is intentionally generous (6h): the window is
// measured in days, so sweeping 4x/day is more than enough to keep the
// table bounded, and the sweep itself is a single indexed DELETE.
import type { FastifyInstance } from "fastify";
import type { Pool } from "mysql2/promise";
import { loadRetentionDays, purgeOldProbes } from "../../storage/randomProbeLog";

export function registerProbeRetention(
  app: FastifyInstance,
  pool: Pool | (() => Pool),
  opts?: { intervalMs?: number },
): { purgeNow: () => Promise<number> } {
  const intervalMs = opts?.intervalMs ?? 6 * 60 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;

  // Resolved at call time: the setup wizard can re-point the pool at a
  // different database while the server is running, and a captured pool
  // would keep sweeping the old one.
  const resolvePool = (): Pool => (typeof pool === "function" ? pool() : pool);

  const tick = async (): Promise<number> => {
    // While the server is in degraded mode there is no database to sweep.
    // Skipping keeps the log clean instead of repeating the same failure
    // every tick on a server that is otherwise working fine.
    if (app.dbDegraded) return 0;
    try {
      const target = resolvePool();
      const retentionDays = await loadRetentionDays(target);
      if (retentionDays <= 0) return 0;
      const purged = await purgeOldProbes(target, retentionDays);
      if (purged > 0) app.log.info({ purged: purged, retentionDays }, "probeRetention tick");
      return purged;
    } catch (err) {
      app.log.error({ err }, "probeRetention tick failed");
      return 0;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();

  app.addHook("onClose", async () => {
    // Only stop the timer — deliberately no final tick. The probe log is
    // pure audit data; the next sweep picks up whatever a final sweep
    // would have deleted, and skipping it keeps shutdown independent of
    // the pool's remaining lifetime.
    if (timer) clearInterval(timer);
  });

  return { purgeNow: tick };
}
