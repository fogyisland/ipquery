// SPDX-License-Identifier: MIT
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as https from 'node:https';
import { pipeline } from 'node:stream/promises';

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
  kind: 'city' | 'country' | 'asn';
  /** DB-IP URL stem, e.g. 'dbip-city-lite'. */
  urlStem: string;
  /** Destination filename inside outDir, e.g. 'dbip.csv.gz'. */
  destName: string;
}

export const DEFAULT_SPECS: ReadonlyArray<DownloadSpec> = [
  { kind: 'city',    urlStem: 'dbip-city-lite',    destName: 'dbip.csv.gz' },
  { kind: 'country', urlStem: 'dbip-country-lite', destName: 'dbip-country.csv.gz' },
  { kind: 'asn',     urlStem: 'dbip-asn-lite',     destName: 'dbip-asn.csv.gz' },
];

export interface DownloadResult {
  kind: DownloadSpec['kind'];
  destName: string;
  url: string;
  bytes: number;
  /** YYYY-MM the file actually came from — useful for the summary line. */
  month: string;
}

export interface DownloadFailure {
  kind: DownloadSpec['kind'];
  url: string;
  message: string;
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
    out.push(`${yr}-${String(mo + 1).padStart(2, '0')}`);
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
 */
export function downloadToFile(url: string, destPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const status = res.statusCode ?? 0;
      // Follow one redirect level (DB-IP occasionally moves CDN edges).
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume(); // drain
        downloadToFile(res.headers.location, destPath).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`HTTP ${status} for ${url}`));
        return;
      }
      const out = fs.createWriteStream(destPath);
      let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; });
      // pipeline() handles cleanup + error propagation across both sides.
      pipeline(res, out).then(
        () => resolve(bytes),
        (err: Error) => reject(err),
      );
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error(`timeout after 120s for ${url}`));
    });
  });
}

/**
 * Download a single spec, walking back through candidateMonths until one
 * returns 2xx. Returns the DownloadResult with the winning month, or
 * throws if every candidate 404s / errors.
 */
export async function fetchOne(
  spec: DownloadSpec,
  outDir: string,
  now: Date,
  lookback = 6,
): Promise<DownloadResult> {
  await fsp.mkdir(outDir, { recursive: true });
  const destPath = path.join(outDir, spec.destName);
  const months = candidateMonths(now, lookback);
  const errors: string[] = [];
  for (const month of months) {
    const url = `https://download.db-ip.com/free/${spec.urlStem}-${month}.csv.gz`;
    try {
      const bytes = await downloadToFile(url, destPath);
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
    `no ${spec.kind} file found in last ${lookback} months (tried ${months.join(', ')}; ${errors.join('; ')})`,
  );
}

/**
 * Top-level entry: fetch every requested spec, print one line per file,
 * and return a structured summary. Never throws on per-file failure —
 * the CLI command decides whether to fail the whole run.
 */
export async function downloadAll(
  specs: ReadonlyArray<DownloadSpec>,
  outDir: string,
  now: Date = new Date(),
): Promise<{ results: DownloadResult[]; failures: DownloadFailure[] }> {
  const results: DownloadResult[] = [];
  const failures: DownloadFailure[] = [];
  for (const spec of specs) {
    try {
      const r = await fetchOne(spec, outDir, now);
      results.push(r);
      const mb = (r.bytes / 1024 / 1024).toFixed(1);
      console.log(`[download] ${spec.kind.padEnd(7)} ${r.month}  ${mb.padStart(7)} MB  → ${path.join(outDir, r.destName)}`);
    } catch (err) {
      const msg = (err as Error).message;
      failures.push({ kind: spec.kind, url: '(see message)', message: msg });
      console.error(`[download] ${spec.kind.padEnd(7)} FAILED: ${msg}`);
    }
  }
  return { results, failures };
}