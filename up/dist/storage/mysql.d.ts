import * as mysql from "mysql2/promise";
import type { AppConfig } from "../config";
import type { IpRangeRow, EtlRun, Source } from "../types";
/**
 * How long a statement may wait for a METADATA lock, in seconds.
 *
 * MySQL's `lock_wait_timeout` governs metadata locks — the locks
 * `RENAME TABLE` and `LOCK TABLES` take on a table's NAME. It is a
 * different thing from `innodb_lock_wait_timeout`, which governs row
 * locks. The server default is 31,536,000 seconds: a year.
 *
 * A year is a catastrophic default here, because of how metadata locks
 * queue. A SHARED lock does not block another SHARED lock, so a
 * long-running read is not by itself fatal. What is fatal is a PENDING
 * EXCLUSIVE request — the ETL's `RENAME TABLE` swap. Once one is
 * pending, every later request queues behind it, including plain reads
 * that would have been compatible with the reader already running. That
 * is what turned one stuck ETL run into a whole-site outage on
 * 2026-11-23: 47 requests queued behind a rename that was itself
 * waiting for a 42-hour-old diagnostic query to finish.
 *
 * Setting a short timeout on every pooled connection bounds the damage
 * in both directions:
 *
 *   - A read that cannot take the lock fails in seconds and reports
 *     that it was a metadata lock, so the operator knows to look for
 *     the holder rather than at row-level contention.
 *   - The swap gives up instead of sitting in the queue for a year.
 *
 * Ten seconds is long enough that an ordinary lock wait — an ETL
 * transaction committing, a backup snapshot starting — still succeeds.
 * It is short enough that a request never holds a pool connection and
 * a browser tab open for longer than a coffee break.
 */
export declare const METADATA_LOCK_WAIT_SECONDS = 10;
export declare function createPool(cfg: AppConfig): mysql.Pool;
/**
 * The five connection values plus the pool size, without the whole
 * AppConfig.
 *
 * `createPool` only ever reads `cfg.db`, so this is the honest shape of
 * its input. It exists so the setup wizard can build a candidate pool
 * for a configuration that is not `cfg` yet — without fabricating a
 * whole AppConfig object to satisfy the signature.
 */
export interface PoolConnection {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    poolSize: number;
    /**
     * Connect timeout in milliseconds.
     *
     * Optional: the normal pool leaves it at the driver's default, because
     * the long default is right for a server that should wait for a slow
     * database. The probes that run on the path to serving the wizard
     * override it with something short — an operator waiting on /init should
     * not sit through a 30-second TCP timeout.
     */
    connectTimeout?: number;
}
export declare function createPoolFor(conn: PoolConnection): mysql.Pool;
export declare function truncateNew(pool: mysql.Pool): Promise<void>;
/** The size of a range, in addresses. Exported because the .ipq importer has
 *  to compute the same value the ETL does — a file cannot be trusted to
 *  supply a column the lookup sorts by. */
export declare function computeRangeSize(startIp: Buffer, endIp: Buffer): bigint;
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
/** Rows whose origin is NOT one of the ETL's own source tags.
 *
 *  The ETL rebuilds ip_ranges from scratch: it truncates ip_ranges_new,
 *  streams the DB-IP files into it, and renames it over ip_ranges. That
 *  is the correct behaviour for the DB-IP data itself — DB-IP re-issues
 *  whole files monthly, so a full refresh is the only way to learn that
 *  a /24 was split into two /25s.
 *
 *  But it also destroys rows the ETL knows nothing about. The
 *  unknown-IP backfill writes /32 rows tagged 'multi-provider' straight
 *  into ip_ranges (see src/etl/unknownIpBackfill.ts). Those rows are
 *  the result of real lookups against external providers; the DB-IP
 *  files will never contain them, so the next ETL run silently
 *  deleted every one of them. An operator who ran the backfill, saw it
 *  work, and then refreshed the library lost the work without any
 *  error — the ETL reported success.
 *
 *  So before the swap, hand-authored rows are copied across. The ETL's
 *  own rows are not: they are the ones the refresh is meant to replace.
 */
/**
 * Source tags whose rows the ETL treats as operator-owned and carries across
 * a full refresh.
 *
 * `multi-provider` is written by the unknown-IP backfill. `import` is
 * written by the .ipq import (/admin/ranges). Both are rows the ETL did not
 * produce, and a rebuild that dropped them would silently undo the
 * operator's work — which is exactly what an untagged import would do.
 */
export declare const MANUAL_SOURCE_TAGS: readonly ["multi-provider", "import"];
/**
 * Normalize a source value read out of the database.
 *
 * The source columns on `ip_ranges` are free-form text, and they
 * predate the source tracking: a row inserted by hand, by an older
 * build, or by a backfill carries whatever was there. Two of those
 * values are "maxmind" and "ipinfo" — labels of sources this project
 * never wired into the pipeline.
 *
 * Casting such a value to the `Source` type and returning it would
 * make the API claim the data came from MaxMind for a row MaxMind
 * never touched. An unrecognized label is normalized to "unknown",
 * which is what it actually is.
 */
export declare function normalizeSource(value: unknown): Source;
export interface PreservedRows {
    /** Rows copied out of the live table into the staging table. */
    preserved: number;
    /** Rows skipped because the staging table already had that range. */
    conflicts: number;
}
/** Copies hand-authored rows from the live ip_ranges into the staging
 *  ip_ranges_new, so that the upcoming swap does not drop them.
 *
 *  Must be called AFTER the staging table has been filled with the
 *  freshly parsed ETL rows and BEFORE the RENAME — otherwise the
 *  preserved rows would be copied into a table that is about to be
 *  replaced anyway.
 *
 *  A row is copied when its country_source is a manual tag. Rows whose
 *  (start_ip, end_ip) already exist in the staging table are skipped:
 *  the ETL's row wins, because it is the more complete one (a real
 *  DB-IP segment carries city, ISP and coordinates where a backfill
 *  row carries a country code). The count of skipped rows is returned
 *  so the pipeline can report it rather than silently losing them.
 */
export declare function preserveManualRows(pool: mysql.Pool): Promise<PreservedRows>;
export declare function atomicSwapRanges(pool: mysql.Pool): Promise<SwapResult>;
/**
 * Rewrite a MySQL metadata-lock timeout into something an operator can
 * act on.
 *
 * MySQL reports the condition as ER_LOCK_WAIT_TIMEOUT (1205), whose text
 * says "Lock wait timeout exceeded; try restarting transaction". For a
 * ROW lock that is close enough to the truth. For a METADATA lock it is
 * actively misleading: the transaction is not stuck on rows, it is
 * stuck behind a lock on a table's NAME, and "restarting the
 * transaction" will not help — something else has to release it.
 *
 * The distinction matters because the two have completely different
 * fixes. A row-lock timeout is contention and resolves itself. A
 * metadata-lock timeout means a `RENAME TABLE` (the ETL's swap) or a
 * `LOCK TABLES` is holding the table, and the operator has to find it
 * and let it go.
 *
 * Non-timeout errors are returned untouched: a typo in the SQL must not
 * be reported as a lock problem.
 */
export declare function describeStorageError(err: unknown): Error;
/**
 * How long a read may wait for a metadata lock, when the caller needs
 * the answer to be quick.
 *
 * The pool's default (METADATA_LOCK_WAIT_SECONDS) is the right bound
 * for a query whose result IS the answer: /lookup cannot say anything
 * useful without the row, so it is worth waiting a few seconds.
 *
 * It is the wrong bound for a query whose result is decoration. The
 * dashboard's hero element shows the country of your most recent query;
 * when the IP table is locked that country is simply absent, and the
 * rest of the page is unaffected. Making the visitor stare at a
 * spinner for ten seconds to learn a country code they may not even
 * look at is a bad trade. Two seconds is long enough to cover an
 * ordinary lock (a committing transaction, a starting snapshot) and
 * short enough that the page still feels immediate.
 */
export declare const OPTIONAL_READ_LOCK_WAIT_SECONDS = 2;
/**
 * Look up the range covering an IP.
 *
 * `options.metadataLockWaitSeconds` overrides how long the query may
 * wait for a metadata lock on `ip_ranges`. When it is set, the query
 * runs on a dedicated connection whose session timeout is armed for
 * exactly that long — because `lock_wait_timeout` is a session
 * variable, a pooled connection's value cannot be changed for one
 * query and changed back.
 */
export declare function findRange(pool: mysql.Pool, ipBuf: Buffer, options?: {
    metadataLockWaitSeconds?: number;
}): Promise<IpRangeRow | null>;
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
export type EtlRunDownloadSource = "dbip-city" | "dbip-country" | "dbip-asn" | "metowolf-cn" | "runishiwo-cn" | "runishiwo-v6" | "sapics-user";
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
export interface EtlRunDedupeRow {
    runId: number;
    inputRows: number;
    contained: number;
    exactDuplicates: number;
    partialOverlaps: number;
    emitted: number;
    durationMs: number | null;
    startedAt: Date;
    finishedAt: Date | null;
}
export declare function insertEtlRunDedupe(pool: mysql.Pool, row: EtlRunDedupeRow): Promise<void>;
export declare function getEtlRunDedupe(pool: mysql.Pool, runId: number): Promise<EtlRunDedupeRow | null>;
export { runMigrations, getAppliedVersions, migrationStatus, getSchemaReport, getSchemaReportFrom, listMigrationEntries, buildSchemaReference, type MigrationEntry, type PendingMigration, type SchemaDrift, type SchemaReference, type SchemaReport, } from "./migrations/runner";
