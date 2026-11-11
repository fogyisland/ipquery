import * as mysql from "mysql2/promise";
import type { AppConfig } from "../config";
import type { IpRangeRow, EtlRun } from "../types";
export declare function createPool(cfg: AppConfig): mysql.Pool;
export declare function truncateNew(pool: mysql.Pool): Promise<void>;
export declare function insertIntoNew(pool: mysql.Pool, rows: IpRangeRow[]): Promise<void>;
export interface UpsertCount {
    attempted: number;
    inserted: number;
    duplicates: number;
    batchCount: number;
}
export declare function insertIntoNewUpsert(pool: mysql.Pool, rows: IpRangeRow[], fillCols: ReadonlySet<keyof IpRangeRow>): Promise<UpsertCount>;
export interface SwapResult {
    status: "success" | "failed";
    durationMs: number;
    errorMessage?: string;
}
export declare function atomicSwapRanges(pool: mysql.Pool): Promise<SwapResult>;
export declare function findRange(pool: mysql.Pool, ipBuf: Buffer): Promise<IpRangeRow | null>;
export declare function recordEtlStart(pool: mysql.Pool): Promise<number>;
export declare function recordEtlFinish(pool: mysql.Pool, id: number, status: "success" | "failed", fields: Partial<EtlRun>): Promise<void>;
/** Live-progress columns to refresh while the run is in flight. Called
 *  by the pipeline's progress sink — throttled to ≤1 UPDATE/sec to keep
 *  the poll endpoint cheap and to avoid hammering the DB during the
 *  1000-row INSERT batches. Unknown-total values (null) are stored as
 *  NULL so the UI can render an indeterminate bar. */
export declare function updateEtlRunProgress(pool: mysql.Pool, id: number, fields: {
    downloadBytesDone?: number;
    downloadBytesTotal?: number | null;
    insertRowsDone?: number;
    insertRowsTotal?: number | null;
    currentStage?: EtlRun["currentStage"];
}): Promise<void>;
/** Cheap poll target — reads ONLY the progress columns (no JOINs, no
 *  per-stage rows). The admin UI calls this every 5s while the run is
 *  running. Once the run finishes the page stops polling and switches
 *  to the regular detail view. */
export declare function getEtlRunProgress(pool: mysql.Pool, id: number): Promise<{
    status: "running" | "success" | "failed";
    currentStage: EtlRun["currentStage"] | null;
    downloadBytesDone: number;
    downloadBytesTotal: number;
    insertRowsDone: number;
    insertRowsTotal: number;
    progressUpdatedAt: Date | null;
    errorMessage: string | null;
} | null>;
export declare function lastEtlRun(pool: mysql.Pool): Promise<EtlRun | null>;
export declare function recentEtlRuns(pool: mysql.Pool, limit: number): Promise<EtlRun[]>;
export declare function lastSuccessfulEtl(pool: mysql.Pool): Promise<Date | null>;
export type EtlRunDownloadSource = "dbip-city" | "dbip-country" | "dbip-asn";
export type EtlRunDownloadStatus = "success" | "failed" | "missing" | "skipped";
export interface EtlRunDownloadRow {
    runId: number;
    source: EtlRunDownloadSource;
    destName: string;
    sourceUrl: string | null;
    month: string | null;
    status: EtlRunDownloadStatus;
    bytes: number | null;
    durationMs: number | null;
    retryCount: number;
    errorMessage: string | null;
    startedAt: Date;
    finishedAt: Date | null;
}
export declare function insertEtlRunDownload(pool: mysql.Pool, row: EtlRunDownloadRow): Promise<void>;
export declare function listEtlRunDownloads(pool: mysql.Pool, runId: number): Promise<EtlRunDownloadRow[]>;
export interface EtlRunParseRow {
    runId: number;
    source: EtlRunDownloadSource;
    destName: string;
    rowsEmitted: number;
    rowsSkippedShort: number;
    rowsSkippedHeader: number;
    rowsSkippedUnparseableIp: number;
    rowsSkippedMissingCol: number;
    rowsSkippedNanAsn: number;
    rowsSkippedOther: number;
    gunzipErrors: number;
    startedAt: Date;
    finishedAt: Date | null;
    durationMs: number | null;
}
export declare function insertEtlRunParse(pool: mysql.Pool, row: EtlRunParseRow): Promise<void>;
export declare function listEtlRunParses(pool: mysql.Pool, runId: number): Promise<EtlRunParseRow[]>;
export interface EtlRunInsertRow {
    runId: number;
    source: EtlRunDownloadSource;
    destName: string;
    rowsAttempted: number;
    rowsInserted: number;
    rowsDuplicates: number;
    batchCount: number;
    durationMs: number | null;
    startedAt: Date;
    finishedAt: Date | null;
}
export declare function insertEtlRunInsert(pool: mysql.Pool, row: EtlRunInsertRow): Promise<void>;
export declare function listEtlRunInserts(pool: mysql.Pool, runId: number): Promise<EtlRunInsertRow[]>;
export type EtlRunSwapStatus = "success" | "failed";
export interface EtlRunSwapRow {
    runId: number;
    status: EtlRunSwapStatus;
    durationMs: number | null;
    errorMessage: string | null;
    startedAt: Date;
    finishedAt: Date | null;
}
export declare function upsertEtlRunSwap(pool: mysql.Pool, row: EtlRunSwapRow): Promise<void>;
export declare function getEtlRunSwap(pool: mysql.Pool, runId: number): Promise<EtlRunSwapRow | null>;
export { runMigrations, getAppliedVersions, migrationStatus } from "./migrations/runner";
