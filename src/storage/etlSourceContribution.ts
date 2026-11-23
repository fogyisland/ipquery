// SPDX-License-Identifier: MIT
//
// Per-source ETL contribution for one run.
//
// WHY THIS EXISTS
//
// The run row (`etl_runs`) carries one lumped counter for the whole
// DB-IP family and nothing for the other six files. The per-file
// numbers live in the stage tables — `etl_run_downloads` for what was
// fetched, `etl_run_parses` for what each file yielded, `etl_run_inserts`
// for what each file put into the table.
//
// The admin run-detail page reads those tables directly. The MCP server
// could not: `ipquery_etl_status` reported a `sources` map whose only
// non-null counter was `dbip`. An operator asking an AI client "which
// source gave me the Chinese ranges?" had no way to find out.
//
// The shape
// ---------
//
// One entry per source, keyed by the ETL source label (`dbip-city`,
// `runishiwo-cn`, …). The three stage tables are joined in memory
// rather than in SQL because they have no common key beyond
// (run_id, source) and the row counts are tiny — seven sources, three
// tables.
//
// A source with no row in a given table is **absent** from that
// facet, not zero. "No parse row" and "parsed zero rows" are
// different facts, and reporting the second would be a claim the
// table does not make.
import {
  listEtlRunDownloads,
  listEtlRunInserts,
  listEtlRunParses,
  type EtlRunDownloadRow,
  type EtlRunInsertRow,
  type EtlRunParseRow,
} from "./mysql";
import { etlSourceLabelMap } from "../etl/sources/labels";
import type { Pool } from "mysql2/promise";
import type mysql from "mysql2";

/** The per-source contribution of one ETL run. */
export interface EtlSourceContribution {
  /** The ETL source label — the same key the stage tables use. */
  source: string;
  /** The name to show an operator. */
  label: string;
  /** What happened when the file was fetched. */
  downloadStatus: string | null;
  /** Bytes fetched, or null when there is no download row. */
  bytes: number | null;
  /** Rows the parser emitted for this file. */
  rowsEmitted: number | null;
  /** Rows the parser skipped, summed across every skip reason. */
  rowsSkipped: number | null;
  /** Rows the insert attempted. */
  rowsAttempted: number | null;
  /** Rows the insert wrote (new or updated). */
  rowsInserted: number | null;
  /** Rows the insert found already present. */
  rowsDuplicates: number | null;
  /** How long the insert took, in milliseconds. */
  insertDurationMs: number | null;
  /** How long the parse took, in milliseconds. */
  parseDurationMs: number | null;
}

/** The whole run's per-source contribution. */
export interface EtlSourceReport {
  /** The run the numbers are from, or null when the server has no runs. */
  runId: number | null;
  /** One entry per source that has a stage row. */
  sources: EtlSourceContribution[];
}

/** Every skip reason a parse row counts, summed into one number. */
function totalSkipped(parse: EtlRunParseRow): number {
  return (
    parse.rowsSkippedShort +
    parse.rowsSkippedHeader +
    parse.rowsSkippedUnparseableIp +
    parse.rowsSkippedMissingCol +
    parse.rowsSkippedNanAsn +
    parse.rowsSkippedOther
  );
}

/**
 * The per-source contribution of one ETL run.
 *
 * `runId` selects the run; when it is null the most recent run is
 * used. A run with no stage rows at all — a run that failed before
 * the first file landed — yields an empty source list, not a list of
 * zeros.
 */
export async function buildRunSourceReport(
  pool: Pool,
  runId: number | null,
): Promise<EtlSourceReport> {
  // Resolve the run first: the stage tables are keyed by run_id, and a
  // null run_id would match nothing without saying why.
  let targetRunId = runId;
  if (targetRunId === null) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT id FROM etl_runs ORDER BY id DESC LIMIT 1`,
    );
    const latest = rows[0];
    if (!latest) return { runId: null, sources: [] };
    targetRunId = Number(latest.id);
  }

  const [downloads, parses, inserts] = await Promise.all([
    listEtlRunDownloads(pool, targetRunId),
    listEtlRunParses(pool, targetRunId),
    listEtlRunInserts(pool, targetRunId),
  ]);

  const labels = etlSourceLabelMap();
  // Keyed by (source, destName): one run can fetch the same source
  // twice under different file names, and the three tables agree on
  // that pair. The separator is a NUL because neither a source label
  // ("dbip-city") nor a file name ("china-ipv4.txt") can contain one,
  // so the key cannot be ambiguous the way a space would make it.
  type Key = string;
  const key = (source: string, destName: string): Key => `${source}\u0000${destName}`;
  const merged = new Map<Key, EtlSourceContribution>();

  const ensure = (source: string, destName: string): EtlSourceContribution => {
    const id = key(source, destName);
    let entry = merged.get(id);
    if (!entry) {
      entry = {
        source,
        label: labels[source] ?? source,
        downloadStatus: null,
        bytes: null,
        rowsEmitted: null,
        rowsSkipped: null,
        rowsAttempted: null,
        rowsInserted: null,
        rowsDuplicates: null,
        insertDurationMs: null,
        parseDurationMs: null,
      };
      merged.set(id, entry);
    }
    return entry;
  };

  for (const download of downloads as EtlRunDownloadRow[]) {
    const entry = ensure(download.source, download.destName);
    entry.downloadStatus = download.status;
    entry.bytes = download.bytes ?? null;
  }

  for (const parse of parses as EtlRunParseRow[]) {
    const entry = ensure(parse.source, parse.destName);
    entry.rowsEmitted = parse.rowsEmitted;
    entry.rowsSkipped = totalSkipped(parse);
    entry.parseDurationMs = parse.durationMs;
  }

  for (const insert of inserts as EtlRunInsertRow[]) {
    const entry = ensure(insert.source, insert.destName);
    entry.rowsAttempted = insert.rowsAttempted;
    entry.rowsInserted = insert.rowsInserted;
    entry.rowsDuplicates = insert.rowsDuplicates;
    entry.insertDurationMs = insert.durationMs;
  }

  return { runId: targetRunId, sources: [...merged.values()] };
}
