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
exports.EtlProgressSink = void 0;
exports.runPipeline = runPipeline;
// SPDX-License-Identifier: MIT
const fs = __importStar(require("node:fs/promises"));
const path = __importStar(require("node:path"));
const mysql_1 = require("../storage/mysql");
const dbip_1 = require("./sources/dbip");
const download_1 = require("./download");
const cidr_1 = require("./sources/cidr");
const cidr_2 = require("./sources/cidr");
const sapicsCountry_1 = require("./sources/sapicsCountry");
const githubTypes_1 = require("./sources/githubTypes");
const prepare_1 = require("./sources/prepare");
const runGuard_1 = require("./runGuard");
const progressReporter_1 = require("./progressReporter");
// A streaming ingest target: one physical file from one logical source.
// `fillCols` says which columns this file contributes; the upsert path in
// storage/mysql.ts uses that to gate INSERT ... ON DUPLICATE KEY UPDATE so
// a later, lower-priority file (inserted later) doesn't clobber a value
// already filled by an earlier, higher-priority one. Higher priority wins
// because COALESCE(existing, new) keeps the already-present value.
const SOURCE_FILES = [
    {
        source: "dbip",
        etlSource: "dbip-city",
        filename: "dbip.csv.gz",
        validate: "gzip",
        parse: dbip_1.parseDbipCityCsvStreamWithStats,
        fillCols: new Set([
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
        validate: "gzip",
        parse: dbip_1.parseDbipCountryCsvStreamWithStats,
        fillCols: new Set(["countryCode", "countrySource"]),
    },
    {
        source: "dbip-asn",
        etlSource: "dbip-asn",
        filename: "dbip-asn.csv.gz",
        validate: "gzip",
        parse: dbip_1.parseDbipAsnCsvStreamWithStats,
        fillCols: new Set(["asn", "asnOrg", "asnSource"]),
    },
    {
        source: "metowolf-cn",
        etlSource: "metowolf-cn",
        filename: "china-ipv4.txt",
        validate: "text",
        textFormat: "cidr",
        parse: cidr_1.parseMetowolfCidrStreamWithStats,
        fillCols: new Set(["countryCode", "countrySource"]),
        dedupeGroup: "github-list",
    },
    {
        source: "runishiwo-cn",
        etlSource: "runishiwo-cn",
        filename: "china-v4.txt",
        validate: "text",
        textFormat: "cidr",
        parse: cidr_2.parseRunishiwoV4CidrStreamWithStats,
        fillCols: new Set(["countryCode", "countrySource"]),
        dedupeGroup: "github-list",
    },
    {
        source: "runishiwo-cn",
        etlSource: "runishiwo-v6",
        filename: "china-v6.txt",
        validate: "text",
        textFormat: "cidr",
        parse: cidr_2.parseRunishiwoV6CidrStreamWithStats,
        fillCols: new Set(["countryCode", "countrySource"]),
        dedupeGroup: "github-list",
    },
    {
        source: "sapics-user",
        etlSource: "sapics-user",
        filename: "sapics-user-country.csv",
        validate: "text",
        textFormat: "country-csv",
        parse: sapicsCountry_1.parseSapicsCountryStreamWithStats,
        fillCols: new Set(["countryCode", "countrySource"]),
        dedupeGroup: "github-list",
    },
];
/** Throttled writer for the etl_runs progress columns. The download
 *  callback fires every 64 KB (~1500 events over a 100 MB file) and
 *  the insert callback fires every 1000 rows — far more often than
 *  the admin UI polls. We coalesce state in memory and flush at most
 *  once per second so MySQL isn't hammered. `await sink.flush()` at
 *  the end of each stage guarantees a final write before recordEtlFinish. */
class EtlProgressSink {
    pool;
    runId;
    state = {
        downloadBytesDone: 0,
        downloadBytesTotal: null,
        insertRowsDone: 0,
        insertRowsTotal: null,
        currentStage: "download",
    };
    lastWriteAt = 0;
    intervalMs;
    pendingFlush = null;
    constructor(pool, runId, opts) {
        this.pool = pool;
        this.runId = runId;
        this.intervalMs = opts?.intervalMs ?? 1000;
    }
    /** Called once per download chunk. Aggregates into state; flushes
     *  on the throttle interval. */
    onDownload(bytesDone, bytesTotal) {
        this.state.downloadBytesDone = bytesDone;
        if (bytesTotal !== null)
            this.state.downloadBytesTotal = bytesTotal;
        this.maybeScheduleFlush();
    }
    /** Called after parse completes for a file. Sets the per-run row
     *  total so the insert bar starts from 0% instead of indeterminate.
     *  `parsedRows` is a count of rows that will reach insert (skip
     *  counters already excluded by the parser). */
    onParseTotal(parsedRows) {
        // Sum across files so the bar tracks the full pipeline, not the
        // current file. insertRowsDone is monotonic so summing here is safe.
        this.state.insertRowsTotal = (this.state.insertRowsTotal ?? 0) + parsedRows;
        this.maybeScheduleFlush();
    }
    /** A read-only view of the counters, for tests and for callers that
     *  need the current numbers without parsing the flush. */
    getState() {
        return { ...this.state };
    }
    /**
     * Called every 1000 rows during insert.
     *
     * `rowsDone` is the count of rows ATTEMPTED, not rows inserted. The
     * denominator (`onParseTotal`) is the count of rows the files will
     * yield, so the two have to be measured the same way — an inserted-only
     * numerator stops around 97% whenever the sources overlap on
     * (start_ip, end_ip) and the upsert merges them.
     */
    onInsert(rowsDone) {
        this.state.insertRowsDone = rowsDone;
        this.maybeScheduleFlush();
    }
    setStage(stage) {
        if (this.state.currentStage === stage)
            return;
        // The insert stage is over: whatever the merge arithmetic left over is
        // not pending work. Without this the bar sits at its last insert
        // percentage through the swap and into the finished run.
        if (stage === "swap" || stage === "done") {
            if (this.state.insertRowsTotal !== null) {
                this.state.insertRowsDone = this.state.insertRowsTotal;
            }
        }
        this.state.currentStage = stage;
        // Stage transitions should land on disk immediately so the UI can
        // hide the previous bar — bypass the throttle.
        this.flush().catch(() => undefined);
    }
    /** Force a final write. Used at the end of each pipeline stage. */
    async flush() {
        if (this.pendingFlush) {
            // Wait for the in-flight flush, then issue our own with current state.
            try {
                await this.pendingFlush;
            }
            catch (err) {
                // The in-flight write failed but the flush below re-writes the
                // current state, so the run continues. Logged so a repeatedly
                // failing progress write is visible.
                console.warn(`[etl] pending progress flush failed for run ${this.runId}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
        const write = (0, mysql_1.updateEtlRunProgress)(this.pool, this.runId, {
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
    maybeScheduleFlush() {
        const now = Date.now();
        const since = now - this.lastWriteAt;
        if (since >= this.intervalMs) {
            // Fire-and-forget; .flush() is awaited at stage boundaries.
            this.flush().catch(() => undefined);
        }
    }
}
exports.EtlProgressSink = EtlProgressSink;
async function ensurePool(cfg) {
    const pool = (0, mysql_1.createPool)(cfg);
    await (0, mysql_1.runMigrations)(pool);
    return pool;
}
async function fileExists(p) {
    try {
        await fs.access(p);
        return true;
    }
    catch {
        return false;
    }
}
function toIpRangeRow(rec, source, fillCols) {
    const row = { startIp: rec.startIp, endIp: rec.endIp };
    if (fillCols.has("countryCode") && rec.countryCode) {
        row.countryCode = rec.countryCode;
        if (fillCols.has("countrySource"))
            row.countrySource = source;
    }
    if (fillCols.has("region") && rec.region)
        row.region = rec.region;
    if (fillCols.has("city") && rec.city) {
        row.city = rec.city;
        if (fillCols.has("citySource"))
            row.citySource = source;
    }
    if (fillCols.has("latitude") && rec.latitude !== undefined) {
        row.latitude = rec.latitude;
        if (fillCols.has("geoSource"))
            row.geoSource = source;
    }
    if (fillCols.has("longitude") && rec.longitude !== undefined)
        row.longitude = rec.longitude;
    if (fillCols.has("asn") && rec.asn !== undefined) {
        row.asn = rec.asn;
        if (fillCols.has("asnSource"))
            row.asnSource = source;
    }
    if (fillCols.has("asnOrg") && rec.asnOrg)
        row.asnOrg = rec.asnOrg;
    return row;
}
// ─── Stage helpers ─────────────────────────────────────────────────────
// Each stage owns one slice of the etl_run_* side tables. We do NOT
// INSERT a 'pending' row first then UPDATE — the schemas don't have a
// 'pending' enum value and the extra round-trip isn't worth it. Instead
// each stage does ONE insert per file once the work is done, with
// started_at + finished_at + duration_ms all populated atomically.
// Swap uses upsertEtlRunSwap so re-runs overwrite.
async function runDownloadStage(pool, runId, rawDir, now, sink, 
/** Which specs to fetch. Defaults to all of them; the pipeline passes
 *  only the files that are missing or corrupt, so a cached-and-valid
 *  file is never re-downloaded. */
specs = download_1.ALL_SPECS, 
/** Seam for the fixed-file refresh layer — see `runPipeline`'s
 *  `downloadFixed`. Defaults to the real mirror-walking fetcher. */
fixedImpl = download_1.fetchFixedOneWithAttempts) {
    const t0 = Date.now();
    const { attempts, failures } = await (0, download_1.downloadAll)(specs, rawDir, now, sink ? (bytesDone, bytesTotal) => sink.onDownload(bytesDone, bytesTotal) : undefined, undefined, fixedImpl);
    const elapsed = Date.now() - t0;
    if (sink)
        await sink.flush();
    console.log(`[etl] download stage: ${attempts.length} attempt(s) recorded in ${elapsed}ms`);
    const rows = [];
    const monthlyAttempts = attempts.filter((attempt) => attempt.spec.mode === "monthly");
    for (const a of monthlyAttempts) {
        const row = {
            runId,
            source: a.spec.etlSource,
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
        await (0, mysql_1.insertEtlRunDownload)(pool, row);
        rows.push(row);
    }
    for (const spec of specs.filter((entry) => entry.mode === "fixed")) {
        const specAttempts = attempts.filter((attempt) => attempt.spec.destName === spec.destName);
        const success = specAttempts.find((attempt) => attempt.status === "success");
        const failure = failures.find((entry) => entry.destName === spec.destName);
        const row = success
            ? {
                runId,
                source: spec.etlSource,
                destName: spec.destName,
                sourceUrl: success.url,
                month: null,
                status: "success",
                bytes: success.bytes,
                durationMs: success.durationMs,
                retryCount: success.retryCount,
                errorMessage: success.errorMessage,
                startedAt: success.startedAt,
                finishedAt: success.finishedAt,
            }
            : {
                runId,
                source: spec.etlSource,
                destName: spec.destName,
                sourceUrl: failure?.url ?? null,
                month: null,
                status: "failed",
                bytes: null,
                durationMs: specAttempts.reduce((sum, attempt) => sum + (attempt.durationMs ?? 0), 0),
                retryCount: specAttempts.length,
                errorMessage: failure?.message ?? "刷新失败、复用旧缓存",
                startedAt: specAttempts[0]?.startedAt ?? now,
                finishedAt: specAttempts[specAttempts.length - 1]?.finishedAt ?? now,
            };
        await (0, mysql_1.insertEtlRunDownload)(pool, row);
        rows.push(row);
    }
    return rows;
}
async function runParseStage(pool, runId, rawDir, files, sink, github) {
    const rows = [];
    const githubFiles = files.filter(githubTypes_1.isGithubStreamFile);
    const dbipFiles = files.filter((file) => !(0, githubTypes_1.isGithubStreamFile)(file));
    for (const f of dbipFiles) {
        const fullPath = path.join(rawDir, f.filename);
        if (!(await fileExists(fullPath))) {
            throw new Error(`source file vanished before parsing: ${f.filename}`);
        }
        const startedAt = new Date();
        const t0 = Date.now();
        const sizeMb = await fileSizeMb(fullPath);
        console.log(`[etl] parse: ${f.filename} (${sizeMb}) — counting rows`);
        const reporter = (0, progressReporter_1.createProgressReporter)({
            label: `parse ${f.filename}`,
            unit: "rows",
        });
        const { records, stats } = f.parse(fullPath);
        for await (const _ of records) {
            void _;
            reporter.tick(1);
        }
        reporter.finish();
        rows.push(await persistParseRow(pool, runId, f, stats, startedAt, Date.now() - t0));
        if (sink)
            sink.onParseTotal(stats.rowsEmitted);
    }
    if (githubFiles.length > 0) {
        if (!github)
            throw new Error("prepared GitHub source records are missing before parse");
        for (const f of githubFiles) {
            const stats = github.byFile.get(f.etlSource);
            if (!stats)
                throw new Error(`prepared stats missing for ${f.etlSource}`);
            rows.push(await persistParseRow(pool, runId, f, stats, new Date(), 0));
            if (sink)
                sink.onParseTotal(stats.rowsEmitted);
        }
    }
    return rows;
}
async function persistParseRow(pool, runId, file, stats, startedAt, durationMs) {
    const row = {
        runId,
        source: file.etlSource,
        destName: file.filename,
        rowsEmitted: stats.rowsEmitted,
        rowsSkippedShort: stats.skipped.shortLine,
        rowsSkippedHeader: stats.skipped.headerRow,
        rowsSkippedUnparseableIp: stats.skipped.unparseableIp,
        rowsSkippedMissingCol: stats.skipped.missingCol,
        rowsSkippedNanAsn: stats.skipped.nonNumericAsn,
        rowsSkippedOther: stats.skipped.other,
        gunzipErrors: stats.gunzipErrors,
        startedAt,
        finishedAt: new Date(),
        durationMs,
    };
    await (0, mysql_1.insertEtlRunParse)(pool, row);
    return row;
}
/** "12.3 MB" for a log line; "unknown" when the stat fails. */
async function fileSizeMb(filePath) {
    try {
        const stat = await fs.stat(filePath);
        return `${(stat.size / 1024 / 1024).toFixed(1)} MB`;
    }
    catch {
        return "unknown size";
    }
}
function emptyTotals() {
    return { attempted: 0, inserted: 0, duplicates: 0, batchCount: 0 };
}
function addTotals(target, added) {
    target.attempted += added.attempted;
    target.inserted += added.inserted;
    target.duplicates += added.duplicates;
    target.batchCount += added.batchCount;
}
async function flushBatch(pool, batch, fillCols, totals) {
    const result = await (0, mysql_1.insertIntoNewUpsert)(pool, batch, fillCols);
    addTotals(totals, result);
    return result;
}
async function runInsertStage(pool, runId, rawDir, files, sink, github, 
/** The parse stage's per-file rows. Their `rowsEmitted` is the expected
 *  row count for the insert of the same file, which is what lets the
 *  progress line show a percentage and an ETA. */
parseRows = []) {
    const rows = [];
    // Rows ATTEMPTED across every file so far. This is what the progress
    // bar's denominator measures, so the two must agree — counting inserts
    // here made the bar stop around 97% wherever the sources overlap.
    let runAttemptedSoFar = 0;
    const dbipFiles = files.filter((file) => !(0, githubTypes_1.isGithubStreamFile)(file));
    if (dbipFiles.length > 0) {
        console.log(`[etl] insert: ${dbipFiles.length} DB-IP source file(s) — this is the long stage`);
    }
    for (const f of dbipFiles) {
        const startedAt = new Date();
        const t0 = Date.now();
        const totals = emptyTotals();
        // The rows this file contributes were counted during parse; reuse that
        // number so the progress line can show a percentage and an ETA instead
        // of a bare running total.
        const expected = parseRows.find((row) => row.source === f.etlSource)?.rowsEmitted;
        const reporter = (0, progressReporter_1.createProgressReporter)({
            label: `insert ${f.filename}`,
            unit: "rows",
            total: expected && expected > 0 ? expected : undefined,
        });
        console.log(`[etl] insert: ${f.filename}${expected ? ` (~${expected.toLocaleString()} rows expected)` : ""}`);
        let batch = [];
        for await (const rec of f.parse(path.join(rawDir, f.filename)).records) {
            batch.push(toIpRangeRow(rec, f.source, f.fillCols));
            if (batch.length >= 1000) {
                const result = await flushBatch(pool, batch, f.fillCols, totals);
                runAttemptedSoFar += result.attempted;
                reporter.tick(batch.length);
                if (sink)
                    sink.onInsert(runAttemptedSoFar);
                batch = [];
            }
        }
        if (batch.length > 0) {
            const result = await flushBatch(pool, batch, f.fillCols, totals);
            runAttemptedSoFar += result.attempted;
            reporter.tick(batch.length);
            if (sink)
                sink.onInsert(runAttemptedSoFar);
        }
        reporter.finish();
        console.log(`[etl] insert: ${f.filename} — ${totals.inserted.toLocaleString()} new, ` +
            `${totals.duplicates.toLocaleString()} merged into existing ranges`);
        rows.push(await persistInsertRow(pool, runId, f, totals, startedAt, Date.now() - t0));
    }
    const githubFiles = files.filter(githubTypes_1.isGithubStreamFile);
    if (githubFiles.length > 0) {
        if (!github)
            throw new Error("prepared GitHub source records are missing before insert");
        const bySource = new Map();
        for (const f of githubFiles)
            bySource.set(f.etlSource, emptyTotals());
        const fillCols = githubFiles[0].fillCols;
        let batch = [];
        const flushGithubBatch = async () => {
            const rowBatch = batch.map((rec) => toIpRangeRow(rec, rec.source, fillCols));
            const result = await (0, mysql_1.insertIntoNewUpsert)(pool, rowBatch, fillCols);
            let remainingInserted = result.inserted;
            let remainingDuplicates = result.duplicates;
            for (const rec of batch) {
                const totals = bySource.get(rec.etlSource) ?? emptyTotals();
                totals.attempted += 1;
                totals.batchCount += 1;
                if (remainingInserted > 0) {
                    totals.inserted += 1;
                    remainingInserted -= 1;
                }
                else if (remainingDuplicates > 0) {
                    totals.duplicates += 1;
                    remainingDuplicates -= 1;
                }
                bySource.set(rec.etlSource, totals);
            }
            runAttemptedSoFar += result.attempted;
            if (sink)
                sink.onInsert(runAttemptedSoFar);
            batch = [];
        };
        for (const rec of github.dedupe.records) {
            batch.push(rec);
            if (batch.length >= 1000)
                await flushGithubBatch();
        }
        if (batch.length > 0)
            await flushGithubBatch();
        for (const f of githubFiles) {
            rows.push(await persistInsertRow(pool, runId, f, bySource.get(f.etlSource) ?? emptyTotals(), new Date(), 0));
        }
    }
    return rows;
}
async function persistInsertRow(pool, runId, file, totals, startedAt, durationMs) {
    const row = {
        runId,
        source: file.etlSource,
        destName: file.filename,
        rowsAttempted: totals.attempted,
        rowsInserted: totals.inserted,
        rowsDuplicates: totals.duplicates,
        batchCount: totals.batchCount,
        durationMs,
        startedAt,
        finishedAt: new Date(),
    };
    await (0, mysql_1.insertEtlRunInsert)(pool, row);
    return row;
}
async function runSwapStage(pool, runId) {
    const startedAt = new Date();
    // Hand-authored rows (the unknown-IP backfill's 'multi-provider'
    // entries) live in the live ip_ranges table. The staging table was
    // just rebuilt from the DB-IP files, which will never contain them.
    // Copy them across BEFORE the rename, or the swap deletes every one
    // of them — silently, with the run reported as a success.
    const preserved = await (0, mysql_1.preserveManualRows)(pool);
    if (preserved.preserved > 0 || preserved.conflicts > 0) {
        console.log(`[etl] preserved manual rows: ${preserved.preserved} carried over, ` +
            `${preserved.conflicts} kept the ETL's version`);
    }
    const result = await (0, mysql_1.atomicSwapRanges)(pool);
    const finishedAt = new Date();
    const row = {
        runId,
        status: result.status,
        durationMs: result.durationMs,
        errorMessage: result.errorMessage ?? null,
        startedAt,
        finishedAt,
    };
    await (0, mysql_1.upsertEtlRunSwap)(pool, row);
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
async function markStageFailed(pool, runId, errorMsg) {
    const truncated = errorMsg.slice(0, 512);
    try {
        const [res] = await pool.query(`UPDATE etl_run_downloads
          SET status = 'failed', error_message = ?,
              finished_at = COALESCE(finished_at, NOW(3))
        WHERE run_id = ? AND finished_at IS NULL`, [truncated, runId]);
        void res;
    }
    catch (err) {
        // Best-effort cleanup of the in-progress rows. Logged rather than
        // swallowed: if this write is lost the run stays 'running' forever
        // in the admin UI, with no way to tell it apart from a live run.
        console.warn(`[etl] failed to mark downloads as failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        const [res] = await pool.query(`UPDATE etl_run_swaps
          SET status = 'failed', error_message = ?,
              finished_at = COALESCE(finished_at, NOW(3))
        WHERE run_id = ? AND finished_at IS NULL`, [truncated, runId]);
        void res;
    }
    catch (err) {
        console.warn(`[etl] failed to mark swaps as failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
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
async function closeOpenStageRows(pool, runId, table) {
    try {
        await pool.query(`UPDATE etl_run_${table}
          SET finished_at = COALESCE(finished_at, NOW(3)),
              duration_ms = COALESCE(
                duration_ms,
                TIMESTAMPDIFF(MICROSECOND, started_at, NOW(3)) DIV 1000
              )
        WHERE run_id = ? AND finished_at IS NULL`, [runId]);
    }
    catch (err) {
        // Best-effort, like the sibling cleanups above: a lost cleanup must
        // not mask the original failure. Logged so the leftover open rows
        // are traceable.
        console.warn(`[etl] failed to close open ${table} rows for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
// Single top-level orchestration entry-point. Stages run sequentially
// because each depends on the previous (download → parse → insert →
// swap). Within insert, files are processed in priority order so the
// highest-priority data fills the table first and lower-priority files
// only backfill via COALESCE.
async function runPipeline(opts) {
    const { cfg } = opts;
    const pool = await ensurePool(cfg);
    // Cross-process exclusion. Two concurrent ETL runs would race on
    // truncateNew + atomicSwapRanges, and the surviving ip_ranges table
    // would be whichever RENAME landed last — silently half-populated.
    // The lock is held on a dedicated connection for the whole run and
    // released with it, so a crash releases it too.
    const guard = await (0, runGuard_1.acquireEtlRunLock)(pool, { excludeRunId: opts.runId });
    if (!guard.acquired || !guard.lock) {
        await pool.end();
        throw new runGuard_1.EtlRunLockedError(guard.reason ?? "an ETL run is already in progress");
    }
    const releaseLock = guard.lock.release;
    try {
        return await runPipelineLocked(pool, opts);
    }
    finally {
        await releaseLock();
        await pool.end();
    }
}
/** The pipeline body. `runPipeline` owns the pool lifecycle and the
 *  ETL run lock; this function owns the stages. */
async function runPipelineLocked(pool, opts) {
    const { cfg } = opts;
    // If the caller already created a row via recordEtlStart (e.g. the init
    // wizard needs the runId for its progress page BEFORE the pipeline spins
    // up), reuse that id instead of inserting a new one. Saves a few hundred ms
    // of waiting on the redirect→progress page round trip.
    const runId = opts.runId ?? (await (0, mysql_1.recordEtlStart)(pool));
    const rawDir = path.join(cfg.etl.dataDir, "raw");
    const now = new Date();
    const runStartedAt = Date.now();
    console.log(`[etl] run ${runId} starting — data dir ${rawDir}`);
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
        const reusable = [];
        const needDownload = [];
        for (const f of SOURCE_FILES.filter((file) => file.validate === "gzip")) {
            const filePath = path.join(rawDir, f.filename);
            if (!(await fileExists(filePath))) {
                needDownload.push(f);
                continue;
            }
            const problem = await (0, download_1.validateGzFile)(filePath);
            if (problem) {
                console.warn(`[etl] cached ${f.filename} is corrupt (${problem}); deleting it and re-downloading`);
                await fs.rm(filePath, { force: true });
                needDownload.push(f);
                continue;
            }
            reusable.push(f);
        }
        // The four GitHub fixed files refresh every run. A failure preserves
        // the previous validated cache and is recorded as 'failed', never
        // 'skipped'. The injected test download seam receives all specs so
        // integration tests can short-circuit without network access.
        const needNames = new Set(needDownload.map((f) => f.filename));
        const monthlySpecs = download_1.ALL_SPECS.filter((spec) => spec.mode === "monthly" && needNames.has(spec.destName));
        const specs = [...monthlySpecs, ...download_1.EXTRA_SPECS];
        const monthlyCount = monthlySpecs.length;
        console.log(`[etl] download: ${monthlyCount} DB-IP file(s) to fetch, ` +
            `${reusable.length} reused from cache, ${download_1.EXTRA_SPECS.length} GitHub file(s) refreshed`);
        sink.setStage("download");
        const fixedImpl = opts.downloadFixed ?? download_1.fetchFixedOneWithAttempts;
        const download = opts.download ?? runDownloadStage;
        await download(pool, runId, rawDir, now, sink, specs, fixedImpl);
        // Re-check the disk: after the download stage, every file must be
        // present AND intact. A file that is still missing or corrupt at
        // this point is a hard failure — we must not proceed to parse,
        // because the parse stage would silently skip it.
        const present = [];
        const missing = [];
        for (const f of SOURCE_FILES) {
            const filePath = path.join(rawDir, f.filename);
            if (!(await fileExists(filePath))) {
                missing.push(f.filename);
                continue;
            }
            const problem = f.validate === "gzip" ? await (0, download_1.validateGzFile)(filePath) : null;
            if (problem) {
                missing.push(`${f.filename} (${problem})`);
                continue;
            }
            present.push(f);
        }
        if (missing.length > 0) {
            throw new Error(`source files unavailable after download: ${missing.join(", ")} — refusing to swap incomplete data over the live table`);
        }
        // Record one synthetic 'skipped' row per reused file so the
        // run-detail page doesn't show an empty stage for cached inputs.
        for (const f of reusable) {
            await (0, mysql_1.insertEtlRunDownload)(pool, {
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
            for (const f of SOURCE_FILES) {
                try {
                    const stat = await fs.stat(path.join(rawDir, f.filename));
                    totalBytes += stat.size;
                }
                catch { /* ignore */ }
            }
            sink.onDownload(totalBytes, totalBytes);
            sink.setStage("download");
            await sink.flush();
        }
        catch { /* ignore — sink is best-effort */ }
        // 2) Parse stage: per-file skip counters. The four GitHub sources
        // are parsed and deduped once; parse and insert reuse that snapshot.
        sink.setStage("parse");
        await sink.flush();
        console.log(`[etl] parse: ${present.length} source file(s)`);
        const githubStartedAt = new Date();
        const github = await (0, prepare_1.prepareGithubSources)(present.filter(githubTypes_1.isGithubStreamFile), rawDir);
        await (0, mysql_1.insertEtlRunDedupe)(pool, {
            runId,
            inputRows: github.dedupe.stats.input,
            contained: github.dedupe.stats.contained,
            exactDuplicates: github.dedupe.stats.exactDuplicates,
            partialOverlaps: github.dedupe.stats.partialOverlaps,
            emitted: github.dedupe.stats.emitted,
            durationMs: Date.now() - githubStartedAt.getTime(),
            startedAt: githubStartedAt,
            finishedAt: new Date(),
        });
        const parseRows = await runParseStage(pool, runId, rawDir, present, sink, github);
        await sink.flush();
        // A source file that parses to zero rows is as bad as a missing
        // one: it means the file is empty or shaped differently than we
        // expect, and swapping it live would drop that data source
        // entirely. DB-IP city-lite is the primary source (it carries
        // city/geo data on top of the country codes), so its absence is
        // always fatal.
        const emptyDbipSources = parseRows
            .filter((row) => row.rowsEmitted === 0 &&
            present.some((file) => file.filename === row.destName && file.dedupeGroup !== "github-list"))
            .map((row) => row.destName);
        if (emptyDbipSources.length > 0) {
            throw new Error(`source files parsed to zero rows: ${emptyDbipSources.join(", ")} — refusing to swap incomplete data over the live table`);
        }
        const emptyGithubSources = parseRows.filter((row) => row.rowsEmitted === 0 &&
            present.some((file) => file.filename === row.destName && file.dedupeGroup === "github-list"));
        for (const row of emptyGithubSources) {
            console.warn(`[etl] github source ${row.destName} emitted zero rows after dedupe`);
        }
        if (github.dedupe.stats.emitted === 0) {
            throw new Error("deduped GitHub sources emitted zero rows — refusing to swap incomplete data over the live table");
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
            throw new Error("no source files available — every download failed; refusing to swap an empty table over the live data");
        }
        sink.setStage("insert");
        await sink.flush();
        await (0, mysql_1.truncateNew)(pool);
        const insertRows = await runInsertStage(pool, runId, rawDir, present, sink, github, parseRows);
        await sink.flush();
        // Second half of the guard: the files existed, but did they carry
        // any usable rows? A truncated or empty download parses to zero
        // rows, which would still swap an empty table live.
        const insertedRows = insertRows.reduce((sum, r) => sum + r.rowsInserted, 0);
        if (insertedRows === 0) {
            throw new Error("the source files contained no usable records — refusing to swap an empty table over the live data");
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
        const countFor = (etlSource) => insertRows.filter((r) => r.source === etlSource).reduce((sum, r) => sum + r.rowsAttempted, 0);
        const dbipCityRecords = countFor("dbip-city");
        const dbipCountryRecords = countFor("dbip-country");
        const dbipAsnRecords = countFor("dbip-asn");
        const dbipTotal = dbipCityRecords + dbipCountryRecords + dbipAsnRecords;
        const mergedTotal = insertRows.reduce((sum, row) => sum + row.rowsAttempted, 0);
        await (0, mysql_1.recordEtlFinish)(pool, runId, "success", {
            dbipRecords: dbipTotal,
            mergedRecords: mergedTotal,
        });
        const totalSec = Math.round((Date.now() - runStartedAt) / 1000);
        const totalMin = Math.floor(totalSec / 60);
        const totalLabel = totalMin > 0 ? `${totalMin}m${String(totalSec % 60).padStart(2, "0")}s` : `${totalSec}s`;
        console.log(`[etl] success run=${runId} merged=${mergedTotal} in ${totalLabel} ` +
            `(dbip=${dbipCityRecords}, dbip-country=${dbipCountryRecords}, dbip-asn=${dbipAsnRecords})`);
        return { runId, merged: mergedTotal };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await markStageFailed(pool, runId, msg);
        try {
            await sink.flush();
        }
        catch (flushErr) {
            // The run failure itself is already reported below; this only
            // means the last progress-bar update didn't land.
            console.warn(`[etl] final progress flush failed for run ${runId}: ${flushErr instanceof Error ? flushErr.message : String(flushErr)}`);
        }
        await (0, mysql_1.recordEtlFinish)(pool, runId, "failed", { errorMessage: msg });
        console.error(`[etl] failed run=${runId}:`, msg);
        throw err;
    }
}
//# sourceMappingURL=pipeline.js.map