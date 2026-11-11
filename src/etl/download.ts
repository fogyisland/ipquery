// SPDX-License-Identifier: MIT
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as https from "node:https";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

// DB-IP distributes its free data as monthly gzipped CSVs at
// https://download.db-ip.com/free/dbip-{city,country,asn}-lite-YYYY-MM.csv.gz.
// No auth, CC-BY. We pick the newest available month: try the current
// month, fall back to previous months on 404. The ETL pipeline reads the
// files under dataDir/raw/ by their canonical names (dbip.csv.gz etc.),
// so this downloader streams each fetch straight into the canonical
// path — no temp files, no atomic-rename dance (the pipeline's truncate +
// atomicSwapRanges handles the consumer side).

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

export const DEFAULT_SPECS: ReadonlyArray<DownloadSpec> = [
  { kind: "city", urlStem: "dbip-city-lite", destName: "dbip.csv.gz" },
  { kind: "country", urlStem: "dbip-country-lite", destName: "dbip-country.csv.gz" },
  { kind: "asn", urlStem: "dbip-asn-lite", destName: "dbip-asn.csv.gz" },
];

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

// Per-file attempt record returned by the new downloadAll signature.
// The pipeline persists one row per attempt to etl_run_downloads so the
// run-detail page can show "tried N months before hitting a working
// file" without grepping the server log. `status` mirrors the
// etl_run_downloads ENUM: 'success' | 'failed' | 'missing' (every
// candidate 404'd) | 'skipped' (downstream caller decided not to
// download).
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
 * Inflate a gzip file and return the number of uncompressed bytes,
 * without holding the decompressed data in memory. Throws if the
 * member is truncated or corrupt.
 */
async function countInflatedBytes(filePath: string): Promise<number> {
  const gunzip = zlib.createGunzip();
  const source = fs.createReadStream(filePath);
  let total = 0;
  // Count the DECOMPRESSED bytes: they come out of the gunzip stream,
  // not the source stream.
  gunzip.on("data", (chunk: string | Buffer) => {
    total += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
  });
  const finished = new Promise<void>((resolve, reject) => {
    gunzip.on("end", () => resolve());
    gunzip.on("error", reject);
    source.on("error", reject);
  });
  source.pipe(gunzip);
  await finished;
  return total;
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
export async function validateGzFile(filePath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, "r");
    const { size } = await handle.stat();
    if (size < 18) {
      // Smallest valid gzip member is 20 bytes (10-byte header + 8-byte
      // trailer); anything under 18 is definitely not a complete member.
      return `file is too small to be a gzip member (${size} bytes)`;
    }
    const magic = Buffer.alloc(2);
    await handle.read(magic, 0, 2, 0);
    if (magic[0] !== 0x1f || magic[1] !== 0x8b) {
      return "file does not start with the gzip magic bytes (not a .gz file)";
    }
    const trailer = Buffer.alloc(4);
    await handle.read(trailer, 0, 4, size - 4);
    const expectedSize = trailer.readUInt32LE(0);
    await handle.close();
    handle = null;

    // Inflate in streaming mode and count the bytes. Streaming keeps
    // memory flat (the city-lite file inflates to ~300 MB) and zlib
    // validates the gzip trailer itself, so a truncated member throws
    // here ("unexpected end of file"). The explicit count comparison
    // catches the rarer case where the trailer is intact but the
    // payload was swapped.
    const inflatedBytes = await countInflatedBytes(filePath);
    if (inflatedBytes !== expectedSize) {
      return `gzip trailer claims ${expectedSize} bytes but the file inflates to ${inflatedBytes}`;
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // zlib validates the gzip trailer itself during inflate and throws
    // "incorrect header check" / "incorrect data check" / "unexpected
    // end of file" — all of them mean the member is truncated or
    // corrupt.
    return `gzip integrity check failed (truncated or corrupt trailer): ${msg}`;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/** Build the candidate month list: newest first, walking back N months. */
export function candidateMonths(now: Date, lookback: number): string[] {
  const out: string[] = [];
  // Use UTC to avoid off-by-one across midnight in the operator's tz.
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed
  for (let i = 0; i < lookback; i++) {
    const total = m - i;
    const yr = y + Math.floor(total / 12);
    const mo = ((total % 12) + 12) % 12; // normalize negative modulo
    out.push(`${yr}-${String(mo + 1).padStart(2, "0")}`);
  }
  return out;
}

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
export function downloadToFile(
  url: string,
  destPath: string,
  onProgress?: DownloadProgressFn,
  /** Test seam: the HTTPS client. Defaults to node:https; tests inject a
   *  stub that serves a truncated body so the Content-Length integrity
   *  check can be exercised without a real server. */
  getImpl: typeof https.get = https.get,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = getImpl(url, (res) => {
      const status = res.statusCode ?? 0;
      // Follow one redirect level (DB-IP occasionally moves CDN edges).
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // drain
        downloadToFile(res.headers.location, destPath, onProgress, getImpl).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status} for ${url}`));
        return;
      }
      const out = fs.createWriteStream(destPath);
      let bytes = 0;
      const lenHeader = res.headers["content-length"];
      const bytesTotal = lenHeader ? Number(lenHeader) : null;
      // Throttle progress callbacks: we get one 'data' event per chunk
      // (typically 16-64 KB) which is too noisy for a UI poll endpoint
      // running every 5s. Once per 64 KB is plenty smooth for a 100 MB
      // file (1500 events over ~10s) without spamming writes.
      const PROGRESS_GRANULARITY = 64 * 1024;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (onProgress && (bytes < PROGRESS_GRANULARITY || bytes % PROGRESS_GRANULARITY === 0)) {
          onProgress(bytes, bytesTotal);
        }
      });
      // pipeline() handles cleanup + error propagation across both sides.
      pipeline(res, out).then(
        () => {
          // Final flush so the UI sees the exact total.
          if (onProgress) onProgress(bytes, bytesTotal);
          // Integrity check: a truncated response still resolves the
          // stream cleanly (the socket closed early), so 2xx alone does
          // NOT mean we got the whole file. Compare against
          // Content-Length when the server sent one. A mismatch means
          // the file on disk is unusable — delete it so the next run
          // re-downloads instead of parsing a half-written .gz.
          if (bytesTotal !== null && Number.isFinite(bytesTotal) && bytes !== bytesTotal) {
            // Remove the half-written file before rejecting, so the
            // next run does not find a corrupt cached file.
            fs.promises
              .unlink(destPath)
              .catch(() => {
                /* best-effort: the file may already be gone */
              })
              .finally(() => {
                reject(
                  new Error(
                    `incomplete download for ${url}: got ${bytes} bytes, expected ${bytesTotal}`,
                  ),
                );
              });
            return;
          }
          resolve(bytes);
        },
        (err: Error) => reject(err),
      );
    });
    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error(`timeout after 120s for ${url}`));
    });
  });
}

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
export async function fetchOne(
  spec: DownloadSpec,
  outDir: string,
  now: Date,
  lookback = 6,
  onProgress?: DownloadProgressFn,
): Promise<DownloadResult> {
  await fsp.mkdir(outDir, { recursive: true });
  const destPath = path.join(outDir, spec.destName);
  const months = candidateMonths(now, lookback);
  const errors: string[] = [];
  for (const month of months) {
    const url = `https://download.db-ip.com/free/${spec.urlStem}-${month}.csv.gz`;
    try {
      const bytes = await downloadToFile(url, destPath, onProgress);
      return { kind: spec.kind, destName: spec.destName, url, bytes, month };
    } catch (err) {
      const msg = (err as Error).message;
      // 404 means "month not released yet" — try the previous one.
      // Anything else (network drop, 5xx, ENOTFOUND) is a hard fail.
      if (!/HTTP 404/.test(msg)) throw err;
      errors.push(`${month}: ${msg}`);
    }
  }
  throw new Error(
    `no ${spec.kind} file found in last ${lookback} months (tried ${months.join(", ")}; ${errors.join("; ")})`,
  );
}

/**
 * Variant that records every attempt (404s, successes, hard failures) as
 * a DownloadAttempt entry. Used by the pipeline so the run-detail page
 * can show "3 candidates tried, 2 were 404s, 1 succeeded with N bytes
 * in M ms". This is additive on top of fetchOne — the existing export is
 * kept for backwards compatibility with the CLI command.
 */
// Module-scoped accumulator used by fetchOneWithAttempts. One fetchOneWithAttempts
// call → many 404 attempts + one success attempt (or all-failed if every
// candidate 404s). The pipeline (Task 1.5) only ever calls this once per
// run, so a module-scoped array is safe.
const downloadAttempts: DownloadAttempt[] = [];

export async function fetchOneWithAttempts(
  spec: DownloadSpec,
  outDir: string,
  now: Date,
  lookback = 6,
  onProgress?: DownloadProgressFn,
): Promise<DownloadResult> {
  await fsp.mkdir(outDir, { recursive: true });
  const destPath = path.join(outDir, spec.destName);
  const months = candidateMonths(now, lookback);
  const errors: string[] = [];
  for (const month of months) {
    const url = `https://download.db-ip.com/free/${spec.urlStem}-${month}.csv.gz`;
    const startedAt = new Date();
    const t0 = Date.now();
    try {
      const bytes = await downloadToFile(url, destPath, onProgress);
      // Inline attempt recording keeps the original 'fetchOne' return
      // shape unchanged while emitting one success attempt. The
      // DownloadAttempt consumer (the pipeline) reads from the
      // accumulated attempts array below.
      downloadAttempts.push({
        spec,
        destName: spec.destName,
        url,
        status: "success",
        bytes,
        month,
        durationMs: Date.now() - t0,
        retryCount: 0,
        errorMessage: null,
        startedAt,
        finishedAt: new Date(),
      });
      return { kind: spec.kind, destName: spec.destName, url, bytes, month };
    } catch (err) {
      const msg = (err as Error).message;
      const is404 = /HTTP 404/.test(msg);
      downloadAttempts.push({
        spec,
        destName: spec.destName,
        url,
        status: "failed",
        bytes: null,
        month,
        durationMs: Date.now() - t0,
        retryCount: 0,
        errorMessage: msg,
        startedAt,
        finishedAt: new Date(),
      });
      if (!is404) throw err; // network drop / 5xx — hard fail
      errors.push(`${month}: ${msg}`);
    }
  }
  throw new Error(
    `no ${spec.kind} file found in last ${lookback} months (tried ${months.join(", ")}; ${errors.join("; ")})`,
  );
}

/** Drain the accumulated attempts from the most recent fetchOneWithAttempts call.
 *  Returns a copy so callers can't mutate the internal buffer. */
export function takeDownloadAttempts(): DownloadAttempt[] {
  const out = downloadAttempts.slice();
  downloadAttempts.length = 0;
  return out;
}

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
export async function downloadAll(
  specs: ReadonlyArray<DownloadSpec>,
  outDir: string,
  now: Date = new Date(),
  onProgress?: DownloadProgressFn,
): Promise<{
  results: DownloadResult[];
  failures: DownloadFailure[];
  attempts: DownloadAttempt[];
}> {
  const results: DownloadResult[] = [];
  const failures: DownloadFailure[] = [];
  // Aggregator: bytes done across all finished specs + the in-flight one.
  // Total = sum of Content-Length (when known) + bytes-done-so-far when
  // a file's total hasn't been reported yet.
  let completedBytes = 0;
  let completedTotal = 0;
  for (const spec of specs) {
    let inFlightDone = 0;
    let inFlightTotal: number | null = null;
    try {
      const r = await fetchOneWithAttempts(spec, outDir, now, 6, (chunkDone, chunkTotal) => {
        inFlightDone = chunkDone;
        if (chunkTotal !== null) inFlightTotal = chunkTotal;
        const cumDone = completedBytes + inFlightDone;
        // If any in-flight total is unknown we can't render a percentage,
        // so we pass null. Once the chunk reports Content-Length we lock
        // it in (Content-Length doesn't change mid-stream).
        const cumTotal = inFlightTotal !== null ? completedTotal + inFlightTotal : null;
        if (onProgress) onProgress(cumDone, cumTotal);
      });
      results.push(r);
      // Roll the in-flight counters into the completed totals so the
      // NEXT file's progress reports include this one's full size.
      completedBytes += r.bytes;
      completedTotal += inFlightTotal ?? r.bytes;
      const mb = (r.bytes / 1024 / 1024).toFixed(1);
      console.log(
        `[download] ${spec.kind.padEnd(7)} ${r.month}  ${mb.padStart(7)} MB  → ${path.join(outDir, r.destName)}`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      failures.push({ kind: spec.kind, url: "(see message)", message: msg });
      console.error(`[download] ${spec.kind.padEnd(7)} FAILED: ${msg}`);
    }
  }
  // Walk the attempt buffer back to attribute the "all candidates 404'd"
  // case to status='missing'. If fetchOneWithAttempts threw at the end
  // (no candidate returned 2xx), the loop pushed at least one
  // status='failed' attempt per month — we collapse those into one
  // status='missing' row for the run-detail page.
  const rawAttempts = takeDownloadAttempts();
  const bySpec = new Map<string, DownloadAttempt[]>();
  for (const a of rawAttempts) {
    const key = a.spec.destName;
    const list = bySpec.get(key) ?? [];
    list.push(a);
    bySpec.set(key, list);
  }
  const attemptOut: DownloadAttempt[] = [];
  for (const spec of specs) {
    const list = bySpec.get(spec.destName) ?? [];
    if (list.length === 0) continue;
    const anySuccess = list.some((a) => a.status === "success");
    if (anySuccess) {
      attemptOut.push(...list);
    } else {
      // All-failed → roll up into one 'missing' row that summarises the
      // candidate walk. retry_count = number of distinct months tried.
      const first = list[0]!;
      const last = list[list.length - 1]!;
      attemptOut.push({
        spec: first.spec,
        destName: first.destName,
        url: "(none)",
        status: "missing",
        bytes: null,
        month: null,
        durationMs: list.reduce((s, a) => s + (a.durationMs ?? 0), 0),
        retryCount: list.length,
        errorMessage: list.map((a) => a.month + ":" + (a.errorMessage ?? "")).join("; "),
        startedAt: first.startedAt,
        finishedAt: last.finishedAt,
      });
    }
  }
  return { results, failures, attempts: attemptOut };
}
