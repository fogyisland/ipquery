"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALL_SPECS = exports.EXTRA_SPECS = exports.DEFAULT_SPECS = void 0;
exports.parseDownloadKinds = parseDownloadKinds;
exports.validateGzFile = validateGzFile;
exports.validateTextFile = validateTextFile;
exports.candidateMonths = candidateMonths;
exports.downloadToFile = downloadToFile;
exports.replaceWithValidatedTemp = replaceWithValidatedTemp;
exports.fetchFixedOneWithAttempts = fetchFixedOneWithAttempts;
exports.fetchOne = fetchOne;
exports.fetchOneWithAttempts = fetchOneWithAttempts;
exports.takeDownloadAttempts = takeDownloadAttempts;
exports.downloadAll = downloadAll;
// SPDX-License-Identifier: MIT
const fs = __importStar(require("node:fs"));
const fsp = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const readline = __importStar(require("node:readline"));
const https = __importStar(require("node:https"));
const promises_1 = require("node:stream/promises");
const zlib = __importStar(require("node:zlib"));
const ip_1 = require("../ip");
const dbip_1 = require("./sources/dbip");
exports.DEFAULT_SPECS = [
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
exports.EXTRA_SPECS = [
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
exports.ALL_SPECS = [...exports.DEFAULT_SPECS, ...exports.EXTRA_SPECS];
function parseDownloadKinds(input) {
    const kinds = (input ?? "")
        .split(",")
        .map((kind) => kind.trim())
        .filter(Boolean);
    const byKind = new Map(exports.ALL_SPECS.map((spec) => [spec.kind, spec]));
    const invalid = kinds.filter((kind) => !byKind.has(kind));
    if (invalid.length > 0) {
        throw new Error(`unknown --only value(s): ${invalid.join(", ")}; valid: ${exports.ALL_SPECS.map((spec) => spec.kind).join(", ")}`);
    }
    if (kinds.length === 0)
        return [...exports.ALL_SPECS];
    return kinds.map((kind) => byKind.get(kind));
}
/**
 * Inflate a gzip file and return the number of uncompressed bytes,
 * without holding the decompressed data in memory. Throws if the
 * member is truncated or corrupt.
 */
async function countInflatedBytes(filePath) {
    const gunzip = zlib.createGunzip();
    const source = fs.createReadStream(filePath);
    let total = 0;
    // Count the DECOMPRESSED bytes: they come out of the gunzip stream,
    // not the source stream.
    gunzip.on("data", (chunk) => {
        total += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    });
    const finished = new Promise((resolve, reject) => {
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
async function validateGzFile(filePath) {
    let handle = null;
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
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // zlib validates the gzip trailer itself during inflate and throws
        // "incorrect header check" / "incorrect data check" / "unexpected
        // end of file" — all of them mean the member is truncated or
        // corrupt.
        return `gzip integrity check failed (truncated or corrupt trailer): ${msg}`;
    }
    finally {
        if (handle)
            await handle.close().catch(() => { });
    }
}
function isTextStructurallyValidLine(line, format) {
    if (format === "cidr") {
        const separator = line.indexOf("/");
        const address = separator === -1 ? line : line.slice(0, separator);
        const parsed = (0, ip_1.parseIp)(address);
        if (!parsed)
            return false;
        const prefixText = separator === -1 ? null : line.slice(separator + 1);
        if (prefixText !== null && !/^\d{1,3}$/.test(prefixText))
            return false;
        const prefix = prefixText === null ? (address.includes(":") ? 128 : 32) : Number(prefixText);
        const maxPrefix = address.includes(":") ? 128 : 32;
        return prefix >= 0 && prefix <= maxPrefix;
    }
    const fields = (0, dbip_1.parseCsvLine)(line);
    if (fields.length !== 3)
        return false;
    if (!(0, ip_1.parseIp)(fields[0].trim()) || !(0, ip_1.parseIp)(fields[1].trim()))
        return false;
    return /^[A-Za-z]{2}$/.test(fields[2].trim());
}
/**
 * Check a plain-text source without loading the 25 MB country CSV into
 * memory. One structurally valid line is enough: parsers count malformed
 * rows separately, while an HTML error page or a binary/NUL payload is a
 * download failure, not an empty dataset.
 */
async function validateTextFile(filePath, format) {
    try {
        const handle = await fsp.open(filePath, "r");
        const { size } = await handle.stat();
        await handle.close();
        if (size === 0)
            return "text source is empty";
        const lines = readline.createInterface({
            input: fs.createReadStream(filePath, { encoding: "utf8" }),
            crlfDelay: Infinity,
        });
        let lineNumber = 0;
        let hasValidLine = false;
        try {
            for await (const line of lines) {
                lineNumber += 1;
                if (line.includes("\u0000"))
                    return `text source contains a NUL byte on line ${lineNumber}`;
                if (line.includes("�")) {
                    return `text source contains a replacement character on line ${lineNumber}`;
                }
                if (lineNumber === 1 && line.startsWith("<")) {
                    return "text source starts with an HTML/XML error page";
                }
                const trimmed = line.trim();
                if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//"))
                    continue;
                if (isTextStructurallyValidLine(trimmed, format))
                    hasValidLine = true;
            }
        }
        finally {
            lines.close();
        }
        if (!hasValidLine)
            return `text source has no valid ${format} record`;
        return null;
    }
    catch (err) {
        return `text source could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
}
/** Build the candidate month list: newest first, walking back N months. */
function candidateMonths(now, lookback) {
    const out = [];
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
function downloadToFile(url, destPath, onProgress, 
/** Test seam: the HTTPS client. Defaults to node:https; tests inject a
 *  stub that serves a truncated body so the Content-Length integrity
 *  check can be exercised without a real server. */
getImpl = https.get) {
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
                let target;
                try {
                    target = new URL(res.headers.location, url).toString();
                }
                catch (err) {
                    reject(new Error(`invalid redirect target from ${url}: ${err instanceof Error ? err.message : String(err)}`));
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
            res.on("data", (chunk) => {
                bytes += chunk.length;
                if (onProgress && (bytes < PROGRESS_GRANULARITY || bytes % PROGRESS_GRANULARITY === 0)) {
                    onProgress(bytes, bytesTotal);
                }
            });
            // pipeline() handles cleanup + error propagation across both sides.
            (0, promises_1.pipeline)(res, out).then(() => {
                // Final flush so the UI sees the exact total.
                if (onProgress)
                    onProgress(bytes, bytesTotal);
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
                        reject(new Error(`incomplete download for ${url}: got ${bytes} bytes, expected ${bytesTotal}`));
                    });
                    return;
                }
                resolve(bytes);
            }, (err) => reject(err));
        });
        req.on("error", reject);
        req.setTimeout(120_000, () => {
            req.destroy(new Error(`timeout after 120s for ${url}`));
        });
    });
}
async function fileExists(filePath) {
    try {
        await fsp.access(filePath);
        return true;
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT")
            return false;
        throw err;
    }
}
/**
 * Swap a validated temporary file into place without relying on whether
 * rename() overwrites an existing destination. A failure after the first
 * rename restores the previous cache and removes every intermediate file.
 */
async function replaceWithValidatedTemp(destPath, tmpPath, backupPath, renameImpl = fsp.rename, rmImpl = fsp.rm) {
    const hadPrevious = await fileExists(destPath);
    try {
        if (hadPrevious)
            await renameImpl(destPath, backupPath);
        await renameImpl(tmpPath, destPath);
        if (hadPrevious)
            await rmImpl(backupPath, { force: true });
    }
    catch (err) {
        await rmImpl(tmpPath, { force: true });
        if (hadPrevious) {
            try {
                await renameImpl(backupPath, destPath);
            }
            catch (restoreErr) {
                throw new Error(`failed to replace ${destPath}: ${err instanceof Error ? err.message : String(err)}; ` +
                    `failed to restore backup: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
            }
        }
        throw err;
    }
}
async function recordFixedAttempt(spec, url, status, bytes, startedAt, durationMs, retryCount, errorMessage) {
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
async function fetchFixedOneWithAttempts(spec, outDir, onProgress, getImpl = https.get) {
    await fsp.mkdir(outDir, { recursive: true });
    const destPath = path.join(outDir, spec.destName);
    const errors = [];
    for (const [index, url] of spec.urls.entries()) {
        const suffix = `${process.pid}-${Date.now()}-${index}`;
        const tmpPath = path.join(outDir, `${spec.destName}.part-${suffix}`);
        const backupPath = path.join(outDir, `${spec.destName}.bak-${suffix}`);
        const startedAt = new Date();
        const t0 = Date.now();
        try {
            const bytes = await downloadToFile(url, tmpPath, onProgress, getImpl);
            const problem = await validateTextFile(tmpPath, spec.format);
            if (problem)
                throw new Error(`invalid ${spec.format} payload: ${problem}`);
            await replaceWithValidatedTemp(destPath, tmpPath, backupPath);
            await recordFixedAttempt(spec, url, "success", bytes, startedAt, Date.now() - t0, index, index > 0 ? `mirror fallback after ${index} failed URL(s)` : null);
            return {
                kind: spec.kind,
                destName: spec.destName,
                etlSource: spec.etlSource,
                url,
                bytes,
                month: null,
            };
        }
        catch (err) {
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
async function fetchOne(spec, outDir, now, lookback = 6, onProgress) {
    await fsp.mkdir(outDir, { recursive: true });
    const destPath = path.join(outDir, spec.destName);
    const months = candidateMonths(now, lookback);
    const errors = [];
    for (const month of months) {
        const url = `https://download.db-ip.com/free/${spec.urlStem}-${month}.csv.gz`;
        try {
            const bytes = await downloadToFile(url, destPath, onProgress);
            return {
                kind: spec.kind,
                destName: spec.destName,
                etlSource: spec.etlSource,
                url,
                bytes,
                month,
            };
        }
        catch (err) {
            const msg = err.message;
            // 404 means "month not released yet" — try the previous one.
            // Anything else (network drop, 5xx, ENOTFOUND) is a hard fail.
            if (!/HTTP 404/.test(msg))
                throw err;
            errors.push(`${month}: ${msg}`);
        }
    }
    throw new Error(`no ${spec.kind} file found in last ${lookback} months (tried ${months.join(", ")}; ${errors.join("; ")})`);
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
const downloadAttempts = [];
async function fetchOneWithAttempts(spec, outDir, now, lookback = 6, onProgress, getImpl = https.get, fixedImpl = fetchFixedOneWithAttempts) {
    if (spec.mode === "fixed") {
        return fixedImpl(spec, outDir, onProgress, getImpl);
    }
    await fsp.mkdir(outDir, { recursive: true });
    const destPath = path.join(outDir, spec.destName);
    const months = candidateMonths(now, lookback);
    const errors = [];
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
            return {
                kind: spec.kind,
                destName: spec.destName,
                etlSource: spec.etlSource,
                url,
                bytes,
                month,
            };
        }
        catch (err) {
            const msg = err.message;
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
            if (!is404)
                throw err; // network drop / 5xx — hard fail
            errors.push(`${month}: ${msg}`);
        }
    }
    throw new Error(`no ${spec.kind} file found in last ${lookback} months (tried ${months.join(", ")}; ${errors.join("; ")})`);
}
/** Drain the accumulated attempts from the most recent fetchOneWithAttempts call.
 *  Returns a copy so callers can't mutate the internal buffer. */
function takeDownloadAttempts() {
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
async function downloadAll(specs, outDir, now = new Date(), onProgress, getImpl = https.get, 
/** Seam for the fixed-file refresh layer. Tests replace this to force
 *  the "refresh failed, reuse the old cache" fallback without driving
 *  the mirror-walking fetcher. Defaults to the real implementation. */
fixedImpl = fetchFixedOneWithAttempts) {
    const results = [];
    const failures = [];
    // Aggregator: bytes done across all finished specs + the in-flight one.
    // Total = sum of Content-Length (when known) + bytes-done-so-far when
    // a file's total hasn't been reported yet.
    let completedBytes = 0;
    let completedTotal = 0;
    for (const spec of specs) {
        let inFlightDone = 0;
        let inFlightTotal = null;
        try {
            const r = await fetchOneWithAttempts(spec, outDir, now, 6, (chunkDone, chunkTotal) => {
                inFlightDone = chunkDone;
                if (chunkTotal !== null)
                    inFlightTotal = chunkTotal;
                const cumDone = completedBytes + inFlightDone;
                // If any in-flight total is unknown we can't render a percentage,
                // so we pass null. Once the chunk reports Content-Length we lock
                // it in (Content-Length doesn't change mid-stream).
                const cumTotal = inFlightTotal !== null ? completedTotal + inFlightTotal : null;
                if (onProgress)
                    onProgress(cumDone, cumTotal);
            }, getImpl, fixedImpl);
            results.push(r);
            // Roll the in-flight counters into the completed totals so the
            // NEXT file's progress reports include this one's full size.
            completedBytes += r.bytes;
            completedTotal += inFlightTotal ?? r.bytes;
            const mb = (r.bytes / 1024 / 1024).toFixed(1);
            console.log(`[download] ${spec.kind.padEnd(12)} ${r.month ?? "fixed"}  ${mb.padStart(7)} MB  → ${path.join(outDir, r.destName)}`);
        }
        catch (err) {
            const msg = err.message;
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
    // case to status='missing'. If fetchOneWithAttempts threw at the end
    // (no candidate returned 2xx), the loop pushed at least one
    // status='failed' attempt per month — we collapse those into one
    // status='missing' row for the run-detail page.
    const rawAttempts = takeDownloadAttempts();
    const bySpec = new Map();
    for (const a of rawAttempts) {
        const key = a.spec.destName;
        const list = bySpec.get(key) ?? [];
        list.push(a);
        bySpec.set(key, list);
    }
    const attemptOut = [];
    const byFailure = new Map();
    for (const spec of specs) {
        const list = bySpec.get(spec.destName) ?? [];
        if (list.length === 0)
            continue;
        const anySuccess = list.some((a) => a.status === "success");
        if (anySuccess) {
            attemptOut.push(...list);
        }
        else if (spec.mode === "monthly") {
            // All-failed monthly candidates mean the release is missing;
            // collapse the 404 walk into one 'missing' row for run-detail.
            const first = list[0];
            const last = list[list.length - 1];
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
        }
        else {
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
function msgForFailure(spec, attempts) {
    const attemptedUrls = attempts.map((a) => a.url).join("; ");
    const reasons = attempts.map((a) => `${a.url}: ${a.errorMessage ?? "failed"}`).join("; ");
    return `刷新失败、复用旧缓存: ${spec.destName} (${attemptedUrls}; ${reasons})`;
}
//# sourceMappingURL=download.js.map