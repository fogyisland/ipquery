import type { Pool } from "mysql2/promise";
import { type RangeRecord } from "./rangeFile";
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
export interface ReplaceResult {
    /** Rows the uploaded file contributed. Does not include the rows the old
     *  table's operator-owned entries added to the result. */
    readonly written: number;
    /** Operator-owned rows carried from the old table into the new one. */
    readonly preserved: number;
    /** The table's size after the swap — `written + preserved`, minus any
     *  range the upload and the old table both had. */
    readonly total: number;
}
/**
 * A record of one import, so a long run has something to look at.
 *
 * The alternative — the request that started it holding the connection
 * open — means the job dies with the browser tab. A whole-library import
 * takes hours, so the job has to outlive the request, and this row is
 * what both the page and a later operator can see.
 */
export interface RangeImportState {
    readonly id: number;
    readonly mode: "merge" | "replace";
    readonly source: string;
    readonly status: "running" | "success" | "failed";
    /** Rows read out of the file so far. Monotonic: a stall can only ever
     *  look like a stall, never like work going backwards. */
    readonly rowsDone: number;
    readonly declaredRows: number | null;
    readonly rowsWritten: number;
    readonly preserved: number;
    readonly errorMessage: string | null;
    readonly startedAt: Date | null;
    readonly finishedAt: Date | null;
}
/** Write or update the job record. Passing an `id` updates it. */
export declare function writeRangeImportProgress(pool: Pool, fields: {
    id?: number;
    mode: "merge" | "replace";
    source: string;
    declaredRows?: number | null;
    rowsDone?: number;
    status?: "running" | "success" | "failed";
    rowsWritten?: number;
    preserved?: number;
    errorMessage?: string | null;
}): Promise<number>;
/** Move a record off `running`. Called on success and failure alike, so
 *  a crashed run never looks like one still going. */
export declare function finishRangeImport(pool: Pool, id: number, outcome: {
    status: "success" | "failed";
    rowsWritten: number;
    preserved: number;
    errorMessage: string | null;
}): Promise<void>;
export declare function readRangeImportState(pool: Pool, id: number): Promise<RangeImportState | null>;
/** The imports this install has seen, newest first. */
export declare function listRangeImports(pool: Pool, limit?: number): Promise<RangeImportState[]>;
export interface ReplaceOptions {
    /** The job record to update as rows land. Omitted by callers that run
     *  inline and have nowhere to report. */
    readonly importId?: number;
    /** Called with the running total so a long run can show a bar. */
    readonly onProgress?: (rowsDone: number) => void;
}
/**
 * Replace the whole library with the ranges in `input`.
 *
 * Staging, then RENAME — the same shape the ETL uses, for the same reason.
 * A nine-million-row merge through `ON DUPLICATE KEY UPDATE` is hours of
 * index work with the live table being written the whole time. Filling
 * `ip_ranges_new` and swapping touches the live table for the instant the
 * RENAME takes.
 *
 * What makes the swap safe to offer at all:
 *
 *   · The live table is not touched until the upload has been read to the
 *     end and every row is in the staging table. A file that turns out to
 *     be broken on its last line leaves the old table exactly as it was.
 *   · Operator-owned rows (`multi-provider`, `import`) are copied forward
 *     first, so a replacement does not silently undo an import or a
 *     backfill.
 *   · The run takes the ETL lock. Both flows truncate `ip_ranges_new` and
 *     RENAME it; running them together means one wipe takes the other's
 *     partial insert with it and the survivor is whichever rename landed
 *     second.
 */
export declare function replaceRangesFromStream(pool: Pool, input: AsyncIterable<Buffer | string>, options?: ReplaceOptions): Promise<ReplaceResult>;
