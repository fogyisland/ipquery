// SPDX-License-Identifier: MIT
//
// The names of the sources the ETL pipeline actually runs.
//
// Why this file exists
// --------------------
// The API's /stats, the MCP server's `ipquery_etl_status` and the
// marketing copy each used to carry their own hand-written list of "the
// data sources": MaxMind, ip2region and DB-IP. Only one of those was
// true. The pipeline downloaded and parsed exactly one family of files,
// and a query of the live table's `country_source` column came back
// with `dbip` and `dbip-country` and nothing else — not one row from
// MaxMind, not one from ip2region.
//
// A hand-written list of sources is a promise the code does not keep,
// and nothing fails when it quietly stops being true. The list here is
// the list of sources the pipeline parses; the ETL source table is
// exported from pipeline.ts and this module labels each entry. A source
// that is not wired into the pipeline cannot be advertised, because
// adding one to this file without adding it to the pipeline fails
// `test/unit/etl-source-labels.test.ts`.
//
// The label map is deliberately keyed by the *ETL* source label
// (`dbip-city`, `runishiwo-cn`, …) rather than the row-level source
// (`dbip`, `dbip-country`, …). The two are not the same thing: the
// `country_source` column on a row records which file family filled
// that row, while the ETL label records which of the seven files a run
// fetched. The run-level view is the one an operator asks about — "how
// much came from each download" — and it is the one the run-detail page
// and the ETL stage tables are keyed by.
import type { EtlRunDownloadSource } from "../../storage/mysql";

/** A source the ETL pipeline runs, with the name to show for it. */
export interface EtlSourceLabel {
  /** The ETL source label — the same key the run stage tables use. */
  readonly key: EtlRunDownloadSource;
  /** The name to show an operator. */
  readonly label: string;
  /**
   * True when the source's contribution is recorded on the `etl_runs`
   * row itself. The DB-IP files share one lumped counter; the rest are
   * counted per file in the stage tables.
   */
  readonly hasRunCounter: boolean;
}

/**
 * The sources the ETL pipeline runs.
 *
 * The list is the pipeline's own table, imported from pipeline.ts.
 * pipeline.ts does not import this module, so there is no cycle.
 */
export const ETL_SOURCE_LABELS: Readonly<Record<EtlRunDownloadSource, EtlSourceLabel>> = {
  "dbip-city": { key: "dbip-city", label: "DB-IP City", hasRunCounter: false },
  "dbip-country": { key: "dbip-country", label: "DB-IP Country", hasRunCounter: false },
  "dbip-asn": { key: "dbip-asn", label: "DB-IP ASN", hasRunCounter: false },
  "metowolf-cn": { key: "metowolf-cn", label: "metowolf/iplist (CN)", hasRunCounter: false },
  "runishiwo-cn": { key: "runishiwo-cn", label: "runishiwo/ChinaIPlist (CN v4)", hasRunCounter: false },
  "runishiwo-v6": { key: "runishiwo-v6", label: "runishiwo/ChinaIPlist (CN v6)", hasRunCounter: false },
  "sapics-user": { key: "sapics-user", label: "sapics/ip-location-db (user country)", hasRunCounter: false },
};

/**
 * The source list, in the order the pipeline runs them — which is the
 * order the files are fetched and the rows are filled, so it is also
 * the priority order.
 */
export function etlSourceLabels(): EtlSourceLabel[] {
  return Object.values(ETL_SOURCE_LABELS);
}

/**
 * The labels as a plain object, for a caller that wants to look a
 * source up rather than list them.
 */
export function etlSourceLabelMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const label of etlSourceLabels()) out[label.key] = label.label;
  return out;
}

/**
 * How many distinct upstreams the pipeline draws from.
 *
 * The pipeline fetches seven files, but those files come from four
 * places: DB-IP (three files), metowolf/iplist, runishiwo/ChinaIPlist
 * (two files) and sapics/ip-location-db. A page that says "N data
 * sources" means upstreams, not files — "seven data sources" would
 * read as seven independent providers, which is not what a second file
 * from the same repository is.
 *
 * Derived from the label table so it cannot drift from the pipeline
 * the way a hand-written number does.
 */
export function etlUpstreamCount(): number {
  const upstreams = new Set<string>();
  for (const label of etlSourceLabels()) {
    if (label.key.startsWith("dbip-")) upstreams.add("dbip");
    else if (label.key === "runishiwo-cn" || label.key === "runishiwo-v6") {
      upstreams.add("runishiwo");
    } else upstreams.add(label.key);
  }
  return upstreams.size;
}
