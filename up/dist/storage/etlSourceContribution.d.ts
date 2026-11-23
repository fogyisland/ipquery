import type { Pool } from "mysql2/promise";
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
/**
 * The per-source contribution of one ETL run.
 *
 * `runId` selects the run; when it is null the most recent run is
 * used. A run with no stage rows at all — a run that failed before
 * the first file landed — yields an empty source list, not a list of
 * zeros.
 */
export declare function buildRunSourceReport(pool: Pool, runId: number | null): Promise<EtlSourceReport>;
