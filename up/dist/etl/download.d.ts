import * as https from "node:https";
export interface DownloadSpec {
    /** Logical source name — matches the filenames in src/etl/pipeline.ts. */
    kind: "city" | "country" | "asn";
    /** DB-IP URL stem, e.g. 'dbip-city-lite'. */
    urlStem: string;
    /** Destination filename inside outDir, e.g. 'dbip.csv.gz'. */
    destName: string;
}
/** Per-chunk hook fired while a single file is downloading. bytesTotal
 *  is the Content-Length header value when known, or null when the
 *  server didn't send one (chunked encoding, mirrors, etc.) — the
 *  caller can still render an indeterminate progress bar in that case. */
export type DownloadProgressFn = (bytesDone: number, bytesTotal: number | null) => void;
export declare const DEFAULT_SPECS: ReadonlyArray<DownloadSpec>;
export interface DownloadResult {
    kind: DownloadSpec["kind"];
    destName: string;
    url: string;
    bytes: number;
    /** YYYY-MM the file actually came from — useful for the summary line. */
    month: string;
}
export interface DownloadFailure {
    kind: DownloadSpec["kind"];
    url: string;
    message: string;
}
export interface DownloadAttempt {
    spec: DownloadSpec;
    destName: string;
    url: string;
    status: "success" | "failed" | "missing";
    bytes: number | null;
    month: string | null;
    durationMs: number | null;
    retryCount: number;
    errorMessage: string | null;
    startedAt: Date;
    finishedAt: Date | null;
}
/**
 * Verify that a cached `.csv.gz` on disk is a complete, readable gzip
 * member — not a half-written file left behind by an interrupted run.
 *
 * Two independent checks, because either one alone has a blind spot:
 *
 *  1. **gzip magic** (`1f 8b`) — catches a file that isn't gzip at all
 *     (e.g. an HTML error page saved by a proxy).
 *  2. **Trailer ISIZE** — the last 4 bytes of a gzip member hold the
 *     uncompressed length modulo 2^32. Inflating the file and
 *     comparing the byte count against that trailer catches truncation
 *     (the common case: the process died mid-download), because a
 *     truncated member either fails to inflate at all or inflates to
 *     fewer bytes than the trailer claims.
 *
 * The trailer check needs the whole file inflated, which is expensive
 * for an 87 MB file — so the magic check runs first as a cheap reject,
 * and the inflate streams (memory stays flat) rather than buffering.
 *
 * Returns `null` when the file is intact, or a human-readable reason
 * string when it is not.
 */
export declare function validateGzFile(filePath: string): Promise<string | null>;
/** Build the candidate month list: newest first, walking back N months. */
export declare function candidateMonths(now: Date, lookback: number): string[];
/**
 * Streams one DB-IP CSV.gz file from `url` into `destPath`. Returns the
 * number of bytes written. Throws on non-2xx status or stream errors.
 *
 * The whole point of this downloader is that the city-lite file is ~87 MB
 * gzipped — buffering it in a Buffer/string blows V8's old-string limit.
 * `pipeline()` ties the HTTPS response straight into fs.createWriteStream
 * with backpressure, so memory stays flat regardless of file size.
 *
 * `onProgress` (when provided) is called once per chunk with the running
 * byte count and the Content-Length if the server provided one. We only
 * resolve `bytesTotal` once (the redirect follow loses the original
 * header), so the caller may receive null on subsequent chunks.
 */
export declare function downloadToFile(url: string, destPath: string, onProgress?: DownloadProgressFn, 
/** Test seam: the HTTPS client. Defaults to node:https; tests inject a
 *  stub that serves a truncated body so the Content-Length integrity
 *  check can be exercised without a real server. */
getImpl?: typeof https.get): Promise<number>;
/**
 * Download a single spec, walking back through candidateMonths until one
 * returns 2xx. Returns the DownloadResult with the winning month, or
 * throws if every candidate 404s / errors.
 *
 * `onProgress` (when provided) is forwarded to the underlying
 * downloadToFile so callers can drive a live progress bar. The bytes
 * reported are per-file — callers tracking the sum across files should
 * aggregate themselves.
 */
export declare function fetchOne(spec: DownloadSpec, outDir: string, now: Date, lookback?: number, onProgress?: DownloadProgressFn): Promise<DownloadResult>;
export declare function fetchOneWithAttempts(spec: DownloadSpec, outDir: string, now: Date, lookback?: number, onProgress?: DownloadProgressFn): Promise<DownloadResult>;
/** Drain the accumulated attempts from the most recent fetchOneWithAttempts call.
 *  Returns a copy so callers can't mutate the internal buffer. */
export declare function takeDownloadAttempts(): DownloadAttempt[];
/**
 * Top-level entry: fetch every requested spec, print one line per file,
 * and return a structured summary. Never throws on per-file failure —
 * the CLI command decides whether to fail the whole run.
 *
 * `onProgress` (when provided) is invoked with **cumulative** bytes
 * across every spec the downloader has already finished plus the
 * in-flight one, plus the **cumulative** expected bytes total. The UI
 * uses this to render a single "download" bar even though three files
 * are being fetched back-to-back.
 */
export declare function downloadAll(specs: ReadonlyArray<DownloadSpec>, outDir: string, now?: Date, onProgress?: DownloadProgressFn): Promise<{
    results: DownloadResult[];
    failures: DownloadFailure[];
    attempts: DownloadAttempt[];
}>;
