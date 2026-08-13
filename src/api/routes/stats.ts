// SPDX-License-Identifier: MIT
import type { FastifyInstance } from 'fastify';
import { lastEtlRun } from '../../storage/mysql';

export default async function statsRoute(app: FastifyInstance): Promise<void> {
  app.get('/stats', async () => {
    const last = await lastEtlRun(app.pool);
    if (!last) return { lastRun: null };
    return {
      lastRun: {
        startedAt: last.startedAt?.toISOString(),
        finishedAt: last.finishedAt?.toISOString(),
        status: last.status,
        mergedRecords: last.mergedRecords,
        sources: {
          maxmind: { records: last.maxmindRecords ?? 0, builtAt: last.maxmindBuiltAt?.toISOString() ?? null },
          ip2region: { records: last.ip2regionRecords ?? 0, builtAt: last.ip2regionBuiltAt?.toISOString() ?? null },
          dbip: { records: last.dbipRecords ?? 0, builtAt: last.dbipBuiltAt?.toISOString() ?? null },
        },
      },
    };
  });
}