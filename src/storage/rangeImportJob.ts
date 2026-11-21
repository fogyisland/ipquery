// SPDX-License-Identifier: MIT
//
// The range import, as a job that outlives the request that started it.
//
// A whole-library .ipq is around two gigabytes, and importing it takes
// hours. If that work runs inside the request, the request is held open
// for hours — and any proxy in front of this server kills it long before
// that, taking the import with it. The request has to answer as soon as
// the job is accepted.
//
// So the import runs here, detached, and the request that started it
// returns a redirect to the page that shows how far it has got. This is
// the same shape as the ETL trigger (src/web/routes/admin.ts): the job
// record is written first, the work is started with `void`, and the
// request answers immediately.
//
// What this module owns:
//
//   · the detached call, and the error handling around it — a job that
//     fails has to say so in the job record, not vanish into a rejected
//     promise nobody is listening to
//   · the tracking of what is currently running, so a second import can
//     be refused while one is in flight
//
// What it does NOT own: the job record itself. That lives in
// `range_imports` (see src/storage/rangeImport.ts), because a job that
// only exists in memory is a job that is lost on a restart.
import type { Pool } from "mysql2/promise";
import type { FastifyBaseLogger } from "fastify";
import {
  finishRangeImport,
  importRangesFromFile,
  replaceRangesFromFile,
  writeRangeImportProgress,
} from "./rangeImport";
import { discardUpload } from "./rangeUpload";

export type RangeImportMode = "merge" | "replace";

export interface RangeImportJob {
  /** The `range_imports` row this job writes its progress to. */
  readonly importId: number;
  readonly mode: RangeImportMode;
  /** The file on disk. Removed when the job finishes, either way. */
  readonly filepath: string;
  /** The upload this file came from, when it came from one. The upload
   *  rows go when the job ends — a failed import leaves no half-uploaded
   *  file for somebody to mistake for a good one. */
  readonly uploadId: number | null;
  /** The row count the file declares, for the progress bar. */
  readonly declaredRows: number | null;
}

/** What the job turned out to be. */
export interface RangeImportOutcome {
  readonly written: number;
  readonly duplicates: number;
  readonly preserved: number;
}

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
const running = new Map<number, RangeImportJob>();

/** The imports this process is running, for the page to show. */
export function runningRangeImports(): readonly RangeImportJob[] {
  return [...running.values()];
}

/** Is an import running right now? */
export function isRangeImportRunning(): boolean {
  return running.size > 0;
}

/**
 * Start an import in the background and answer the caller immediately.
 *
 * The job record is written BEFORE the work starts, so the page has
 * something to show the moment the request redirects — and so a job that
 * dies in the first millisecond still leaves a row that says it died.
 */
export async function startRangeImport(
  pool: Pool,
  log: FastifyBaseLogger,
  job: Omit<RangeImportJob, "importId">,
): Promise<number> {
  const importId = await writeRangeImportProgress(pool, {
    mode: job.mode,
    source: job.filepath,
    declaredRows: job.declaredRows,
  });
  const started: RangeImportJob = { ...job, importId };
  running.set(importId, started);

  // The detached call. Everything it can throw is caught here: this
  // promise is not awaited by anyone, so an unhandled rejection would
  // take the process down in Node 15 and later.
  void runImport(pool, log, started).catch((err: unknown) => {
    // `runImport` handles its own failures; this is the belt to its
    // braces, for a failure in the failure handling itself.
    log.error({ err, importId }, "the range import failed in a way the job could not record");
  });

  return importId;
}

/** Do the work. Never throws — every outcome lands in the job record. */
async function runImport(
  pool: Pool,
  log: FastifyBaseLogger,
  job: RangeImportJob,
): Promise<void> {
  try {
    if (job.mode === "replace") {
      const result = await replaceRangesFromFile(pool, job.filepath, { importId: job.importId });
      log.info(
        { importId: job.importId, written: result.written, preserved: result.preserved },
        "the range replacement finished",
      );
    } else {
      const result = await importRangesFromFile(pool, job.filepath, { importId: job.importId });
      log.info(
        {
          importId: job.importId,
          written: result.written,
          duplicates: result.exactDuplicates + result.contained,
        },
        "the range import finished",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, importId: job.importId }, "the range import failed");
    // The job record is the operator's only way of finding out. A job
    // that stays `running` reads as "still going" for the rest of the
    // install's life, so the failure is written down even though the
    // import function has usually written it already.
    await finishRangeImport(pool, job.importId, {
      status: "failed",
      rowsWritten: 0,
      preserved: 0,
      errorMessage: message,
    }).catch((finishErr: unknown) => {
      log.error({ err: finishErr, importId: job.importId }, "could not record the import failure");
    });
  } finally {
    running.delete(job.importId);
    // The bytes are the importer's business; the bookkeeping is ours.
    // The upload row and its chunk rows go whatever the outcome.
    if (job.uploadId !== null) {
      await discardUpload(pool, job.uploadId).catch((err: unknown) => {
        log.warn({ err, uploadId: job.uploadId }, "could not clean up the upload");
      });
    }
  }
}
