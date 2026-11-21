import type { Pool } from "mysql2/promise";
import type { FastifyBaseLogger } from "fastify";
/** What the export job is doing now, or what it ended up doing. */
export type RangeExportStatus = "running" | "success" | "failed";
export interface RangeExportState {
    /** The id in the URL and in the `range_exports` table. */
    readonly id: string;
    /** The file's name, without a path. */
    readonly filename: string;
    readonly countryCode: string | null;
    readonly status: RangeExportStatus;
    readonly rows: number;
    readonly bytes: number;
    readonly errorMessage: string | null;
    readonly startedAt: Date | null;
    readonly finishedAt: Date | null;
}
export interface RangeExportJob {
    readonly id: string;
    /** The file to write, with its full path. */
    readonly filepath: string;
    /** The country to restrict the export to, when the operator chose one. */
    readonly countryCode: string | null;
}
/** Is an export running right now? */
export declare function isRangeExportRunning(): boolean;
/**
 * Start an export in the background and answer the caller immediately.
 *
 * The job record is written BEFORE the work starts, so the page has
 * something to show the moment the request redirects — and so a job that
 * dies in the first millisecond still leaves a row that says it died.
 */
export declare function startRangeExport(pool: Pool, log: FastifyBaseLogger, job: Omit<RangeExportJob, "id"> & {
    id: string;
}): Promise<string>;
/**
 * Write or update the job record.
 *
 * The row is written twice for one export: once when the job starts (so
 * the page can show it) and once when it ends. The second write is a
 * plain UPDATE, not an upsert, because the id was already taken.
 */
export declare function writeRangeExport(pool: Pool, fields: {
    id: string;
    filename: string;
    countryCode: string | null;
    status: RangeExportStatus;
    rows: number;
    bytes: number;
    errorMessage: string | null;
}): Promise<void>;
/** One export job, or null when there is no such export. */
export declare function readRangeExport(pool: Pool, id: string): Promise<RangeExportState | null>;
/** The exports this install has seen, newest first. */
export declare function listRangeExports(pool: Pool, limit?: number): Promise<RangeExportState[]>;
