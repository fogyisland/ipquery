// SPDX-License-Identifier: MIT
//
// The range export, as a job that outlives the request that started it.
//
// A library-sized export writes around two gigabytes, and it takes long
// enough that a proxy in front of the server times the request out. If the
// work runs inside the request, the request is held open for as long as the
// export takes — and when the proxy gives up, the export goes with it.
//
// So the export runs here, detached, and the request that started it
// returns a redirect to the page that shows how far it has got. This is
// the same shape as the import (src/storage/rangeImportJob.ts) and the ETL
// trigger (src/web/routes/admin.ts): the job record is written first, the
// work is started with `void`, and the request answers immediately.
//
// What this module owns:
//
//   · the detached call, and the error handling around it — a job that
//     fails has to say so in the job record, not vanish into a rejected
//     promise nobody is listening to
//   · the job record itself, in the `range_exports` table. It used to live
//     in a Map in the route module, which a restart emptied while the
//     files stayed on disk.
//
// What it does NOT own: the file's contents. The exporter streams the rows
// out (src/storage/rangeExport.ts); this module only decides when to start
// it and what to record about it.
import type { Pool } from "mysql2/promise";
import type { FastifyBaseLogger } from "fastify";
import type { RowDataPacket } from "mysql2";
import * as path from "node:path";
import { exportRangesToFile } from "./rangeExport";
import { runMigrations } from "./migrations/runner";

/** What the export job is doing now, or what it ended up doing. */
export type RangeExportStatus = "running" | "success" | "failed";

export interface RangeExportState {
  /** The id in the URL and in the `range_exports` table. */
  readonly id: string;
  /** The file's name, without a path. */
  readonly filename: string;
  readonly countryCode: string | null;
  readonly status: RangeExportStatus;
  readonly rows: number;
  readonly bytes: number;
  readonly errorMessage: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** The columns every read of a job uses. */
const JOB_COLUMNS =
  "id, filename, country_code, status, rows, bytes, error_message, started_at, finished_at";

/**
 * The exports this process is running.
 *
 * Two exports at once would write two files and race on the same table —
 * not corrupting anything, but doubling the load on a database that is
 * already reading nine million rows. One at a time is the rule the import
 * follows too.
 */
const running = new Map<string, RangeExportJob>();

export interface RangeExportJob {
  readonly id: string;
  /** The file to write, with its full path. */
  readonly filepath: string;
  /** The country to restrict the export to, when the operator chose one. */
  readonly countryCode: string | null;
}

/** Is an export running right now? */
export function isRangeExportRunning(): boolean {
  return running.size > 0;
}

/**
 * Start an export in the background and answer the caller immediately.
 *
 * The job record is written BEFORE the work starts, so the page has
 * something to show the moment the request redirects — and so a job that
 * dies in the first millisecond still leaves a row that says it died.
 */
export async function startRangeExport(
  pool: Pool,
  log: FastifyBaseLogger,
  job: Omit<RangeExportJob, "id"> & { id: string },
): Promise<string> {
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
  void runExport(pool, log, { ...job }).catch((err: unknown) => {
    // `runExport` handles its own failures; this is the belt to its
    // braces, for a failure in the failure handling itself.
    log.error({ err, exportId: job.id }, "the range export failed in a way the job could not record");
  });

  return job.id;
}

/** Do the work. Never throws — every outcome lands in the job record. */
async function runExport(
  pool: Pool,
  log: FastifyBaseLogger,
  job: RangeExportJob,
): Promise<void> {
  try {
    const result = await exportRangesToFile(
      pool,
      job.filepath,
      job.countryCode ? { countryCode: job.countryCode } : {},
    );
    await writeRangeExport(pool, {
      id: job.id,
      filename: path.basename(job.filepath),
      countryCode: job.countryCode,
      status: "success",
      rows: result.rows,
      bytes: result.bytes,
      errorMessage: null,
    });
    log.info(
      { exportId: job.id, rows: result.rows, bytes: result.bytes },
      "the range export finished",
    );
  } catch (err) {
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
    }).catch((writeErr: unknown) => {
      log.error({ err: writeErr, exportId: job.id }, "could not record the export failure");
    });
  } finally {
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
export async function writeRangeExport(
  pool: Pool,
  fields: {
    id: string;
    filename: string;
    countryCode: string | null;
    status: RangeExportStatus;
    rows: number;
    bytes: number;
    errorMessage: string | null;
  },
): Promise<void> {
  await runMigrations(pool);
  await pool.query(
    `INSERT INTO range_exports (id, filename, country_code, status, rows, bytes, error_message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3), ?)
     ON DUPLICATE KEY UPDATE
       filename = VALUES(filename),
       country_code = VALUES(country_code),
       status = VALUES(status),
       rows = VALUES(rows),
       bytes = VALUES(bytes),
       error_message = VALUES(error_message),
       finished_at = VALUES(finished_at)`,
    [
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
    ],
  );
}

/** One export job, or null when there is no such export. */
export async function readRangeExport(pool: Pool, id: string): Promise<RangeExportState | null> {
  await runMigrations(pool);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${JOB_COLUMNS} FROM range_exports WHERE id = ?`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return toState(r);
}

/** The exports this install has seen, newest first. */
export async function listRangeExports(pool: Pool, limit = 20): Promise<RangeExportState[]> {
  await runMigrations(pool);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${JOB_COLUMNS} FROM range_exports ORDER BY started_at DESC, id DESC LIMIT ?`,
    [Math.max(1, Math.min(limit, 200))],
  );
  return rows.map(toState);
}

function toState(r: Record<string, unknown>): RangeExportState {
  const status = r.status === "success" ? "success" : r.status === "failed" ? "failed" : "running";
  return {
    id: String(r.id),
    filename: String(r.filename ?? ""),
    countryCode: r.country_code === null || r.country_code === undefined ? null : String(r.country_code),
    status,
    rows: Number(r.rows ?? 0),
    bytes: Number(r.bytes ?? 0),
    errorMessage: r.error_message === null || r.error_message === undefined ? null : String(r.error_message),
    startedAt: (r.started_at as Date | null) ?? null,
    finishedAt: (r.finished_at as Date | null) ?? null,
  };
}
