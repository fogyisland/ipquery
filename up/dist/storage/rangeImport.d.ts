import type { Pool } from "mysql2/promise";
import type { RangeRecord } from "./rangeFile";
/** The tag every imported row carries. */
export declare const IMPORT_SOURCE_TAG = "import";
export interface ImportFailure {
    /** The line the row came from, so the operator can open the file. */
    readonly line: number;
    readonly start: string;
    readonly reason: string;
}
export interface ImportResult {
    /** Rows written (inserted or updated). */
    readonly inserted: number;
    /** Rows the batch had to skip. */
    readonly failed: number;
    readonly failures: readonly ImportFailure[];
}
/**
 * Write `records` into ip_ranges.
 *
 * A row that cannot be written is counted and named, and the import carries
 * on: one bad line in a forty-megabyte file must not cost the operator the
 * rest of it. The batch is re-run row by row when it fails as a whole, so
 * the failure names the row rather than the batch.
 */
export declare function importRanges(pool: Pool, records: readonly RangeRecord[]): Promise<ImportResult>;
