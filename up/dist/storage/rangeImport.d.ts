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
/**
 * Write records into the live table, tagged `import`.
 *
 * The row shape is this module's own, not the file's: `RangeRecord` carries
 * a `line` for error reporting and uses the file's field names, and both are
 * wrong for the column list below. Converting at the boundary keeps the two
 * vocabularies from leaking into each other.
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
export interface ImportProgress {
    /** Rows read out of the file. Monotonic: a stall can only look like a
     *  stall, never like work going backwards. */
    readonly rowsRead: number;
    readonly rowsWritten: number;
    readonly exactDuplicates: number;
    readonly contained: number;
    readonly partialOverlaps: number;
}
export interface ImportOptions {
    /** The job record to update as rows land. Omitted by callers that run
     *  inline and have nowhere to report. */
    readonly importId?: number;
    readonly onProgress?: (progress: ImportProgress) => void;
}
export interface ImportRunResult {
    /** Rows the file contributed after de-duplication. */
    readonly written: number;
    readonly exactDuplicates: number;
    readonly contained: number;
    readonly partialOverlaps: number;
    /** Rows in the table once the merge is done. */
    readonly total: number;
}
/**
 * Merge a file that is already on disk, then remove it.
 *
 * The import is the inverse of the export: once the rows are in the table
 * the bytes are only occupying space. Removing the file here rather than in
 * the caller is what makes that true whichever path got here, including the
 * one that throws.
 */
export declare function importRangesFromFile(pool: Pool, filepath: string, options?: ImportOptions): Promise<ImportRunResult>;
/**
 * Merge the ranges in `input` into the live table.
 *
 * The file is read from disk and the upload is discarded afterwards — the
 * import is the inverse of the export, and nothing about the file needs to
 * outlive it.
 *
 * On duplicates, which is most of the work on a whole-library import:
 *
 *   · An exact repeat costs one INSERT statement less when it is dropped
 *     before it reaches the database. On a file written from another
 *     install the repeats are not rare — an earlier import, or a re-export
 *     of overlapping ranges.
 *   · A range fully covered by an already-written one is dropped too. It is
 *     not a statement about a different part of the address space, and it
 *     would otherwise sit in the table as a row the lookup can never use.
 *   · A partial overlap is written anyway. Neither range is a statement
 *     about the other, and picking one would be guessing.
 *
 * The deduplication is the same shape the ETL source merge uses
 * (src/etl/sources/dedupe.ts): sort so larger ranges come first and keep a
 * window of the ranges that could still cover the current one. On a
 * nine-million-row file that is what keeps the cost linear instead of
 * quadratic.
 */
export declare function importRangesFromStream(pool: Pool, input: AsyncIterable<Buffer | string>, options?: ImportOptions): Promise<ImportRunResult>;
/** Replace the whole library with the ranges in `input`. */
export declare function replaceRangesFromStream(pool: Pool, input: AsyncIterable<Buffer | string>, options?: ImportOptions): Promise<ReplaceResult>;
/**
 * Replace the library with the contents of a file on disk.
 *
 * The large-file path for a replacement: the bytes arrive in chunks, are
 * assembled on disk, and are streamed in from there rather than held in
 * memory. The file is removed afterwards — a replacement has the same
 * answer as an import, and two gigabytes of nothing is still two
 * gigabytes.
 */
export declare function replaceRangesFromFile(pool: Pool, filepath: string, options?: ImportOptions): Promise<ReplaceResult>;
