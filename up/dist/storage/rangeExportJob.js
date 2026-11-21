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
exports.isRangeExportRunning = isRangeExportRunning;
exports.startRangeExport = startRangeExport;
exports.writeRangeExport = writeRangeExport;
exports.readRangeExport = readRangeExport;
exports.listRangeExports = listRangeExports;
const path = __importStar(require("node:path"));
const rangeExport_1 = require("./rangeExport");
const runner_1 = require("./migrations/runner");
/** The columns every read of a job uses. */
const JOB_COLUMNS = "id, filename, country_code, status, rows, bytes, error_message, started_at, finished_at";
/**
 * The exports this process is running.
 *
 * Two exports at once would write two files and race on the same table —
 * not corrupting anything, but doubling the load on a database that is
 * already reading nine million rows. One at a time is the rule the import
 * follows too.
 */
const running = new Map();
/** Is an export running right now? */
function isRangeExportRunning() {
    return running.size > 0;
}
/**
 * Start an export in the background and answer the caller immediately.
 *
 * The job record is written BEFORE the work starts, so the page has
 * something to show the moment the request redirects — and so a job that
 * dies in the first millisecond still leaves a row that says it died.
 */
async function startRangeExport(pool, log, job) {
    await writeRangeExport(pool, {
        id: job.id,
        filename: path.basename(job.filepath),
        countryCode: job.countryCode,
        status: "running",
        rows: 0,
        bytes: 0,
        errorMessage: null,
    });
    running.set(job.id, { ...job });
    // The detached call. Everything it can throw is caught here: this
    // promise is not awaited by anyone, so an unhandled rejection would take
    // the process down in Node 15 and later.
    void runExport(pool, log, { ...job }).catch((err) => {
        // `runExport` handles its own failures; this is the belt to its
        // braces, for a failure in the failure handling itself.
        log.error({ err, exportId: job.id }, "the range export failed in a way the job could not record");
    });
    return job.id;
}
/** Do the work. Never throws — every outcome lands in the job record. */
async function runExport(pool, log, job) {
    try {
        const result = await (0, rangeExport_1.exportRangesToFile)(pool, job.filepath, job.countryCode ? { countryCode: job.countryCode } : {});
        await writeRangeExport(pool, {
            id: job.id,
            filename: path.basename(job.filepath),
            countryCode: job.countryCode,
            status: "success",
            rows: result.rows,
            bytes: result.bytes,
            errorMessage: null,
        });
        log.info({ exportId: job.id, rows: result.rows, bytes: result.bytes }, "the range export finished");
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, exportId: job.id }, "the range export failed");
        // The job record is the operator's only way of finding out. A job
        // that stays `running` reads as "still going" for the rest of the
        // install's life, so the failure is written down.
        await writeRangeExport(pool, {
            id: job.id,
            filename: path.basename(job.filepath),
            countryCode: job.countryCode,
            status: "failed",
            rows: 0,
            bytes: 0,
            errorMessage: message,
        }).catch((writeErr) => {
            log.error({ err: writeErr, exportId: job.id }, "could not record the export failure");
        });
    }
    finally {
        running.delete(job.id);
    }
}
/**
 * Write or update the job record.
 *
 * The row is written twice for one export: once when the job starts (so
 * the page can show it) and once when it ends. The second write is a
 * plain UPDATE, not an upsert, because the id was already taken.
 */
async function writeRangeExport(pool, fields) {
    await (0, runner_1.runMigrations)(pool);
    await pool.query(`INSERT INTO range_exports (id, filename, country_code, status, rows, bytes, error_message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3), ?)
     ON DUPLICATE KEY UPDATE
       filename = VALUES(filename),
       country_code = VALUES(country_code),
       status = VALUES(status),
       rows = VALUES(rows),
       bytes = VALUES(bytes),
       error_message = VALUES(error_message),
       finished_at = VALUES(finished_at)`, [
        fields.id,
        fields.filename,
        fields.countryCode,
        fields.status,
        fields.rows,
        fields.bytes,
        fields.errorMessage,
        // A running job has not finished. The timestamp is set when the job
        // ends, so an export that is still going shows no finish time.
        fields.status === "running" ? null : new Date(),
    ]);
}
/** One export job, or null when there is no such export. */
async function readRangeExport(pool, id) {
    await (0, runner_1.runMigrations)(pool);
    const [rows] = await pool.query(`SELECT ${JOB_COLUMNS} FROM range_exports WHERE id = ?`, [id]);
    const r = rows[0];
    if (!r)
        return null;
    return toState(r);
}
/** The exports this install has seen, newest first. */
async function listRangeExports(pool, limit = 20) {
    await (0, runner_1.runMigrations)(pool);
    const [rows] = await pool.query(`SELECT ${JOB_COLUMNS} FROM range_exports ORDER BY started_at DESC, id DESC LIMIT ?`, [Math.max(1, Math.min(limit, 200))]);
    return rows.map(toState);
}
function toState(r) {
    const status = r.status === "success" ? "success" : r.status === "failed" ? "failed" : "running";
    return {
        id: String(r.id),
        filename: String(r.filename ?? ""),
        countryCode: r.country_code === null || r.country_code === undefined ? null : String(r.country_code),
        status,
        rows: Number(r.rows ?? 0),
        bytes: Number(r.bytes ?? 0),
        errorMessage: r.error_message === null || r.error_message === undefined ? null : String(r.error_message),
        startedAt: r.started_at ?? null,
        finishedAt: r.finished_at ?? null,
    };
}
//# sourceMappingURL=rangeExportJob.js.map