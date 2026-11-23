// SPDX-License-Identifier: MIT
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import * as https from "node:https";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { parseIp } from "../ip";
import type { EtlRunDownloadSource } from "../storage/mysql";
import { parseCsvLine } from "./sources/dbip";

// DB-IP distributes its free data as monthly gzipped CSVs at
// https://download.db-ip.com/free/dbip-{city,country,asn}-lite-YYYY-MM.csv.gz.
// Monthly files land through a validated temporary file and an atomic
// replace, exactly like the GitHub text sources, and a sidecar records which
// month the file on disk belongs to. Without that sidecar a gzip-valid cache
// looked "good" forever, so a file downloaded once in November was reused in
// December, January, … and the library silently stopped following DB-IP's
// monthly releases.
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
export const IDLE_TIMEOUT_MS = 120_000;

/** How long a HEAD probe may take before its month is treated as unknown. */
export const HEAD_TIMEOUT_MS = 30_000;

export const DEFAULT_SPECS: ReadonlyArray<DbipSpec> = [
  {
    mode: "monthly",
    kind: "city",
    urlStem: "dbip-city-lite",
    destName: "dbip.csv.gz",
    etlSource: "dbip-city",
    validate: "gzip",
  },
  {
    mode: "monthly",
    kind: "country",
    urlStem: "dbip-country-lite",
    destName: "dbip-country.csv.gz",
    etlSource: "dbip-country",
    validate: "gzip",
  },
  {
    mode: "monthly",
    kind: "asn",
    urlStem: "dbip-asn-lite",
    destName: "dbip-asn.csv.gz",
    etlSource: "dbip-asn",
    validate: "gzip",
  },
];

export const EXTRA_SPECS: ReadonlyArray<FixedSpec> = [
  {
    mode: "fixed",
    kind: "metowolf-cn",
    destName: "china-ipv4.txt",
    etlSource: "metowolf-cn",
    format: "cidr",
    validate: "text",
    urls: [
      "https://raw.githubusercontent.com/metowolf/iplist/master/data/special/china.txt",
      "https://cdn.jsdelivr.net/gh/metowolf/iplist@master/data/special/china.txt",
    ],
  },
  {
    mode: "fixed",
    kind: "runishiwo-cn",
    destName: "china-v4.txt",
    etlSource: "runishiwo-cn",
    format: "cidr",
    validate: "text",
    urls: [
      "https://raw.githubusercontent.com/runishiwo/ChinaIPlist/main/cn_v4.txt",
      "https://cdn.jsdelivr.net/gh/runishiwo/ChinaIPlist@main/cn_v4.txt",
    ],
  },
  {
    mode: "fixed",
    kind: "runishiwo-v6",
    destName: "china-v6.txt",
    etlSource: "runishiwo-v6",
    format: "cidr",
    validate: "text",
    urls: [
      "https://raw.githubusercontent.com/runishiwo/ChinaIPlist/main/cn_v6.txt",
      "https://cdn.jsdelivr.net/gh/runishiwo/ChinaIPlist@main/cn_v6.txt",
    ],
  },
  {
    mode: "fixed",
    kind: "sapics-user",
    destName: "sapics-user-country.csv",
    etlSource: "sapics-user",
    format: "country-csv",
    validate: "text",
    urls: [
      "https://github.com/sapics/ip-location-db/releases/download/latest/user-country.csv",
      "https://cdn.jsdelivr.net/gh/sapics/ip-location-db@latest/user-country.csv",
    ],
  },
];

export const ALL_SPECS: ReadonlyArray<DownloadSpec> = [...DEFAULT_SPECS, ...EXTRA_SPECS];

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
export function monthSidecarPath(dataDir: string, destName: string): string {
  return path.join(dataDir, `${destName}.month`);
}

/** Read the month recorded next to a cached DB-IP file, or null when there
 *  is no record (an install that downloaded before this existed, or a file
 *  somebody deleted). A null return means "month unknown" — the caller
 *  treats it as stale and refetches, which is the safe direction: one
 *  download versus a library frozen at an unknown month. */
export async function readMonthSidecar(dataDir: string, destName: string): Promise<string | null> {
  try {
    const text = (await fsp.readFile(monthSidecarPath(dataDir, destName), "utf8")).trim();
    return /^\d{4}-\d{2}$/.test(text) ? text : null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

async function writeMonthSidecar(dataDir: string, destName: string, month: string): Promise<void> {
  await fsp.writeFile(monthSidecarPath(dataDir, destName), `${month}\n`, "utf8");
}

/**
 * True when the cached file for this spec is already the newest release.
 *
 * "Newest" is decided by the month the file was downloaded from, not by its
 * mtime: DB-IP publishes one file per month, so the month name is the
 * version. `newest` is the first candidate DB-IP actually has — the caller
 * resolves it by probing (see `fetchLatestMonth`), because the current
 * calendar month is not published until a few days in.
 */
export function isCacheCurrent(fileMonth: string | null, newest: string): boolean {
  if (fileMonth === null) return false;
  // A cache newer than the newest release (clock skew, a hand-placed file)
  // is still usable: it is not stale.
  return fileMonth >= newest;
}

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
export async function probeNewestMonth(
  spec: DbipSpec,
  now: Date,
  lookback = 6,
  headImpl: typeof headRequest = headRequest,
): Promise<string | null> {
  for (const month of candidateMonths(now, lookback)) {
    const url = dbipMonthlyUrl(spec, month);
    try {
      const status = await headImpl(url);
      if (status >= 200 && status < 300) return month;
      // 403/404 mean "not released yet" (or already rotated away); keep
      // walking back. Anything else is a real error the caller should see.
      if (status !== 404 && status !== 403) {
        throw new Error(`HTTP ${status} for ${url}`);
      }
    } catch (err) {
      // A network failure must not be read as "this month is missing":
      // walking back would then download an OLDER release over a newer
      // cache. Surface it instead.
      throw err;
    }
  }
  return null;
}

function dbipMonthlyUrl(spec: DbipSpec, month: string): string {
  return `https://download.db-ip.com/free/${spec.urlStem}-${month}.csv.gz`;
}

/** A HEAD request, following one https redirect. Kept here rather than
 *  pulled from `downloadToFile` because it fetches no body. */
export function headRequest(url: string, getImpl: typeof https.get = https.get): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = getImpl(url, (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      if (status >= 300 && status < 400 && res.headers.location) {
        let target = "";
        try {
          target = new URL(res.headers.location, url).toString();
        } catch (err) {
          reject(
            new Error(
              `invalid redirect target from ${url}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          return;
        }
        if (!target.startsWith("https://")) {
          reject(new Error(`refusing non-https redirect for ${url}: ${target}`));
          return;
        }
        headRequest(target, getImpl).then(resolve, reject);
        return;
      }
      resolve(status);
    });
    req.on("error", reject);
    req.setTimeout(HEAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`HEAD timed out after ${Math.round(HEAD_TIMEOUT_MS / 1000)}s for ${url}`));
    });
  });
}

export function parseDownloadKinds(input: string | undefined): DownloadSpec[] {
  const kinds = (input ?? "")
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  const byKind = new Map<string, DownloadSpec>(ALL_SPECS.map((spec) => [spec.kind, spec]));
  const invalid = kinds.filter((kind) => !byKind.has(kind));
  if (invalid.length > 0) {
    throw new Error(
      `unknown --only value(s): ${invalid.join(", ")}; valid: ${ALL_SPECS.map((spec) => spec.kind).join(", ")}`,
    );
  }
  if (kinds.length === 0) return [...ALL_SPECS];
  return kinds.map((kind) => byKind.get(kind)!);
}

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

function isTextStructurallyValidLine(line: string, format: "cidr" | "country-csv"): boolean {
  if (format === "cidr") {
    const separator = line.indexOf("/");
    const address = separator === -1 ? line : line.slice(0, separator);
    const parsed = parseIp(address);
    if (!parsed) return false;
    const prefixText = separator === -1 ? null : line.slice(separator + 1);
    if (prefixText !== null && !/^\d{1,3}$/.test(prefixText)) return false;
    const prefix = prefixText === null ? (address.includes(":") ? 128 : 32) : Number(prefixText);
    const maxPrefix = address.includes(":") ? 128 : 32;
    return prefix >= 0 && prefix <= maxPrefix;
  }
  const fields = parseCsvLine(line);
  if (fields.length !== 3) return false;
  if (!parseIp(fields[0]!.trim()) || !parseIp(fields[1]!.trim())) return false;
  return /^[A-Za-z]{2}$/.test(fields[2]!.trim());
}

/**
 * Check a plain-text source without loading the 25 MB country CSV into
 * memory. One structurally valid line is enough: parsers count malformed
 * rows separately, while an HTML error page or a binary/NUL payload is a
 * download failure, not an empty dataset.
 */
export async function validateTextFile(
  filePath: string,
  format: "cidr" | "country-csv",
): Promise<string | null> {
  try {
    const handle = await fsp.open(filePath, "r");
    const { size } = await handle.stat();
    await handle.close();
    if (size === 0) return "text source is empty";
    const lines = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let lineNumber = 0;
    let hasValidLine = false;
    try {
      for await (const line of lines) {
        lineNumber += 1;
        if (line.includes("\u0000")) return `text source contains a NUL byte on line ${lineNumber}`;
        if (line.includes("�")) {
          return `text source contains a replacement character on line ${lineNumber}`;
        }
        if (lineNumber === 1 && line.startsWith("<")) {
          return "text source starts with an HTML/XML error page";
        }
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
        if (isTextStructurallyValidLine(trimmed, format)) hasValidLine = true;
      }
    } finally {
      lines.close();
    }
    if (!hasValidLine) return `text source has no valid ${format} record`;
    return null;
  } catch (err) {
    return `text source could not be read: ${err instanceof Error ? err.message : String(err)}`;
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
        // Only follow https redirects. The redirect target comes from
        // the server, so a compromised or hostile upstream could point
        // it at http:// (plaintext) or at an internal address. We
        // refuse anything that isn't https rather than following it.
        let target: string;
        try {
          target = new URL(res.headers.location, url).toString();
        } catch (err) {
          reject(
            new Error(
              `invalid redirect target from ${url}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          return;
        }
        if (!target.startsWith("https://")) {
          reject(new Error(`refusing non-https redirect for ${url}: ${target}`));
          return;
        }
        downloadToFile(target, destPath, onProgress, getImpl).then(resolve, reject);
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
                  new Error(`incomplete download for ${url}: got ${bytes} bytes, expected ${bytesTotal}`),
                );
              });
            return;
          }
          resolve(bytes);
        },
        (err: Error) => reject(err),
      );
    });
    // `req.on("error", …)` must come before the idle timer: a destroy()
    // from the timer surfaces as an 'error' event, and without the listener
    // Node would treat it as an uncaught exception instead of a rejection.
    req.on("error", reject);
    // Idle timeout, not a total-duration cap.
    //
    // This used to be `req.setTimeout(120_000)` — a budget for the whole
    // request. The city-lite file is 82 MB, and on a link that delivers
    // 1.3 MB/s (a measured home connection) the transfer takes ~66 s with
    // nothing left over for a slow start; one 120 s miss and the run failed,
    // leaving a truncated cache on disk. That number was a statement about
    // how long the operator's link takes, which the code cannot know.
    //
    // In Node an http request's `setTimeout` is an INACTIVITY timer: it
    // fires when the socket goes quiet for the given period, and each
    // received chunk resets it. So the value below means "give up after two
    // minutes of silence" — the condition actually worth failing on — while
    // a slow but moving transfer is left alone.
    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`no data for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s while downloading ${url}`));
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Swap a validated temporary file into place without relying on whether
 * rename() overwrites an existing destination. A failure after the first
 * rename restores the previous cache and removes every intermediate file.
 */
export async function replaceWithValidatedTemp(
  destPath: string,
  tmpPath: string,
  backupPath: string,
  renameImpl: typeof fs.promises.rename = fsp.rename,
  rmImpl: typeof fs.promises.rm = fsp.rm,
): Promise<void> {
  const hadPrevious = await fileExists(destPath);
  try {
    if (hadPrevious) await renameImpl(destPath, backupPath);
    await renameImpl(tmpPath, destPath);
    if (hadPrevious) await rmImpl(backupPath, { force: true });
  } catch (err) {
    await rmImpl(tmpPath, { force: true });
    if (hadPrevious) {
      try {
        await renameImpl(backupPath, destPath);
      } catch (restoreErr) {
        throw new Error(
          `failed to replace ${destPath}: ${err instanceof Error ? err.message : String(err)}; ` +
            `failed to restore backup: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`,
        );
      }
    }
    throw err;
  }
}

async function recordFixedAttempt(
  spec: FixedSpec,
  url: string,
  status: "success" | "failed",
  bytes: number | null,
  startedAt: Date,
  durationMs: number,
  retryCount: number,
  errorMessage: string | null,
): Promise<void> {
  downloadAttempts.push({
    spec,
    destName: spec.destName,
    url,
    status,
    bytes,
    month: null,
    durationMs,
    retryCount,
    errorMessage,
    startedAt,
    finishedAt: new Date(),
  });
}

export async function fetchFixedOneWithAttempts(
  spec: FixedSpec,
  outDir: string,
  onProgress?: DownloadProgressFn,
  getImpl: typeof https.get = https.get,
): Promise<DownloadResult> {
  await fsp.mkdir(outDir, { recursive: true });
  const destPath = path.join(outDir, spec.destName);
  const errors: string[] = [];
  for (const [index, url] of spec.urls.entries()) {
    const suffix = `${process.pid}-${Date.now()}-${index}`;
    const tmpPath = path.join(outDir, `${spec.destName}.part-${suffix}`);
    const backupPath = path.join(outDir, `${spec.destName}.bak-${suffix}`);
    const startedAt = new Date();
    const t0 = Date.now();
    try {
      const bytes = await downloadToFile(url, tmpPath, onProgress, getImpl);
      const problem = await validateTextFile(tmpPath, spec.format);
      if (problem) throw new Error(`invalid ${spec.format} payload: ${problem}`);
      await replaceWithValidatedTemp(destPath, tmpPath, backupPath);
      await recordFixedAttempt(
        spec,
        url,
        "success",
        bytes,
        startedAt,
        Date.now() - t0,
        index,
        index > 0 ? `mirror fallback after ${index} failed URL(s)` : null,
      );
      return {
        kind: spec.kind,
        destName: spec.destName,
        etlSource: spec.etlSource,
        url,
        bytes,
        month: null,
      };
    } catch (err) {
      await fsp.rm(tmpPath, { force: true });
      await fsp.rm(backupPath, { force: true });
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${url}: ${message}`);
      await recordFixedAttempt(spec, url, "failed", null, startedAt, Date.now() - t0, index, message);
    }
  }
  throw new Error(`刷新失败、复用旧缓存: ${spec.destName} (${errors.join("; ")})`);
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
/**
 * Download a single DB-IP spec, walking back through candidateMonths until
 * one returns 2xx. Kept for backwards compatibility with the CLI command;
 * it delegates to `fetchOneWithAttempts` so there is one implementation.
 */
export async function fetchOne(
  spec: DbipSpec,
  outDir: string,
  now: Date,
  lookback = 6,
  onProgress?: DownloadProgressFn,
): Promise<DownloadResult> {
  try {
    return await fetchOneWithAttempts(spec, outDir, now, lookback, onProgress);
  } finally {
    // fetchOne's caller has no use for the attempt records; draining them
    // keeps them from leaking into the next downloadAll call.
    takeDownloadAttempts();
  }
}

/**
 * Variant that records every attempt (404s, successes, hard failures) as
 * a DownloadAttempt entry. Used by the pipeline so the run-detail page
 * can show "3 candidates tried, 2 were 404s, 1 succeeded with N bytes
 * in M ms". This is additive on top of fetchOne — the existing export is
 * kept for backwards compatibility with the CLI command.
 */
// Module-scoped accumulator used by fetchOneWithAttempts. Every downloadAll
// call drains it at the end with takeDownloadAttempts(), so one call's
// monthly 404 attempts cannot leak into the next call's fixed-source rows.
const downloadAttempts: DownloadAttempt[] = [];

export async function fetchOneWithAttempts(
  spec: DownloadSpec,
  outDir: string,
  now: Date,
  lookback = 6,
  onProgress?: DownloadProgressFn,
  getImpl: typeof https.get = https.get,
  fixedImpl: typeof fetchFixedOneWithAttempts = fetchFixedOneWithAttempts,
): Promise<DownloadResult> {
  if (spec.mode === "fixed") {
    return fixedImpl(spec, outDir, onProgress, getImpl);
  }
  await fsp.mkdir(outDir, { recursive: true });
  const destPath = path.join(outDir, spec.destName);

  // Which release is on disk, and which one DB-IP currently publishes.
  //
  // The month is the version of a DB-IP file, so the comparison below is
  // the only thing that keeps the library following the monthly releases.
  // Before this existed the cache was reused on "the gzip is intact",
  // which stays true forever — the library froze at the month of the first
  // successful download and every later run reported `skipped` + success.
  const cachedMonth = await readMonthSidecar(outDir, spec.destName);
  const newestMonth = await probeNewestMonth(spec, now, lookback, (url) => headRequest(url, getImpl));
  if (newestMonth === null) {
    // No release reachable in the whole lookback window. Do NOT fall back
    // to the cache here: its month is unknown, and an operator needs to
    // see that the source is unreachable rather than a green run.
    throw new Error(`no ${spec.kind} release at download.db-ip.com in the last ${lookback} months`);
  }

  if (isCacheCurrent(cachedMonth, newestMonth)) {
    // The month matches, but the bytes still have to be a whole gzip
    // member: a truncated file paired with a valid sidecar would otherwise
    // be reused forever. `validateGzFile` also reports a missing file, so
    // this covers "the sidecar survived a manual delete".
    const cachedProblem = await validateGzFile(destPath);
    if (cachedProblem === null) {
      const stat = await fsp.stat(destPath);
      const startedAt = new Date();
      downloadAttempts.push({
        spec,
        destName: spec.destName,
        url: dbipMonthlyUrl(spec, cachedMonth!),
        status: "skipped",
        bytes: stat.size,
        month: cachedMonth,
        durationMs: 0,
        retryCount: 0,
        errorMessage: null,
        startedAt,
        finishedAt: startedAt,
      });
      return {
        kind: spec.kind,
        destName: spec.destName,
        etlSource: spec.etlSource,
        url: dbipMonthlyUrl(spec, cachedMonth!),
        bytes: stat.size,
        month: cachedMonth,
        reused: true,
      };
    }
  }

  // A newer release exists (or the cached month is unknown): fetch it into
  // a temporary file, prove it is a whole gzip member, then swap it in.
  //
  // The temp+rename is what the fixed sources already do, and it matters
  // for the same reason: a run interrupted mid-transfer must leave the
  // previous cache usable instead of a half-written .gz in its place. The
  // old code streamed straight into the canonical path, so a timeout at
  // 60 MB left a 60 MB "cache" behind — which is exactly the truncated
  // dbip.csv.gz found on this machine.
  const suffix = `${process.pid}-${Date.now()}`;
  const tmpPath = path.join(outDir, `${spec.destName}.part-${suffix}`);
  const backupPath = path.join(outDir, `${spec.destName}.bak-${suffix}`);
  const url = dbipMonthlyUrl(spec, newestMonth);
  const startedAt = new Date();
  const t0 = Date.now();
  try {
    const bytes = await downloadToFile(url, tmpPath, onProgress, getImpl);
    const problem = await validateGzFile(tmpPath);
    if (problem) throw new Error(`invalid gzip payload: ${problem}`);
    await replaceWithValidatedTemp(destPath, tmpPath, backupPath);
    await writeMonthSidecar(outDir, spec.destName, newestMonth);
    downloadAttempts.push({
      spec,
      destName: spec.destName,
      url,
      status: "success",
      bytes,
      month: newestMonth,
      durationMs: Date.now() - t0,
      retryCount: 0,
      errorMessage: null,
      startedAt,
      finishedAt: new Date(),
    });
    return {
      kind: spec.kind,
      destName: spec.destName,
      etlSource: spec.etlSource,
      url,
      bytes,
      month: newestMonth,
    };
  } catch (err) {
    await fsp.rm(tmpPath, { force: true });
    await fsp.rm(backupPath, { force: true });
    const msg = err instanceof Error ? err.message : String(err);
    downloadAttempts.push({
      spec,
      destName: spec.destName,
      url,
      status: "failed",
      bytes: null,
      month: newestMonth,
      durationMs: Date.now() - t0,
      retryCount: 0,
      errorMessage: msg,
      startedAt,
      finishedAt: new Date(),
    });
    throw err;
  }
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
  getImpl: typeof https.get = https.get,
  /** Seam for the fixed-file refresh layer. Tests replace this to force
   *  the "refresh failed, reuse the old cache" fallback without driving
   *  the mirror-walking fetcher. Defaults to the real implementation. */
  fixedImpl: typeof fetchFixedOneWithAttempts = fetchFixedOneWithAttempts,
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
      const r = await fetchOneWithAttempts(
        spec,
        outDir,
        now,
        6,
        (chunkDone, chunkTotal) => {
          inFlightDone = chunkDone;
          if (chunkTotal !== null) inFlightTotal = chunkTotal;
          const cumDone = completedBytes + inFlightDone;
          // If any in-flight total is unknown we can't render a percentage,
          // so we pass null. Once the chunk reports Content-Length we lock
          // it in (Content-Length doesn't change mid-stream).
          const cumTotal = inFlightTotal !== null ? completedTotal + inFlightTotal : null;
          if (onProgress) onProgress(cumDone, cumTotal);
        },
        getImpl,
        fixedImpl,
      );
      results.push(r);
      // Roll the in-flight counters into the completed totals so the
      // NEXT file's progress reports include this one's full size.
      completedBytes += r.bytes;
      completedTotal += inFlightTotal ?? r.bytes;
      const mb = (r.bytes / 1024 / 1024).toFixed(1);
      console.log(
        `[download] ${spec.kind.padEnd(12)} ${r.month ?? "fixed"}  ${mb.padStart(7)} MB  → ${path.join(outDir, r.destName)}`,
      );
    } catch (err) {
      const msg = (err as Error).message;
      const failureUrls = spec.mode === "fixed" ? spec.urls : [];
      failures.push({
        kind: spec.kind,
        destName: spec.destName,
        etlSource: spec.etlSource,
        url: failureUrls[0] ?? "(see message)",
        urls: failureUrls,
        attemptCount: failureUrls.length || 1,
        message: msg,
      });
      console.error(`[download] ${spec.kind.padEnd(12)} FAILED: ${msg}`);
    }
  }
  // Walk the attempt buffer back to attribute the "all candidates 404'd"
  // case to status='missing'. A spec whose cache was already the newest
  // release produced exactly one 'skipped' attempt and is passed through
  // unchanged — it is not a failure, and it is not 'missing' either.
  const rawAttempts = takeDownloadAttempts();
  const bySpec = new Map<string, DownloadAttempt[]>();
  for (const a of rawAttempts) {
    const key = a.spec.destName;
    const list = bySpec.get(key) ?? [];
    list.push(a);
    bySpec.set(key, list);
  }
  const attemptOut: DownloadAttempt[] = [];
  const byFailure = new Map<string, { attempts: DownloadAttempt[]; message: string }>();
  for (const spec of specs) {
    const list = bySpec.get(spec.destName) ?? [];
    if (list.length === 0) continue;
    const settled = list.some((a) => a.status === "success" || a.status === "skipped");
    if (settled) {
      attemptOut.push(...list);
    } else if (spec.mode === "monthly") {
      // All-failed monthly candidates mean the release is missing;
      // collapse the 404 walk into one 'missing' row for run-detail.
      const first = list[0]!;
      const last = list[list.length - 1]!;
      attemptOut.push({
        spec: first.spec,
        destName: first.destName,
        url: "(none)",
        status: "missing",
        bytes: null,
        month: null,
        durationMs: list.reduce((sum, a) => sum + (a.durationMs ?? 0), 0),
        retryCount: list.length,
        errorMessage: list.map((a) => `${a.month ?? a.url}:${a.errorMessage ?? ""}`).join("; "),
        startedAt: first.startedAt,
        finishedAt: last.finishedAt,
      });
    } else {
      // A fixed refresh failure is never 'missing': every failed URL is
      // visible and the stage layer can record one 'failed' row that says
      // the previous validated cache is being reused.
      attemptOut.push(...list);
      byFailure.set(spec.destName, { attempts: list, message: msgForFailure(spec, list) });
    }
  }
  for (const [destName, details] of byFailure) {
    const failure = failures.find((f) => f.destName === destName);
    if (failure) {
      failure.attemptCount = details.attempts.length;
      failure.message = details.message;
    }
  }
  return { results, failures, attempts: attemptOut };
}

function msgForFailure(spec: FixedSpec, attempts: DownloadAttempt[]): string {
  const attemptedUrls = attempts.map((a) => a.url).join("; ");
  const reasons = attempts.map((a) => `${a.url}: ${a.errorMessage ?? "failed"}`).join("; ");
  return `刷新失败、复用旧缓存: ${spec.destName} (${attemptedUrls}; ${reasons})`;
}
