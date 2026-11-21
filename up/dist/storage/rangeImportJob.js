"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runningRangeImports = runningRangeImports;
exports.isRangeImportRunning = isRangeImportRunning;
exports.startRangeImport = startRangeImport;
const rangeImport_1 = require("./rangeImport");
const rangeUpload_1 = require("./rangeUpload");
/**
 * The imports currently running in this process.
 *
 * This is the in-process half of the exclusion. The database lock
 * (`withEtlRunLock`) is the cross-process half: two imports in two
 * processes would race on truncateNew + atomicSwapRanges, and the
 * surviving table would be whichever swap landed last — silently
 * half-populated.
 *
 * What this map buys is a better answer than "your replacement is
 * refused". Two merges could run at once without corrupting anything,
 * but they would fight over the same rows and neither would finish
 * quickly; and a replacement must not start while a merge is writing.
 */
const running = new Map();
/** The imports this process is running, for the page to show. */
function runningRangeImports() {
    return [...running.values()];
}
/** Is an import running right now? */
function isRangeImportRunning() {
    return running.size > 0;
}
/**
 * Start an import in the background and answer the caller immediately.
 *
 * The job record is written BEFORE the work starts, so the page has
 * something to show the moment the request redirects — and so a job that
 * dies in the first millisecond still leaves a row that says it died.
 */
async function startRangeImport(pool, log, job) {
    const importId = await (0, rangeImport_1.writeRangeImportProgress)(pool, {
        mode: job.mode,
        source: job.filepath,
        declaredRows: job.declaredRows,
    });
    const started = { ...job, importId };
    running.set(importId, started);
    // The detached call. Everything it can throw is caught here: this
    // promise is not awaited by anyone, so an unhandled rejection would
    // take the process down in Node 15 and later.
    void runImport(pool, log, started).catch((err) => {
        // `runImport` handles its own failures; this is the belt to its
        // braces, for a failure in the failure handling itself.
        log.error({ err, importId }, "the range import failed in a way the job could not record");
    });
    return importId;
}
/** Do the work. Never throws — every outcome lands in the job record. */
async function runImport(pool, log, job) {
    try {
        if (job.mode === "replace") {
            const result = await (0, rangeImport_1.replaceRangesFromFile)(pool, job.filepath, { importId: job.importId });
            log.info({ importId: job.importId, written: result.written, preserved: result.preserved }, "the range replacement finished");
        }
        else {
            const result = await (0, rangeImport_1.importRangesFromFile)(pool, job.filepath, { importId: job.importId });
            log.info({
                importId: job.importId,
                written: result.written,
                duplicates: result.exactDuplicates + result.contained,
            }, "the range import finished");
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err, importId: job.importId }, "the range import failed");
        // The job record is the operator's only way of finding out. A job
        // that stays `running` reads as "still going" for the rest of the
        // install's life, so the failure is written down even though the
        // import function has usually written it already.
        await (0, rangeImport_1.finishRangeImport)(pool, job.importId, {
            status: "failed",
            rowsWritten: 0,
            preserved: 0,
            errorMessage: message,
        }).catch((finishErr) => {
            log.error({ err: finishErr, importId: job.importId }, "could not record the import failure");
        });
    }
    finally {
        running.delete(job.importId);
        // The bytes are the importer's business; the bookkeeping is ours.
        // The upload row and its chunk rows go whatever the outcome.
        if (job.uploadId !== null) {
            await (0, rangeUpload_1.discardUpload)(pool, job.uploadId).catch((err) => {
                log.warn({ err, uploadId: job.uploadId }, "could not clean up the upload");
            });
        }
    }
}
//# sourceMappingURL=rangeImportJob.js.map