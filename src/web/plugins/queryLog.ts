// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Pool } from "mysql2/promise";
import { insertQueryLogs, type QueryLogInsertable } from "../../storage/queryLog";

export interface PendingLookup {
  ip: Buffer;
  ipText: string;
  status: "hit" | "miss" | "invalid";
  userId: number | null;
  apiKeyId: number | null;
  sessionId: string | null;
  remoteAddr: Buffer | null;
  userAgent: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The row(s) this request contributes to the query log.
     *
     *  A single lookup contributes one row. A batch contributes one row
     *  per address, because the log's job is to say which addresses were
     *  asked about — a batch of a hundred addresses that logged one row
     *  would understate the traffic by a factor of a hundred, and the
     *  "top addresses" page would be wrong. */
    pendingLog?: PendingLookup | PendingLookup[];
  }
}

export function registerQueryLogWriter(
  app: FastifyInstance,
  pool: Pool | (() => Pool),
  opts?: { flushIntervalMs?: number; maxBatch?: number },
): { flush: () => Promise<void> } {
  const flushIntervalMs = opts?.flushIntervalMs ?? 5000;
  const maxBatch = opts?.maxBatch ?? 100;
  let buffer: QueryLogInsertable[] = [];
  let timer: NodeJS.Timeout | null = null;

  // Resolved at call time: the setup wizard can re-point the pool at a
  // different database while the server is running, and a captured pool
  // would keep writing query logs to the old one.
  const resolvePool = (): Pool => (typeof pool === "function" ? pool() : pool);

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const slice = buffer;
    buffer = [];
    // While the server is in degraded mode there is nowhere to write
    // these rows. Dropping them is correct: the requests they describe
    // were answered with 503s from the setup-only mode, not real lookups,
    // so there is nothing to record. Attempting the insert would fail on
    // every flush and log the same error every five seconds.
    if (app.dbDegraded) return;
    try {
      await insertQueryLogs(resolvePool(), slice);
    } catch (err) {
      app.log.error({ err, count: slice.length }, "queryLog flush failed");
    }
  }

  timer = setInterval(() => {
    void flush();
  }, flushIntervalMs);
  timer.unref();

  app.addHook("onResponse", async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.pendingLog) return;
    if (Array.isArray(req.pendingLog)) {
      // A batch: one row per address. The buffer's flush threshold is
      // checked against the whole batch, so a hundred-address batch
      // flushes on its own rather than waiting for the timer.
      buffer.push(...req.pendingLog);
    } else {
      buffer.push(req.pendingLog);
    }
    if (buffer.length >= maxBatch) await flush();
  });

  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await flush();
  });

  return { flush };
}
