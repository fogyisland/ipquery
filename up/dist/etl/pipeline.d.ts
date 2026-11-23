import * as mysql from "mysql2/promise";
import { type EtlRunDownloadRow } from "../storage/mysql";
import { fetchFixedOneWithAttempts, type DownloadSpec, type FixedSpec, type DownloadResult } from "./download";
import type * as https from "node:https";
import { type StreamFile } from "./sources/githubTypes";
import type { AppConfig } from "../config";
import type { EtlStage } from "../types";
/**
 * The files the ETL pipeline fetches and parses, in priority order.
 *
 * Exported so the source list the API and the MCP server report can be
 * derived from it. A hand-written list of sources is a promise the code
 * does not keep — see `src/etl/sources/labels.ts`.
 */
export declare const SOURCE_FILES: ReadonlyArray<StreamFile>;
export interface PipelineResult {
    runId: number;
    merged: number;
}
/** Throttled writer for the etl_runs progress columns. The download
 *  callback fires every 64 KB (~1500 events over a 100 MB file) and
 *  the insert callback fires every 1000 rows — far more often than
 *  the admin UI polls. We coalesce state in memory and flush at most
 *  once per second so MySQL isn't hammered. `await sink.flush()` at
 *  the end of each stage guarantees a final write before recordEtlFinish. */
export declare class EtlProgressSink {
    private readonly pool;
    private readonly runId;
    private state;
    private lastWriteAt;
    private readonly intervalMs;
    private pendingFlush;
    constructor(pool: mysql.Pool, runId: number, opts?: {
        intervalMs?: number;
    });
    /** Called once per download chunk. Aggregates into state; flushes
     *  on the throttle interval. */
    onDownload(bytesDone: number, bytesTotal: number | null): void;
    /** Called after parse completes for a file. Sets the per-run row
     *  total so the insert bar starts from 0% instead of indeterminate.
     *  `parsedRows` is a count of rows that will reach insert (skip
     *  counters already excluded by the parser). */
    onParseTotal(parsedRows: number): void;
    /** A read-only view of the counters, for tests and for callers that
     *  need the current numbers without parsing the flush. */
    getState(): Readonly<{
        downloadBytesDone: number;
        downloadBytesTotal: number | null;
        insertRowsDone: number;
        insertRowsTotal: number | null;
        currentStage: EtlStage;
    }>;
    /**
     * Called every 1000 rows during insert.
     *
     * `rowsDone` is the count of rows ATTEMPTED, not rows inserted. The
     * denominator (`onParseTotal`) is the count of rows the files will
     * yield, so the two have to be measured the same way — an inserted-only
     * numerator stops around 97% whenever the sources overlap on
     * (start_ip, end_ip) and the upsert merges them.
     */
    onInsert(rowsDone: number): void;
    setStage(stage: EtlStage): void;
    /** Force a final write. Used at the end of each pipeline stage. */
    flush(): Promise<void>;
    private maybeScheduleFlush;
}
/** Signature of the fixed-file refresh layer. It owns the
 *  "refresh failed, reuse the old cache" fallback: a mirror walk that
 *  exhausts every URL throws, and the caller decides whether a cached
 *  copy is still good enough to run. */
export type FixedRefresh = (spec: FixedSpec, outDir: string, onProgress?: (bytesDone: number, bytesTotal: number | null) => void, getImpl?: typeof https.get) => Promise<DownloadResult>;
/** Signature of the download stage. `fixedImpl` is the fixed-file
 *  refresh layer: it owns the "refresh failed, reuse the old cache"
 *  fallback, and tests replace it to exercise that path without driving
 *  the mirror-walking fetcher. */
export type DownloadStage = (pool: mysql.Pool, runId: number, rawDir: string, now: Date, sink: EtlProgressSink | undefined, specs: ReadonlyArray<DownloadSpec>, fixedImpl?: typeof fetchFixedOneWithAttempts) => Promise<EtlRunDownloadRow[]>;
export declare function runPipeline(opts: {
    cfg: AppConfig;
    runId?: number;
    /** Test seam: inject a sink so assertions can observe onInsert
     *  progress without patching the module. Defaults to a fresh sink. */
    sink?: EtlProgressSink;
    /** Test seam: replace the network download stage. The default
     *  implementation fetches the real DB-IP files; tests inject a stub
     *  so a missing/corrupt-file scenario never touches the network. */
    download?: DownloadStage;
    /** Test seam: replace the fixed-file refresh layer that owns the
     *  "refresh failed, reuse the old cache" fallback. The default walks
     *  every mirror for every fixed source and throws only when all of
     *  them are down AND there is no cached copy to fall back on. */
    downloadFixed?: FixedRefresh;
}): Promise<PipelineResult>;
