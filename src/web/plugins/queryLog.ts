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
    pendingLog?: PendingLookup;
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
    buffer.push(req.pendingLog);
    if (buffer.length >= maxBatch) await flush();
  });

  app.addHook("onClose", async () => {
    if (timer) clearInterval(timer);
    await flush();
  });

  return { flush };
}
