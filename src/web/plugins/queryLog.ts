// SPDX-License-Identifier: MIT
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool } from 'mysql2/promise';
import { insertQueryLogs, type QueryLogInsertable } from '../../storage/queryLog';

export interface PendingLookup {
  ip: Buffer;
  ipText: string;
  status: 'hit' | 'miss' | 'invalid';
  userId: number | null;
  apiKeyId: number | null;
  sessionId: string | null;
  remoteAddr: Buffer | null;
  userAgent: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    pendingLog?: PendingLookup;
  }
}

export function registerQueryLogWriter(app: FastifyInstance, pool: Pool, opts?: { flushIntervalMs?: number; maxBatch?: number }): { flush: () => Promise<void> } {
  const flushIntervalMs = opts?.flushIntervalMs ?? 5000;
  const maxBatch = opts?.maxBatch ?? 100;
  let buffer: QueryLogInsertable[] = [];
  let timer: NodeJS.Timeout | null = null;

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const slice = buffer;
    buffer = [];
    try {
      await insertQueryLogs(pool, slice);
    } catch (err) {
      app.log.error({ err, count: slice.length }, 'queryLog flush failed');
    }
  }

  timer = setInterval(() => { void flush(); }, flushIntervalMs);
  timer.unref();

  app.addHook('onResponse', async (req: FastifyRequest, _reply: FastifyReply) => {
    if (!req.pendingLog) return;
    buffer.push(req.pendingLog);
    if (buffer.length >= maxBatch) await flush();
  });

  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await flush();
  });

  return { flush };
}
