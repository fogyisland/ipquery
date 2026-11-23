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
export declare function buildEtlSourceReport(last: EtlRun): Record<string, EtlSourceReport>;
