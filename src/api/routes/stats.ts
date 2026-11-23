// SPDX-License-Identifier: MIT
import type { FastifyInstance } from "fastify";
import { lastEtlRun } from "../../storage/mysql";
import { buildEtlSourceReport } from "../../storage/etlSourceReport";

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
        // The source map is derived from the pipeline's own file table,
        // so it names the sources that actually run. It used to name
        // MaxMind and ip2region as well — neither was ever fetched or
        // parsed, and both were permanently null.
        sources: buildEtlSourceReport(last),
      },
    };
  });
}
