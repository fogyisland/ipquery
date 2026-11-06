// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import type { Pool } from "mysql2/promise";
import { purgeExpired } from "../../storage/sessions";

// Periodic cleanup of expired session rows. Sessions are deleted by
// destroySession/destroyAllForUserExcept on logout + password change, but
// sessions that simply expire (TTL elapses without an explicit logout)
// stick around in the table forever otherwise — unbounded growth on a
// long-running install.
//
// Run interval is intentionally generous (1h default). Even at 1h, a
// million-row sessions table takes the same DELETE-by-PK path MySQL uses
// for any other TTL sweep; the index on expires_at keeps it cheap.
//
// Mirrors the queryLog writer's setInterval / .unref / onClose pattern
// (src/web/plugins/queryLog.ts:40) so the timer never blocks process
// shutdown and doesn't pin Node alive on its own.
export function registerSessionPurger(
  app: FastifyInstance,
  pool: Pool,
  opts?: { intervalMs?: number },
): { purgeNow: () => Promise<number> } {
  const intervalMs = opts?.intervalMs ?? 60 * 60 * 1000;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<number> => {
    try {
      const n = await purgeExpired(pool);
      if (n > 0) app.log.info({ purged: n }, "sessionPurger tick");
      return n;
    } catch (err) {
      app.log.error({ err }, "sessionPurger tick failed");
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

  return { purgeNow: tick };
}
