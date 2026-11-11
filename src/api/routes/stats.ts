// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import { lastEtlRun } from "../../storage/mysql";

export default async function statsRoute(app: FastifyInstance): Promise<void> {
  app.get("/stats", async () => {
    const last = await lastEtlRun(app.pool);
    if (!last) return { lastRun: null };
    return {
      lastRun: {
        startedAt: last.startedAt?.toISOString(),
        finishedAt: last.finishedAt?.toISOString(),
        status: last.status,
        mergedRecords: last.mergedRecords,
        sources: {
          // `records` is null for a source that did not run, and 0 for
          // one that ran and contributed nothing. MaxMind and ip2region
          // are not wired into the ETL pipeline yet (see
          // src/etl/sources/maxmind.ts and .../ip2region.ts — the
          // parsers exist but nothing calls them), so their columns stay
          // NULL and must not be reported as a measured zero.
          maxmind: {
            records: last.maxmindRecords ?? null,
            builtAt: last.maxmindBuiltAt?.toISOString() ?? null,
          },
          ip2region: {
            records: last.ip2regionRecords ?? null,
            builtAt: last.ip2regionBuiltAt?.toISOString() ?? null,
          },
          dbip: { records: last.dbipRecords ?? 0, builtAt: last.dbipBuiltAt?.toISOString() ?? null },
        },
      },
    };
  });
}
