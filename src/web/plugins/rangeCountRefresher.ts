// SPDX-License-Identifier: MIT
//
// Keeps the cached `ip_ranges` row count honest.
//
// The count is stored because a real `COUNT(*)` over the 8.15M-row library
// takes ~3.2 seconds, and the dashboard, the landing page and the console's
// 30-second auto-refresh all read it. The bulk writers refresh it themselves
// (the ETL swap and the range importer both call `refreshRangeCount`), so
// this timer exists only to catch rows written by anything else — a
// backfill's consensus insert, the demo seed, a hand-run UPDATE.
//
// Mirrors the other lifecycle plugins (sessionPurger, uploadSweeper):
// setInterval + .unref() so the timer never pins the process alive, a
// degraded-mode skip so a setup-only server does not log failures every
// interval, and an onClose sweep so shutdown leaves the value current.
import type { FastifyInstance } from "fastify";
import type { Pool } from "mysql2/promise";
import { RANGE_COUNT_MAX_AGE_MS, readStoredRangeCount, refreshRangeCount } from "../../storage/rangeCount";

export function registerRangeCountRefresher(
  app: FastifyInstance,
  pool: Pool | (() => Pool),
  opts?: { intervalMs?: number },
): { refreshNow: () => Promise<number | null> } {
  const intervalMs = opts?.intervalMs ?? RANGE_COUNT_MAX_AGE_MS;
  let timer: NodeJS.Timeout | null = null;

  // The pool can be re-pointed at runtime by the setup wizard, so it is
  // resolved at call time rather than captured.
  const resolvePool = (): Pool => (typeof pool === "function" ? pool() : pool);

  const tick = async (): Promise<number | null> => {
    // No database to count while the server serves the wizard.
    if (app.dbDegraded) return null;
    try {
      const stored = await readStoredRangeCount(resolvePool());
      const ageMs =
        stored?.syncedAt === null || stored?.syncedAt === undefined
          ? Infinity
          : Date.now() - stored.syncedAt.getTime();
      // Nothing to do when the stored value is still fresh — an exact count is
      // expensive enough that refreshing it on a timer for no reason is waste.
      if (ageMs < intervalMs) return stored?.value ?? null;
      const fresh = await refreshRangeCount(resolvePool());
      if (fresh) app.log.info({ rows: fresh.value }, "range count refreshed");
      return fresh?.value ?? null;
    } catch (err) {
      app.log.warn({ err }, "range count refresh failed");
      return null;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();

  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
  });

  return { refreshNow: tick };
}
