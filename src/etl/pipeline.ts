// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as mysql from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2/promise';
import {
  createPool, runMigrations, truncateNew, insertIntoNewUpsert,
  atomicSwapRanges, recordEtlStart, recordEtlFinish,
  insertEtlRunDownload, insertEtlRunParse, insertEtlRunInsert,
  upsertEtlRunSwap, type EtlRunDownloadSource, type EtlRunDownloadRow,
  type EtlRunParseRow, type EtlRunInsertRow, type EtlRunSwapRow,
} from '../storage/mysql';
import {
  parseDbipCityCsvStreamWithStats, parseDbipCountryCsvStreamWithStats,
  parseDbipAsnCsvStreamWithStats, type ParseStreamResult,
} from './sources/dbip';
import { DEFAULT_SPECS, downloadAll } from './download';
import type { AppConfig } from '../config';
import type { Source, NormalizedRecord, IpRangeRow } from '../types';

// A streaming ingest target: one physical file from one logical source.
// `fillCols` says which columns this file contributes; the upsert path in
// storage/mysql.ts uses that to gate INSERT ... ON DUPLICATE KEY UPDATE so
// a later, lower-priority file (inserted later) doesn't clobber a value
// already filled by an earlier, higher-priority one. Higher priority wins
// because COALESCE(existing, new) keeps the already-present value.
interface StreamFile {
  source: Source;
  /** Logical etl_run_* source label (matches the ENUM). */
  etlSource: EtlRunDownloadSource;
  filename: string;
  /** Parse fn that returns { records, stats } so we can persist skip
   *  counters without breaking the streaming signature. */
  parse: (p: string) => ParseStreamResult;
  fillCols: ReadonlySet<keyof IpRangeRow>;
}

// Priority order matches the cross-source merger: insert maxmind first if
// present, then ip2region, then DB-IP files (city, country, asn).
const DBIP_FILES: StreamFile[] = [
  {
    source: 'dbip',
    etlSource: 'dbip-city',
    filename: 'dbip.csv.gz',
    parse: parseDbipCityCsvStreamWithStats,
    fillCols: new Set<keyof IpRangeRow>([
      'countryCode', 'region', 'city', 'latitude', 'longitude',
      'countrySource', 'citySource', 'geoSource',
    ]),
  },
  {
    source: 'dbip-country',
    etlSource: 'dbip-country',
    filename: 'dbip-country.csv.gz',
    parse: parseDbipCountryCsvStreamWithStats,
    fillCols: new Set<keyof IpRangeRow>(['countryCode', 'countrySource']),
  },
  {
    source: 'dbip-asn',
    etlSource: 'dbip-asn',
    filename: 'dbip-asn.csv.gz',
    parse: parseDbipAsnCsvStreamWithStats,
    fillCols: new Set<keyof IpRangeRow>(['asn', 'asnOrg', 'asnSource']),
  },
];

export interface PipelineResult { runId: number; merged: number; }

async function ensurePool(cfg: AppConfig): Promise<mysql.Pool> {
  const pool = createPool(cfg);
  await runMigrations(pool);
  return pool;
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function toIpRangeRow(rec: NormalizedRecord, source: Source, fillCols: ReadonlySet<keyof IpRangeRow>): IpRangeRow {
  const row: IpRangeRow = { startIp: rec.startIp, endIp: rec.endIp };
  if (fillCols.has('countryCode') && rec.countryCode) {
    row.countryCode = rec.countryCode;
    if (fillCols.has('countrySource')) row.countrySource = source;
  }
  if (fillCols.has('region') && rec.region) row.region = rec.region;
  if (fillCols.has('city') && rec.city) {
    row.city = rec.city;
    if (fillCols.has('citySource')) row.citySource = source;
  }
  if (fillCols.has('latitude') && rec.latitude !== undefined) {
    row.latitude = rec.latitude;
    if (fillCols.has('geoSource')) row.geoSource = source;
  }
  if (fillCols.has('longitude') && rec.longitude !== undefined) row.longitude = rec.longitude;
  if (fillCols.has('asn') && rec.asn !== undefined) {
    row.asn = rec.asn;
    if (fillCols.has('asnSource')) row.asnSource = source;
  }
  if (fillCols.has('asnOrg') && rec.asnOrg) row.asnOrg = rec.asnOrg;
  return row;
}

// ─── Stage helpers ─────────────────────────────────────────────────────
// Each stage owns one slice of the etl_run_* side tables. We do NOT
// INSERT a 'pending' row first then UPDATE — the schemas don't have a
// 'pending' enum value and the extra round-trip isn't worth it. Instead
// each stage does ONE insert per file once the work is done, with
// started_at + finished_at + duration_ms all populated atomically.
// Swap uses upsertEtlRunSwap so re-runs overwrite.

async function runDownloadStage(
  pool: mysql.Pool,
  runId: number,
  rawDir: string,
  now: Date,
): Promise<EtlRunDownloadRow[]> {
  const t0 = Date.now();
  const { attempts } = await downloadAll(DEFAULT_SPECS, rawDir, now);
  const elapsed = Date.now() - t0;
  console.log(`[etl] download stage: ${attempts.length} attempt(s) recorded in ${elapsed}ms`);
  const rows: EtlRunDownloadRow[] = [];
  for (const a of attempts) {
    const row: EtlRunDownloadRow = {
      runId,
      source: a.spec.kind === 'city' ? 'dbip-city' : a.spec.kind === 'country' ? 'dbip-country' : 'dbip-asn',
      destName: a.destName,
      sourceUrl: a.url === '(none)' ? null : a.url,
      month: a.month,
      status: a.status === 'missing' ? 'missing' : (a.status === 'failed' ? 'failed' : 'success'),
      bytes: a.bytes,
      durationMs: a.durationMs,
      retryCount: a.retryCount,
      errorMessage: a.errorMessage,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
    };
    await insertEtlRunDownload(pool, row);
    rows.push(row);
  }
  return rows;
}

interface ParseFile {
  source: Source;
  etlSource: EtlRunDownloadSource;
  filename: string;
  parse: (p: string) => ParseStreamResult;
}

async function runParseStage(
  pool: mysql.Pool,
  runId: number,
  rawDir: string,
  files: ParseFile[],
): Promise<EtlRunParseRow[]> {
  const rows: EtlRunParseRow[] = [];
  for (const f of files) {
    const fullPath = path.join(rawDir, f.filename);
    const startedAt = new Date();
    const t0 = Date.now();
    // Walk the file once to fill in skip counters. The actual insert
    // happens later in runInsertStage — the second walk is cheap
    // because the OS page cache holds the .gz content.
    const { records, stats } = f.parse(fullPath);
    for await (const _ of records) { void _; }
    const finishedAt = new Date();
    const row: EtlRunParseRow = {
      runId,
      source: f.etlSource,
      destName: f.filename,
      rowsEmitted: stats.rowsEmitted,
      rowsSkippedShort: stats.skipped.shortLine,
      rowsSkippedHeader: stats.skipped.headerRow,
      rowsSkippedUnparseableIp: stats.skipped.unparseableIp,
      rowsSkippedMissingCol: stats.skipped.missingCol,
      rowsSkippedNanAsn: stats.skipped.nonNumericAsn,
      rowsSkippedOther: stats.skipped.other,
      gunzipErrors: stats.gunzipErrors,
      startedAt, finishedAt,
      durationMs: Date.now() - t0,
    };
    await insertEtlRunParse(pool, row);
    rows.push(row);
    console.log(`[etl] parse ${f.etlSource}: emitted=${stats.rowsEmitted} skipped=${stats.skipped.shortLine + stats.skipped.headerRow + stats.skipped.unparseableIp + stats.skipped.missingCol + stats.skipped.nonNumericAsn + stats.skipped.other} duration=${row.durationMs}ms`);
  }
  return rows;
}

interface InsertFile {
  source: Source;
  etlSource: EtlRunDownloadSource;
  filename: string;
  parse: (p: string) => ParseStreamResult;
  fillCols: ReadonlySet<keyof IpRangeRow>;
}

async function runInsertStage(
  pool: mysql.Pool,
  runId: number,
  rawDir: string,
  files: InsertFile[],
): Promise<EtlRunInsertRow[]> {
  const rows: EtlRunInsertRow[] = [];
  for (const f of files) {
    const startedAt = new Date();
    const t0 = Date.now();
    const totals = { attempted: 0, inserted: 0, duplicates: 0, batchCount: 0 };
    let batch: IpRangeRow[] = [];
    const fullPath = path.join(rawDir, f.filename);
    for await (const rec of f.parse(fullPath).records) {
      batch.push(toIpRangeRow(rec, f.source, f.fillCols));
      if (batch.length >= 1000) {
        const c = await insertIntoNewUpsert(pool, batch, f.fillCols);
        totals.attempted += c.attempted;
        totals.inserted += c.inserted;
        totals.duplicates += c.duplicates;
        totals.batchCount += c.batchCount;
        batch = [];
      }
    }
    if (batch.length > 0) {
      const c = await insertIntoNewUpsert(pool, batch, f.fillCols);
      totals.attempted += c.attempted;
      totals.inserted += c.inserted;
      totals.duplicates += c.duplicates;
      totals.batchCount += c.batchCount;
    }
    const finishedAt = new Date();
    const row: EtlRunInsertRow = {
      runId,
      source: f.etlSource,
      destName: f.filename,
      rowsAttempted: totals.attempted,
      rowsInserted: totals.inserted,
      rowsDuplicates: totals.duplicates,
      batchCount: totals.batchCount,
      durationMs: Date.now() - t0,
      startedAt, finishedAt,
    };
    await insertEtlRunInsert(pool, row);
    rows.push(row);
    console.log(`[etl] insert ${f.etlSource}: attempted=${totals.attempted} inserted=${totals.inserted} dupes=${totals.duplicates} batches=${totals.batchCount} duration=${row.durationMs}ms`);
  }
  return rows;
}

async function runSwapStage(
  pool: mysql.Pool,
  runId: number,
): Promise<EtlRunSwapRow> {
  const startedAt = new Date();
  const result = await atomicSwapRanges(pool);
  const finishedAt = new Date();
  const row: EtlRunSwapRow = {
    runId,
    status: result.status,
    durationMs: result.durationMs,
    errorMessage: result.errorMessage ?? null,
    startedAt, finishedAt,
  };
  await upsertEtlRunSwap(pool, row);
  console.log(`[etl] swap: ${result.status} duration=${result.durationMs}ms`);
  return row;
}

// Helper: mark every in-progress stage row as 'failed' with the given
// error message. Used by the top-level catch to leave a clean trail
// when the run aborts mid-flight. Only touches rows whose finished_at
// is still NULL — already-finalised stages are left as-is.
async function markStageFailed(pool: mysql.Pool, runId: number, errorMsg: string): Promise<void> {
  const truncated = errorMsg.slice(0, 512);
  try {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE etl_run_downloads
          SET status = 'failed', error_message = ?,
              finished_at = COALESCE(finished_at, NOW(3))
        WHERE run_id = ? AND finished_at IS NULL`,
      [truncated, runId],
    );
    void res;
  } catch { /* swallow — best-effort */ }
  try {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE etl_run_swaps
          SET status = 'failed', error_message = ?,
              finished_at = COALESCE(finished_at, NOW(3))
        WHERE run_id = ? AND finished_at IS NULL`,
      [truncated, runId],
    );
    void res;
  } catch { /* swallow */ }
}

// Single top-level orchestration entry-point. Stages run sequentially
// because each depends on the previous (download → parse → insert →
// swap). Within insert, files are processed in priority order so the
// highest-priority data fills the table first and lower-priority files
// only backfill via COALESCE.
export async function runPipeline(opts: { cfg: AppConfig; runId?: number }): Promise<PipelineResult> {
  const { cfg } = opts;
  const pool = await ensurePool(cfg);
  // If the caller already created a row via recordEtlStart (e.g. the setup
  // wizard needs the runId for its progress page BEFORE the pipeline spins
  // up), reuse that id instead of inserting a new one. Saves a few hundred ms
  // of waiting on the redirect→progress page round trip.
  const runId = opts.runId ?? await recordEtlStart(pool);
  const rawDir = path.join(cfg.etl.dataDir, 'raw');
  const now = new Date();

  try {
    // 1) Decide which files we have on disk. If none are present, try
    //    to download them via the existing downloadAll.
    const present: StreamFile[] = [];
    for (const f of DBIP_FILES) {
      if (await fileExists(path.join(rawDir, f.filename))) present.push(f);
    }
    if (present.length === 0) {
      await runDownloadStage(pool, runId, rawDir, now);
      for (const f of DBIP_FILES) {
        if (await fileExists(path.join(rawDir, f.filename))) present.push(f);
      }
    } else {
      // Files already present; record one synthetic 'skipped' row per
      // spec so the run-detail page doesn't show an empty stage.
      for (const f of DBIP_FILES) {
        const exists = await fileExists(path.join(rawDir, f.filename));
        await insertEtlRunDownload(pool, {
          runId,
          source: f.etlSource,
          destName: f.filename,
          sourceUrl: null,
          month: null,
          status: exists ? 'skipped' : 'missing',
          bytes: null,
          durationMs: null,
          retryCount: 0,
          errorMessage: null,
          startedAt: now,
          finishedAt: now,
        });
      }
    }

    // 2) Parse stage: per-file skip counters.
    await runParseStage(pool, runId, rawDir, present.map((f) => ({
      source: f.source, etlSource: f.etlSource, filename: f.filename,
      parse: f.parse,
    })));

    // 3) Insert stage: truncate + per-file streamFileToDb with UpsertCount
    //    aggregation.
    await truncateNew(pool);
    await runInsertStage(pool, runId, rawDir, present.map((f) => ({
      source: f.source, etlSource: f.etlSource, filename: f.filename,
      parse: f.parse, fillCols: f.fillCols,
    })));

    // 4) Swap stage: atomic RENAME, persisted to etl_run_swaps.
    await runSwapStage(pool, runId);

    // Aggregate row counts for the legacy etl_runs summary columns. Walk
    // each file once more to count emitted records; the page cache keeps
    // this cheap.
    const counts = new Map<Source, number>();
    for (const f of present) {
      const fullPath = path.join(rawDir, f.filename);
      let n = 0;
      for await (const _ of f.parse(fullPath).records) { void _; n++; }
      counts.set(f.source, n);
    }
    const dbipRecords = counts.get('dbip') ?? 0;
    const dbipCountryRecords = counts.get('dbip-country') ?? 0;
    const dbipAsnRecords = counts.get('dbip-asn') ?? 0;
    const total = dbipRecords + dbipCountryRecords + dbipAsnRecords;
    await recordEtlFinish(pool, runId, 'success', {
      dbipRecords: total,
      mergedRecords: total,
    });
    console.log(`[etl] success run=${runId} merged=${total} (dbip=${dbipRecords}, dbip-country=${dbipCountryRecords}, dbip-asn=${dbipAsnRecords})`);
    return { runId, merged: total };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markStageFailed(pool, runId, msg);
    await recordEtlFinish(pool, runId, 'failed', { errorMessage: msg });
    console.error(`[etl] failed run=${runId}:`, msg);
    throw err;
  } finally {
    await pool.end();
  }
}