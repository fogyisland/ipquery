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
  pool: Pool,
  opts?: { intervalMs?: number },
): { purgeNow: () => Promise<number> } {
  const intervalMs = opts?.intervalMs ?? 6 * 60 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<number> => {
    try {
      const retentionDays = await loadRetentionDays(pool);
      if (retentionDays <= 0) return 0;
      const purged = await purgeOldProbes(pool, retentionDays);
      if (purged > 0) app.log.info({ purged, retentionDays }, "probeRetention tick");
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
    // Only stop the timer — deliberately no final tick. The pool is
    // closed by an onClose hook registered earlier (src/api/server.ts),
    // and Fastify runs onClose hooks in registration order, so by the
    // time this one runs the pool is already gone and a final sweep
    // would only log "Pool is closed". Skipping it is harmless: the
    // probe log is pure audit data and the next sweep picks up
    // whatever this one would have deleted.
    if (timer) clearInterval(timer);
  });

  return { purgeNow: tick };
}
