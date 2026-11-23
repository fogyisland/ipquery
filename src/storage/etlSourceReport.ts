// SPDX-License-Identifier: MIT
//
// One place that answers "which sources does the ETL pipeline run?".
//
// The API's /stats and the MCP server's `ipquery_etl_status` both
// report a source map. They used to build it by hand, and both hands
// wrote the same wrong thing: MaxMind and ip2region, neither of which
// was ever fetched or parsed. The list is now derived from the
// pipeline's own file table (see src/etl/sources/labels.ts), so the two
// callers cannot drift apart and neither can advertise a source that
// does not run.
//
// The one counter the run row itself carries is the DB-IP one. The
// other six files are counted per file in the stage tables
// (`etl_run_downloads` / `etl_run_parses` / `etl_run_inserts`), not on
// `etl_runs` — so for those the run-level map reports null, meaning
// "not counted here", not "contributed zero". Those per-file numbers
// are what the run-detail page shows.
import { etlSourceLabels } from "../etl/sources/labels";
import type { EtlRun } from "../types";

export interface EtlSourceReport {
  /** Rows this source contributed, or null when the run row does not carry it. */
  records: number | null;
  /** When the source's data was built, or null when the run row does not carry it. */
  builtAt: string | null;
}

/**
 * The source map for a finished ETL run.
 *
 * `dbip` is the lumped counter the `etl_runs` row carries. Every other
 * source is listed with a null counter: the run row has no column for
 * it, and reporting zero would be a different claim — "it ran and
 * contributed nothing" — which is not what the data says.
 */
export function buildEtlSourceReport(last: EtlRun): Record<string, EtlSourceReport> {
  const out: Record<string, EtlSourceReport> = {
    dbip: {
      records: last.dbipRecords ?? null,
      builtAt: last.dbipBuiltAt ? last.dbipBuiltAt.toISOString() : null,
    },
  };
  // The remaining sources are named so a caller can see what the
  // pipeline runs; their per-file counts live in the stage tables.
  for (const label of etlSourceLabels()) {
    if (label.key === "dbip-city" || label.key === "dbip-country" || label.key === "dbip-asn") {
      continue;
    }
    out[label.key] = { records: null, builtAt: null };
  }
  return out;
}
