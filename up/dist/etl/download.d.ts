import * as fs from "node:fs";
import * as https from "node:https";
import type { EtlRunDownloadSource } from "../storage/mysql";
export type DbipKind = "city" | "country" | "asn";
export type FixedKind = "metowolf-cn" | "runishiwo-cn" | "runishiwo-v6" | "sapics-user";
export type DownloadKind = DbipKind | FixedKind;
interface SpecBase {
    destName: string;
    etlSource: EtlRunDownloadSource;
}
export interface DbipSpec extends SpecBase {
    mode: "monthly";
    kind: DbipKind;
    urlStem: string;
    validate: "gzip";
}
export interface FixedSpec extends SpecBase {
    mode: "fixed";
    kind: FixedKind;
    urls: readonly string[];
    format: "cidr" | "country-csv";
    validate: "text";
}
export type DownloadSpec = DbipSpec | FixedSpec;
/** Per-chunk hook fired while a single file is downloading. bytesTotal
 *  is the Content-Length header value when known, or null when the
 *  server didn't send one (chunked encoding, mirrors, etc.) — the
 *  caller can still render an indeterminate progress bar in that case. */
export type DownloadProgressFn = (bytesDone: number, bytesTotal: number | null) => void;
/**
 * How long the socket may stay silent before a download is abandoned.
 *
 * This is an IDLE budget, not a cap on the transfer: Node's
 * `request.setTimeout` fires when no data arrives for the given period and
 * resets on every received chunk. The city-lite file is 82 MB, so a
 * duration-based cap (the previous fixed 120 s) fails on any link slower
 * than ~0.7 MB/s — measured at 1.3 MB/s on a home connection, that left
 * almost no headroom. Two minutes of silence is the condition that actually
 * means "this transfer is dead".
 */
export declare const IDLE_TIMEOUT_MS = 120000;
/** How long a HEAD probe may take before its month is treated as unknown. */
export declare const HEAD_TIMEOUT_MS = 30000;
export declare const DEFAULT_SPECS: ReadonlyArray<DbipSpec>;
export declare const EXTRA_SPECS: ReadonlyArray<FixedSpec>;
export declare const ALL_SPECS: ReadonlyArray<DownloadSpec>;
/**
 * The sidecar that records which DB-IP month the file on disk belongs to.
 *
 * A gzip-valid cache proves the file is not truncated; it says nothing about
 * which month it holds. There was no such record, so `pipeline.ts` reused a
 * cache forever and the library stopped following DB-IP's monthly releases
 * after the first successful download. The sidecar is the missing fact: the
 * month the bytes belong to.
 *
 * It is a separate file rather than a column because the check has to work
 * before the database is involved — the CLI `download` command has no run
 * row — and because a stale sidecar next to a missing file is harmless
 * (`fileMonth` returns null when the data file is absent).
 */
export declare function monthSidecarPath(dataDir: string, destName: string): string;
/** Read the month recorded next to a cached DB-IP file, or null when there
 *  is no record (an install that downloaded before this existed, or a file
 *  somebody deleted). A null return means "month unknown" — the caller
 *  treats it as stale and refetches, which is the safe direction: one
 *  download versus a library frozen at an unknown month. */
export declare function readMonthSidecar(dataDir: string, destName: string): Promise<string | null>;
/**
 * True when the cached file for this spec is already the newest release.
 *
 * "Newest" is decided by the month the file was downloaded from, not by its
 * mtime: DB-IP publishes one file per month, so the month name is the
 * version. `newest` is the first candidate DB-IP actually has — the caller
 * resolves it by probing (see `fetchLatestMonth`), because the current
 * calendar month is not published until a few days in.
 */
export declare function isCacheCurrent(fileMonth: string | null, newest: string): boolean;
/**
 * The newest DB-IP release that exists for this spec.
 *
 * DB-IP publishes the current month's file a few days in, so the calendar
 * month is not a reliable answer — asking for the file that answers 2xx is.
 * A HEAD request is enough: the monthly download then follows the same URL.
 *
 * Returns null when nothing in the lookback window exists, which the caller
 * must treat as a hard failure rather than "reuse the cache": a cache with
 * no reachable release could be any age.
 */
export declare function probeNewestMonth(spec: DbipSpec, now: Date, lookback?: number, headImpl?: typeof headRequest): Promise<string | null>;
/** A HEAD request, following one https redirect. Kept here rather than
 *  pulled from `downloadToFile` because it fetches no body. */
export declare function headRequest(url: string, getImpl?: typeof https.get): Promise<number>;
export declare function parseDownloadKinds(input: string | undefined): DownloadSpec[];
export interface DownloadResult {
    kind: DownloadKind;
    destName: string;
    etlSource: EtlRunDownloadSource;
    url: string;
    bytes: number;
    /** YYYY-MM for DB-IP monthly files, null for fixed GitHub sources. */
    month: string | null;
    /** True when the file on disk was kept and no bytes were fetched this
     *  run — the cached month was already the newest release that exists. */
    reused?: boolean;
}
export interface DownloadFailure {
    kind: DownloadKind;
    destName: string;
    etlSource: EtlRunDownloadSource;
    url: string;
    urls: readonly string[];
    attemptCount: number;
    message: string;
}
export interface DownloadAttempt {
    spec: DownloadSpec;
    destName: string;
    url: string;
    /** `skipped` is not a failure: the file on disk already holds the newest
     *  release of its month, so nothing was fetched. */
    status: "success" | "failed" | "missing" | "skipped";
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
/**
 * Check a plain-text source without loading the 25 MB country CSV into
 * memory. One structurally valid line is enough: parsers count malformed
 * rows separately, while an HTML error page or a binary/NUL payload is a
 * download failure, not an empty dataset.
 */
export declare function validateTextFile(filePath: string, format: "cidr" | "country-csv"): Promise<string | null>;
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
 * Swap a validated temporary file into place without relying on whether
 * rename() overwrites an existing destination. A failure after the first
 * rename restores the previous cache and removes every intermediate file.
 */
export declare function replaceWithValidatedTemp(destPath: string, tmpPath: string, backupPath: string, renameImpl?: typeof fs.promises.rename, rmImpl?: typeof fs.promises.rm): Promise<void>;
export declare function fetchFixedOneWithAttempts(spec: FixedSpec, outDir: string, onProgress?: DownloadProgressFn, getImpl?: typeof https.get): Promise<DownloadResult>;
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
/**
 * Download a single DB-IP spec, walking back through candidateMonths until
 * one returns 2xx. Kept for backwards compatibility with the CLI command;
 * it delegates to `fetchOneWithAttempts` so there is one implementation.
 */
export declare function fetchOne(spec: DbipSpec, outDir: string, now: Date, lookback?: number, onProgress?: DownloadProgressFn): Promise<DownloadResult>;
export declare function fetchOneWithAttempts(spec: DownloadSpec, outDir: string, now: Date, lookback?: number, onProgress?: DownloadProgressFn, getImpl?: typeof https.get, fixedImpl?: typeof fetchFixedOneWithAttempts): Promise<DownloadResult>;
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
export declare function downloadAll(specs: ReadonlyArray<DownloadSpec>, outDir: string, now?: Date, onProgress?: DownloadProgressFn, getImpl?: typeof https.get, 
/** Seam for the fixed-file refresh layer. Tests replace this to force
 *  the "refresh failed, reuse the old cache" fallback without driving
 *  the mirror-walking fetcher. Defaults to the real implementation. */
fixedImpl?: typeof fetchFixedOneWithAttempts): Promise<{
    results: DownloadResult[];
    failures: DownloadFailure[];
    attempts: DownloadAttempt[];
}>;
export {};
