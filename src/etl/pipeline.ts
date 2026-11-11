// SPDX-License-Identifier: MIT
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as mysql from "mysql2/promise";
import type { ResultSetHeader } from "mysql2/promise";
import {
  createPool,
  runMigrations,
  truncateNew,
  insertIntoNewUpsert,
  preserveManualRows,
  atomicSwapRanges,
  recordEtlStart,
  recordEtlFinish,
  updateEtlRunProgress,
  insertEtlRunDownload,
  insertEtlRunParse,
  insertEtlRunInsert,
  upsertEtlRunSwap,
  type EtlRunDownloadSource,
  type EtlRunDownloadRow,
  type EtlRunParseRow,
  type EtlRunInsertRow,
  type EtlRunSwapRow,
} from "../storage/mysql";
import {
  parseDbipCityCsvStreamWithStats,
  parseDbipCountryCsvStreamWithStats,
  parseDbipAsnCsvStreamWithStats,
  type ParseStreamResult,
} from "./sources/dbip";
import { DEFAULT_SPECS, downloadAll, validateGzFile, type DownloadSpec } from "./download";
import { acquireEtlRunLock, EtlRunLockedError } from "./runGuard";
import type { AppConfig } from "../config";
import type { Source, NormalizedRecord, IpRangeRow, EtlStage } from "../types";

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

// Priority order matches the cross-source merge: insert maxmind first if
// present, then ip2region, then DB-IP files (city, country, asn). Each
// file fills only its own columns, so a lower-priority file can never
// overwrite a higher-priority one.
const DBIP_FILES: StreamFile[] = [
  {
    source: "dbip",
    etlSource: "dbip-city",
    filename: "dbip.csv.gz",
    parse: parseDbipCityCsvStreamWithStats,
    fillCols: new Set<keyof IpRangeRow>([
      "countryCode",
      "region",
      "city",
      "latitude",
      "longitude",
      "countrySource",
      "citySource",
      "geoSource",
    ]),
  },
  {
    source: "dbip-country",
    etlSource: "dbip-country",
    filename: "dbip-country.csv.gz",
    parse: parseDbipCountryCsvStreamWithStats,
    fillCols: new Set<keyof IpRangeRow>(["countryCode", "countrySource"]),
  },
  {
    source: "dbip-asn",
    etlSource: "dbip-asn",
    filename: "dbip-asn.csv.gz",
    parse: parseDbipAsnCsvStreamWithStats,
    fillCols: new Set<keyof IpRangeRow>(["asn", "asnOrg", "asnSource"]),
  },
];

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
export class EtlProgressSink {
  private state: {
    downloadBytesDone: number;
    downloadBytesTotal: number | null;
    insertRowsDone: number;
    insertRowsTotal: number | null;
    currentStage: EtlStage;
  } = {
    downloadBytesDone: 0,
    downloadBytesTotal: null,
    insertRowsDone: 0,
    insertRowsTotal: null,
    currentStage: "download",
  };
  private lastWriteAt = 0;
  private readonly intervalMs: number;
  private pendingFlush: Promise<void> | null = null;

  constructor(
    private readonly pool: mysql.Pool,
    private readonly runId: number,
    opts?: { intervalMs?: number },
  ) {
    this.intervalMs = opts?.intervalMs ?? 1000;
  }

  /** Called once per download chunk. Aggregates into state; flushes
   *  on the throttle interval. */
  onDownload(bytesDone: number, bytesTotal: number | null): void {
    this.state.downloadBytesDone = bytesDone;
    if (bytesTotal !== null) this.state.downloadBytesTotal = bytesTotal;
    this.maybeScheduleFlush();
  }

  /** Called after parse completes for a file. Sets the per-run row
   *  total so the insert bar starts from 0% instead of indeterminate.
   *  `parsedRows` is a count of rows that will reach insert (skip
   *  counters already excluded by the parser). */
  onParseTotal(parsedRows: number): void {
    // Sum across files so the bar tracks the full pipeline, not the
    // current file. insertRowsDone is monotonic so summing here is safe.
    this.state.insertRowsTotal = (this.state.insertRowsTotal ?? 0) + parsedRows;
    this.maybeScheduleFlush();
  }

  /** Called every 1000 rows during insert. */
  onInsert(rowsDone: number): void {
    this.state.insertRowsDone = rowsDone;
    this.maybeScheduleFlush();
  }

  setStage(stage: EtlStage): void {
    if (this.state.currentStage === stage) return;
    this.state.currentStage = stage;
    // Stage transitions should land on disk immediately so the UI can
    // hide the previous bar — bypass the throttle.
    this.flush().catch(() => undefined);
  }

  /** Force a final write. Used at the end of each pipeline stage. */
  async flush(): Promise<void> {
    if (this.pendingFlush) {
      // Wait for the in-flight flush, then issue our own with current state.
      try {
        await this.pendingFlush;
      } catch (err) {
        // The in-flight write failed but the flush below re-writes the
        // current state, so the run continues. Logged so a repeatedly
        // failing progress write is visible.
        console.warn(
          `[etl] pending progress flush failed for run ${this.runId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const write = updateEtlRunProgress(this.pool, this.runId, {
      downloadBytesDone: this.state.downloadBytesDone,
      downloadBytesTotal: this.state.downloadBytesTotal ?? undefined,
      insertRowsDone: this.state.insertRowsDone,
      insertRowsTotal: this.state.insertRowsTotal ?? undefined,
      currentStage: this.state.currentStage,
    });
    this.pendingFlush = write.then(() => undefined, () => undefined);
    await write;
    this.lastWriteAt = Date.now();
    this.pendingFlush = null;
  }

  private maybeScheduleFlush(): void {
    const now = Date.now();
    const since = now - this.lastWriteAt;
    if (since >= this.intervalMs) {
      // Fire-and-forget; .flush() is awaited at stage boundaries.
      this.flush().catch(() => undefined);
    }
  }
}

async function ensurePool(cfg: AppConfig): Promise<mysql.Pool> {
  const pool = createPool(cfg);
  await runMigrations(pool);
  return pool;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function toIpRangeRow(
  rec: NormalizedRecord,
  source: Source,
  fillCols: ReadonlySet<keyof IpRangeRow>,
): IpRangeRow {
  const row: IpRangeRow = { startIp: rec.startIp, endIp: rec.endIp };
  if (fillCols.has("countryCode") && rec.countryCode) {
    row.countryCode = rec.countryCode;
    if (fillCols.has("countrySource")) row.countrySource = source;
  }
  if (fillCols.has("region") && rec.region) row.region = rec.region;
  if (fillCols.has("city") && rec.city) {
    row.city = rec.city;
    if (fillCols.has("citySource")) row.citySource = source;
  }
  if (fillCols.has("latitude") && rec.latitude !== undefined) {
    row.latitude = rec.latitude;
    if (fillCols.has("geoSource")) row.geoSource = source;
  }
  if (fillCols.has("longitude") && rec.longitude !== undefined) row.longitude = rec.longitude;
  if (fillCols.has("asn") && rec.asn !== undefined) {
    row.asn = rec.asn;
    if (fillCols.has("asnSource")) row.asnSource = source;
  }
  if (fillCols.has("asnOrg") && rec.asnOrg) row.asnOrg = rec.asnOrg;
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
  sink?: EtlProgressSink,
  /** Which specs to fetch. Defaults to all of them; the pipeline passes
   *  only the files that are missing or corrupt, so a cached-and-valid
   *  file is never re-downloaded. */
  specs: ReadonlyArray<DownloadSpec> = DEFAULT_SPECS,
): Promise<EtlRunDownloadRow[]> {
  const t0 = Date.now();
  const { attempts } = await downloadAll(
    specs,
    rawDir,
    now,
    sink ? (bytesDone, bytesTotal) => sink.onDownload(bytesDone, bytesTotal) : undefined,
  );
  const elapsed = Date.now() - t0;
  if (sink) await sink.flush();
  console.log(`[etl] download stage: ${attempts.length} attempt(s) recorded in ${elapsed}ms`);
  const rows: EtlRunDownloadRow[] = [];
  for (const a of attempts) {
    const row: EtlRunDownloadRow = {
      runId,
      source: a.spec.kind === "city" ? "dbip-city" : a.spec.kind === "country" ? "dbip-country" : "dbip-asn",
      destName: a.destName,
      sourceUrl: a.url === "(none)" ? null : a.url,
      month: a.month,
      status: a.status === "missing" ? "missing" : a.status === "failed" ? "failed" : "success",
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
  sink?: EtlProgressSink,
): Promise<EtlRunParseRow[]> {
  const rows: EtlRunParseRow[] = [];
  for (const f of files) {
    const fullPath = path.join(rawDir, f.filename);
    // Defence in depth: the download stage already refuses to proceed
    // with a missing file, but the parse stage used to silently skip
    // anything not handed to it — which is how a run could report
    // "success" with a partial data set. Fail loudly instead.
    if (!(await fileExists(fullPath))) {
      throw new Error(`source file vanished before parsing: ${f.filename}`);
    }
    const startedAt = new Date();
    const t0 = Date.now();
    // Walk the file once to fill in skip counters. The actual insert
    // happens later in runInsertStage — the second walk is cheap
    // because the OS page cache holds the .gz content.
    const { records, stats } = f.parse(fullPath);
    for await (const _ of records) {
      void _;
    }
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
      startedAt,
      finishedAt,
      durationMs: Date.now() - t0,
    };
    await insertEtlRunParse(pool, row);
    rows.push(row);
    if (sink) sink.onParseTotal(stats.rowsEmitted);
    console.log(
      `[etl] parse ${f.etlSource}: emitted=${stats.rowsEmitted} skipped=${stats.skipped.shortLine + stats.skipped.headerRow + stats.skipped.unparseableIp + stats.skipped.missingCol + stats.skipped.nonNumericAsn + stats.skipped.other} duration=${row.durationMs}ms`,
    );
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
  sink?: EtlProgressSink,
): Promise<EtlRunInsertRow[]> {
  const rows: EtlRunInsertRow[] = [];
  // Track a running inserted count across files so the UI bar moves
  // monotonically. It must live OUTSIDE the per-file loop: resetting it
  // per file made the bar drop to 0% when moving on to dbip-country.
  let runInsertedSoFar = 0;
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
        runInsertedSoFar += c.inserted;
        if (sink) sink.onInsert(runInsertedSoFar);
        batch = [];
      }
    }
    if (batch.length > 0) {
      const c = await insertIntoNewUpsert(pool, batch, f.fillCols);
      totals.attempted += c.attempted;
      totals.inserted += c.inserted;
      totals.duplicates += c.duplicates;
      totals.batchCount += c.batchCount;
      runInsertedSoFar += c.inserted;
      if (sink) sink.onInsert(runInsertedSoFar);
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
      startedAt,
      finishedAt,
    };
    await insertEtlRunInsert(pool, row);
    rows.push(row);
    console.log(
      `[etl] insert ${f.etlSource}: attempted=${totals.attempted} inserted=${totals.inserted} dupes=${totals.duplicates} batches=${totals.batchCount} duration=${row.durationMs}ms`,
    );
  }
  return rows;
}

async function runSwapStage(pool: mysql.Pool, runId: number): Promise<EtlRunSwapRow> {
  const startedAt = new Date();

  // Hand-authored rows (the unknown-IP backfill's 'multi-provider'
  // entries) live in the live ip_ranges table. The staging table was
  // just rebuilt from the DB-IP files, which will never contain them.
  // Copy them across BEFORE the rename, or the swap deletes every one
  // of them — silently, with the run reported as a success.
  const preserved = await preserveManualRows(pool);
  if (preserved.preserved > 0 || preserved.conflicts > 0) {
    console.log(
      `[etl] preserved manual rows: ${preserved.preserved} carried over, ` +
        `${preserved.conflicts} kept the ETL's version`,
    );
  }

  const result = await atomicSwapRanges(pool);
  const finishedAt = new Date();
  const row: EtlRunSwapRow = {
    runId,
    status: result.status,
    durationMs: result.durationMs,
    errorMessage: result.errorMessage ?? null,
    startedAt,
    finishedAt,
  };
  await upsertEtlRunSwap(pool, row);
  console.log(`[etl] swap: ${result.status} duration=${result.durationMs}ms`);
  // A failed swap means the new data never went live — ip_ranges still
  // holds the previous table. That is a failed run, not a successful
  // one: reporting "success" would make lastSuccessfulEtl() treat the
  // library as fresh and show "imported N records" in the admin UI,
  // hiding the failure until someone opens the run-detail page.
  if (result.status !== "success") {
    throw new Error(`atomic swap failed: ${result.errorMessage ?? "unknown error"}`);
  }
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
  } catch (err) {
    // Best-effort cleanup of the in-progress rows. Logged rather than
    // swallowed: if this write is lost the run stays 'running' forever
    // in the admin UI, with no way to tell it apart from a live run.
    console.warn(
      `[etl] failed to mark downloads as failed for run ${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    const [res] = await pool.query<ResultSetHeader>(
      `UPDATE etl_run_swaps
          SET status = 'failed', error_message = ?,
              finished_at = COALESCE(finished_at, NOW(3))
        WHERE run_id = ? AND finished_at IS NULL`,
      [truncated, runId],
    );
    void res;
  } catch (err) {
    console.warn(
      `[etl] failed to mark swaps as failed for run ${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // Close out the per-stage rows the same way. A parse or insert row
  // left with finished_at IS NULL reads as "this stage is still running"
  // in the admin stage table, which is indistinguishable from a live
  // run — and the failed run's own error message would be nowhere near
  // it.
  await closeOpenStageRows(pool, runId, "parses");
  await closeOpenStageRows(pool, runId, "inserts");
}

/** Marks every still-open parse/insert row of a failed run as finished.
 *  `table` is one of "parses" / "inserts" — both share the
 *  (run_id, started_at, finished_at) shape. Neither has an
 *  error_message column (only etl_run_downloads and etl_run_swaps do),
 *  so the run-level error lives on etl_runs and is joined for display.
 *  The table name is a literal from the caller, never user input, so
 *  interpolating it is safe here. */
async function closeOpenStageRows(
  pool: mysql.Pool,
  runId: number,
  table: "parses" | "inserts",
): Promise<void> {
  try {
    await pool.query(
      `UPDATE etl_run_${table}
          SET finished_at = COALESCE(finished_at, NOW(3)),
              duration_ms = COALESCE(
                duration_ms,
                TIMESTAMPDIFF(MICROSECOND, started_at, NOW(3)) DIV 1000
              )
        WHERE run_id = ? AND finished_at IS NULL`,
      [runId],
    );
  } catch (err) {
    // Best-effort, like the sibling cleanups above: a lost cleanup must
    // not mask the original failure. Logged so the leftover open rows
    // are traceable.
    console.warn(
      `[etl] failed to close open ${table} rows for run ${runId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// Single top-level orchestration entry-point. Stages run sequentially
// because each depends on the previous (download → parse → insert →
// swap). Within insert, files are processed in priority order so the
// highest-priority data fills the table first and lower-priority files
// only backfill via COALESCE.
export async function runPipeline(opts: {
  cfg: AppConfig;
  runId?: number;
  /** Test seam: inject a sink so assertions can observe onInsert
   *  progress without patching the module. Defaults to a fresh sink. */
  sink?: EtlProgressSink;
  /** Test seam: replace the network download stage. The default
   *  implementation fetches the real DB-IP files; tests inject a stub
   *  so a missing/corrupt-file scenario never touches the network. */
  download?: (
    pool: mysql.Pool,
    runId: number,
    rawDir: string,
    now: Date,
    sink: EtlProgressSink | undefined,
    specs: ReadonlyArray<DownloadSpec>,
  ) => Promise<EtlRunDownloadRow[]>;
}): Promise<PipelineResult> {
  const { cfg } = opts;
  const pool = await ensurePool(cfg);
  // Cross-process exclusion. Two concurrent ETL runs would race on
  // truncateNew + atomicSwapRanges, and the surviving ip_ranges table
  // would be whichever RENAME landed last — silently half-populated.
  // The lock is held on a dedicated connection for the whole run and
  // released with it, so a crash releases it too.
  const guard = await acquireEtlRunLock(pool, { excludeRunId: opts.runId });
  if (!guard.acquired || !guard.lock) {
    await pool.end();
    throw new EtlRunLockedError(
      guard.reason ?? "an ETL run is already in progress",
    );
  }
  const releaseLock = guard.lock.release;
  try {
    return await runPipelineLocked(pool, opts);
  } finally {
    await releaseLock();
    await pool.end();
  }
}

/** The pipeline body. `runPipeline` owns the pool lifecycle and the
 *  ETL run lock; this function owns the stages. */
async function runPipelineLocked(
  pool: mysql.Pool,
  opts: {
    cfg: AppConfig;
    runId?: number;
    sink?: EtlProgressSink;
    download?: (
      pool: mysql.Pool,
      runId: number,
      rawDir: string,
      now: Date,
      sink: EtlProgressSink | undefined,
      specs: ReadonlyArray<DownloadSpec>,
    ) => Promise<EtlRunDownloadRow[]>;
  },
): Promise<PipelineResult> {
  const { cfg } = opts;
  // If the caller already created a row via recordEtlStart (e.g. the init
  // wizard needs the runId for its progress page BEFORE the pipeline spins
  // up), reuse that id instead of inserting a new one. Saves a few hundred ms
  // of waiting on the redirect→progress page round trip.
  const runId = opts.runId ?? (await recordEtlStart(pool));
  const rawDir = path.join(cfg.etl.dataDir, "raw");
  const now = new Date();
  const sink = opts.sink ?? new EtlProgressSink(pool, runId);

  try {
    // 1) Decide which files we have on disk.
    //
    //    The decision is PER FILE, not all-or-nothing. The old logic
    //    ("if no file is present, download everything") had two bugs:
    //
    //      a) A half-written .gz left behind by an interrupted run was
    //         reused as-is and blew up in the parse stage with
    //         "unexpected end of file" (Z_BUF_ERROR).
    //      b) If ANY file was present, the missing ones were never
    //         downloaded and the parse stage silently skipped them —
    //         the run then reported success with a partial data set
    //         and swapped it over the live table.
    //
    //    So: validate each cached file, delete the corrupt ones, and
    //    download exactly the files that are missing or damaged.
    const reusable: StreamFile[] = [];
    const needDownload: StreamFile[] = [];
    for (const f of DBIP_FILES) {
      const filePath = path.join(rawDir, f.filename);
      if (!(await fileExists(filePath))) {
        needDownload.push(f);
        continue;
      }
      const problem = await validateGzFile(filePath);
      if (problem) {
        console.warn(
          `[etl] cached ${f.filename} is corrupt (${problem}); deleting it and re-downloading`,
        );
        await fs.rm(filePath, { force: true });
        needDownload.push(f);
        continue;
      }
      reusable.push(f);
    }

    if (needDownload.length > 0) {
      sink.setStage("download");
      // Map the files we need onto their download specs (matched by
      // destination filename) so a cached-and-valid file is never
      // re-downloaded.
      const needNames = new Set(needDownload.map((f) => f.filename));
      const specs = DEFAULT_SPECS.filter((spec) => needNames.has(spec.destName));
      const download = opts.download ?? runDownloadStage;
      await download(pool, runId, rawDir, now, sink, specs);
    }

    // Re-check the disk: after the download stage, every file must be
    // present AND intact. A file that is still missing or corrupt at
    // this point is a hard failure — we must not proceed to parse,
    // because the parse stage would silently skip it.
    const present: StreamFile[] = [];
    const missing: string[] = [];
    for (const f of DBIP_FILES) {
      const filePath = path.join(rawDir, f.filename);
      if (!(await fileExists(filePath))) {
        missing.push(f.filename);
        continue;
      }
      const problem = await validateGzFile(filePath);
      if (problem) {
        missing.push(`${f.filename} (${problem})`);
        continue;
      }
      present.push(f);
    }
    if (missing.length > 0) {
      throw new Error(
        `source files unavailable after download: ${missing.join(", ")} — refusing to swap incomplete data over the live table`,
      );
    }

    // Record one synthetic 'skipped' row per reused file so the
    // run-detail page doesn't show an empty stage for cached inputs.
    for (const f of reusable) {
      await insertEtlRunDownload(pool, {
        runId,
        source: f.etlSource,
        destName: f.filename,
        sourceUrl: null,
        month: null,
        status: "skipped",
        bytes: null,
        durationMs: null,
        retryCount: 0,
        errorMessage: null,
        startedAt: now,
        finishedAt: now,
      });
    }

    // Synthesise the download totals so the bar reads 100% instantly
    // when re-running against cached files.
    try {
      let totalBytes = 0;
      for (const f of DBIP_FILES) {
        try {
          const stat = await fs.stat(path.join(rawDir, f.filename));
          totalBytes += stat.size;
        } catch { /* ignore */ }
      }
      sink.onDownload(totalBytes, totalBytes);
      sink.setStage("download");
      await sink.flush();
    } catch { /* ignore — sink is best-effort */ }

    // 2) Parse stage: per-file skip counters.
    sink.setStage("parse");
    await sink.flush();
    const parseRows = await runParseStage(
      pool,
      runId,
      rawDir,
      present.map((f) => ({
        source: f.source,
        etlSource: f.etlSource,
        filename: f.filename,
        parse: f.parse,
      })),
      sink,
    );
    await sink.flush();

    // A source file that parses to zero rows is as bad as a missing
    // one: it means the file is empty or shaped differently than we
    // expect, and swapping it live would drop that data source
    // entirely. DB-IP city-lite is the primary source (it carries
    // city/geo data on top of the country codes), so its absence is
    // always fatal.
    const emptySources = parseRows
      .filter((r) => r.rowsEmitted === 0)
      .map((r) => r.destName);
    if (emptySources.length > 0) {
      throw new Error(
        `source files parsed to zero rows: ${emptySources.join(", ")} — refusing to swap incomplete data over the live table`,
      );
    }

    // 3) Insert stage: truncate + per-file streamFileToDb with UpsertCount
    //    aggregation.
    //
    //    Guard: never truncate and swap an empty table.
    //
    //    Two ways a run can end up with nothing to load:
    //
    //      a) Every download failed and no file was left on disk.
    //         `present` is empty.
    //
    //      b) Every download failed but the downloader had already
    //         created the destination file (fs.createWriteStream creates
    //         the file before the first byte arrives), so the file
    //         EXISTS but is zero-length or truncated. `present` is
    //         non-empty, the parser reads no valid rows out of it, and
    //         the insert stage writes nothing.
    //
    //    In both cases the swap would replace the live ip_ranges
    //    (millions of rows) with an empty table. A failed download must
    //    leave the current data in place.
    if (present.length === 0) {
      throw new Error(
        "no source files available — every download failed; refusing to swap an empty table over the live data",
      );
    }
    sink.setStage("insert");
    await sink.flush();
    await truncateNew(pool);
    const insertRows = await runInsertStage(
      pool,
      runId,
      rawDir,
      present.map((f) => ({
        source: f.source,
        etlSource: f.etlSource,
        filename: f.filename,
        parse: f.parse,
        fillCols: f.fillCols,
      })),
      sink,
    );
    await sink.flush();

    // Second half of the guard: the files existed, but did they carry
    // any usable rows? A truncated or empty download parses to zero
    // rows, which would still swap an empty table live.
    const insertedRows = insertRows.reduce((sum, r) => sum + r.rowsInserted, 0);
    if (insertedRows === 0) {
      throw new Error(
        "the source files contained no usable records — refusing to swap an empty table over the live data",
      );
    }

    // 4) Swap stage: atomic RENAME, persisted to etl_run_swaps.
    sink.setStage("swap");
    await sink.flush();
    await runSwapStage(pool, runId);
    sink.setStage("done");
    await sink.flush();

    // Aggregate row counts for the legacy etl_runs summary columns from
    // the insert-stage tallies instead of re-parsing every file. The swap
    // already went live at this point, so re-walking all three CSVs here
    // bought nothing but a third full gunzip pass — and any transient IO
    // error in that walk would mark an already-swapped-in run "failed".
    // rowsAttempted is the emitted-record count per file (every parsed
    // row reaches the batch buffer), so summing it is equivalent to the
    // old post-swap counts walk.
    const countFor = (etlSource: EtlRunDownloadSource): number =>
      insertRows.filter((r) => r.source === etlSource).reduce((sum, r) => sum + r.rowsAttempted, 0);
    const dbipRecords = countFor("dbip-city");
    const dbipCountryRecords = countFor("dbip-country");
    const dbipAsnRecords = countFor("dbip-asn");
    const total = dbipRecords + dbipCountryRecords + dbipAsnRecords;
    await recordEtlFinish(pool, runId, "success", {
      dbipRecords: total,
      mergedRecords: total,
    });
    console.log(
      `[etl] success run=${runId} merged=${total} (dbip=${dbipRecords}, dbip-country=${dbipCountryRecords}, dbip-asn=${dbipAsnRecords})`,
    );
    return { runId, merged: total };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markStageFailed(pool, runId, msg);
    try {
      await sink.flush();
    } catch (flushErr) {
      // The run failure itself is already reported below; this only
      // means the last progress-bar update didn't land.
      console.warn(
        `[etl] final progress flush failed for run ${runId}: ${
          flushErr instanceof Error ? flushErr.message : String(flushErr)
        }`,
      );
    }
    await recordEtlFinish(pool, runId, "failed", { errorMessage: msg });
    console.error(`[etl] failed run=${runId}:`, msg);
    throw err;
  }
}
