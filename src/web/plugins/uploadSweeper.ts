// SPDX-License-Identifier: MIT
//
// Periodic cleanup of uploads nobody came back for.
//
// An upload that was started and never finished is dead weight: the rows
// that describe it, the row for every chunk that landed, and — the real
// cost — the assembled file on disk, which for a whole-library upload is
// two gigabytes. Nothing about it will ever be used.
//
// The import path cleans up after itself, so this only ever sees the
// uploads that were interrupted: the tab closed, the laptop slept, the
// transfer died halfway. Without a sweep those accumulate forever, and
// the disk fills with files that only the operator can identify and
// delete by hand.
//
// The interval is generous (6h) because the sweep has nothing to do
// between runs and the uploads it collects are two days old by the time
// it looks at them.
//
// Mirrors the sessionPurger's setInterval / .unref / onClose pattern
// (src/web/plugins/sessionPurger.ts) so the timer never blocks process
// shutdown and does not pin Node alive on its own.
import type { FastifyInstance } from "fastify";
import type { Pool } from "mysql2/promise";
import { purgeAbandonedUploads } from "../../storage/rangeUpload";

export function registerUploadSweeper(
  app: FastifyInstance,
  pool: Pool | (() => Pool),
  opts?: { intervalMs?: number },
): { sweepNow: () => Promise<number> } {
  const intervalMs = opts?.intervalMs ?? 6 * 60 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;

  // The pool may be re-pointed at runtime (the setup wizard swaps it when
  // the operator supplies working credentials), so resolve it at call
  // time rather than capturing it. A captured pool would keep sweeping
  // the old database — or the one that was never reachable.
  const resolvePool = (): Pool => (typeof pool === "function" ? pool() : pool);

  const tick = async (): Promise<number> => {
    // While the server is in degraded mode there is no database to sweep.
    // The tick would fail, and the failure log would repeat every six
    // hours on a server that is otherwise working fine — noise that
    // makes a healthy setup-only install look broken. Skip instead.
    if (app.dbDegraded) return 0;
    try {
      const n = await purgeAbandonedUploads(resolvePool());
      if (n > 0) app.log.info({ purged: n }, "uploadSweeper tick");
      return n;
    } catch (err) {
      app.log.error({ err }, "uploadSweeper tick failed");
      return 0;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();

  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await tick();
  });

  return { sweepNow: tick };
}
