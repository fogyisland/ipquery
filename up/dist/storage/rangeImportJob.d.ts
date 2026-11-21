import type { Pool } from "mysql2/promise";
import type { FastifyBaseLogger } from "fastify";
export type RangeImportMode = "merge" | "replace";
export interface RangeImportJob {
    /** The `range_imports` row this job writes its progress to. */
    readonly importId: number;
    readonly mode: RangeImportMode;
    /** The file on disk. Removed when the job finishes, either way. */
    readonly filepath: string;
    /** The upload this file came from, when it came from one. The upload
     *  rows go when the job ends — a failed import leaves no half-uploaded
     *  file for somebody to mistake for a good one. */
    readonly uploadId: number | null;
    /** The row count the file declares, for the progress bar. */
    readonly declaredRows: number | null;
}
/** What the job turned out to be. */
export interface RangeImportOutcome {
    readonly written: number;
    readonly duplicates: number;
    readonly preserved: number;
}
/** The imports this process is running, for the page to show. */
export declare function runningRangeImports(): readonly RangeImportJob[];
/** Is an import running right now? */
export declare function isRangeImportRunning(): boolean;
/**
 * Start an import in the background and answer the caller immediately.
 *
 * The job record is written BEFORE the work starts, so the page has
 * something to show the moment the request redirects — and so a job that
 * dies in the first millisecond still leaves a row that says it died.
 */
export declare function startRangeImport(pool: Pool, log: FastifyBaseLogger, job: Omit<RangeImportJob, "importId">): Promise<number>;
