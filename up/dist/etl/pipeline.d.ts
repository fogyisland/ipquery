import * as mysql from "mysql2/promise";
import { type EtlRunDownloadRow } from "../storage/mysql";
import { type DownloadSpec } from "./download";
import type { AppConfig } from "../config";
import type { EtlStage } from "../types";
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
    /** Called every 1000 rows during insert. */
    onInsert(rowsDone: number): void;
    setStage(stage: EtlStage): void;
    /** Force a final write. Used at the end of each pipeline stage. */
    flush(): Promise<void>;
    private maybeScheduleFlush;
}
export declare function runPipeline(opts: {
    cfg: AppConfig;
    runId?: number;
    /** Test seam: inject a sink so assertions can observe onInsert
     *  progress without patching the module. Defaults to a fresh sink. */
    sink?: EtlProgressSink;
    /** Test seam: replace the network download stage. The default
     *  implementation fetches the real DB-IP files; tests inject a stub
     *  so a missing/corrupt-file scenario never touches the network. */
    download?: (pool: mysql.Pool, runId: number, rawDir: string, now: Date, sink: EtlProgressSink | undefined, specs: ReadonlyArray<DownloadSpec>) => Promise<EtlRunDownloadRow[]>;
}): Promise<PipelineResult>;
