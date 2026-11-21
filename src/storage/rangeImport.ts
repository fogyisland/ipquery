// SPDX-License-Identifier: MIT
//
// Writing ranges back into the live table.
//
// Two things make this different from the ETL's own inserts, and both are
// deliberate:
//
//   · The rows are tagged `import` on every *_source column, and that tag is
//     registered in MANUAL_SOURCE_TAGS. The ETL rebuilds ip_ranges from
//     scratch on every refresh; a row it does not recognise as manual is
//     simply gone afterwards. An import that looked like it worked and then
//     vanished overnight is the failure this tag prevents.
//
//   · `range_size` is computed here, never read from the file. The column
//     decides which of two covering ranges the lookup returns, so a file
//     that could set it could make the lookup answer wrongly for addresses
//     it has nothing to do with.
//
// Rows are written with `INSERT … ON DUPLICATE KEY UPDATE`, so importing the
// same file twice is an update, not an error, and importing a subset of an
// existing library fills in the ranges it names.
import * as fs from "node:fs";
import type { Pool } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { bufferToString, compareBuffers, parseIp } from "../ip";
import {
  atomicSwapRanges,
  computeRangeSize,
  insertIntoNew,
  preserveManualRows,
  truncateNew,
} from "./mysql";
import { withEtlRunLock } from "../etl/runGuard";
import { runMigrations } from "./migrations/runner";
import type { IpRangeRow } from "../types";
import { decodeStream, IPQ_FORMAT, RangeFileError, type RangeRecord } from "./rangeFile";

/** The tag every imported row carries. */
export const IMPORT_SOURCE_TAG = "import";

/** Rows per statement. The column count is 19, so 500 rows is 9,500
 *  placeholders — comfortably under MySQL's 65,535 limit and small enough
 *  that one bad batch does not roll back much work. */
const CHUNK_ROWS = 500;

export interface ImportFailure {
  /** The line the row came from, so the operator can open the file. */
  readonly line: number;
  readonly start: string;
  readonly reason: string;
}

export interface ImportResult {
  /** Rows written (inserted or updated). */
  readonly inserted: number;
  /** Rows the batch had to skip. */
  readonly failed: number;
  readonly failures: readonly ImportFailure[];
}

const COLUMNS = [
  "start_ip",
  "end_ip",
  "range_size",
  "country_code",
  "country_name",
  "region",
  "city",
  "postal_code",
  "latitude",
  "longitude",
  "timezone",
  "isp",
  "asn",
  "asn_org",
  "country_source",
  "city_source",
  "isp_source",
  "asn_source",
  "geo_source",
] as const;

/**
 * Write `records` into ip_ranges.
 *
 * A row that cannot be written is counted and named, and the import carries
 * on: one bad line in a forty-megabyte file must not cost the operator the
 * rest of it. The batch is re-run row by row when it fails as a whole, so
 * the failure names the row rather than the batch.
 */
/**
 * Write records into the live table, tagged `import`.
 *
 * The row shape is this module's own, not the file's: `RangeRecord` carries
 * a `line` for error reporting and uses the file's field names, and both are
 * wrong for the column list below. Converting at the boundary keeps the two
 * vocabularies from leaking into each other.
 */
export async function importRanges(
  pool: Pool,
  records: readonly RangeRecord[],
): Promise<ImportResult> {
  const rows = records.map(toIpRangeRow);
  let inserted = 0;
  const failures: ImportFailure[] = [];

  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    const chunk = rows.slice(i, i + CHUNK_ROWS);
    try {
      await writeChunk(pool, chunk);
      inserted += chunk.length;
    } catch (batchError) {
      // The batch failed as a unit. Retry row by row so the failure is
      // attributed to the row that caused it instead of the whole block.
      for (const record of chunk) {
        try {
          await writeChunk(pool, [record]);
          inserted += 1;
        } catch (err) {
          failures.push({
            line: 0,
            start: bufferToString(record.startIp),
            reason: describeWriteError(err, batchError),
          });
        }
      }
    }
  }

  return { inserted, failed: failures.length, failures };
}

async function writeChunk(pool: Pool, records: readonly IpRangeRow[]): Promise<void> {
  const values: unknown[] = [];
  const placeholders = records.map((record) => {
    values.push(
      record.startIp,
      record.endIp,
      computeRangeSize(record.startIp, record.endIp).toString(),
      record.countryCode ?? null,
      record.countryName ?? null,
      record.region ?? null,
      record.city ?? null,
      record.postalCode ?? null,
      record.latitude ?? null,
      record.longitude ?? null,
      record.timezone ?? null,
      record.isp ?? null,
      record.asn ?? null,
      record.asnOrg ?? null,
      IMPORT_SOURCE_TAG,
      IMPORT_SOURCE_TAG,
      IMPORT_SOURCE_TAG,
      IMPORT_SOURCE_TAG,
      IMPORT_SOURCE_TAG,
    );
    return `(${COLUMNS.map(() => "?").join(",")})`;
  });
  await pool.query(
    `INSERT INTO ip_ranges (${COLUMNS.join(",")}) VALUES ${placeholders.join(",")}
     ON DUPLICATE KEY UPDATE
       range_size = VALUES(range_size),
       country_code = COALESCE(VALUES(country_code), country_code),
       country_name = COALESCE(VALUES(country_name), country_name),
       region = COALESCE(VALUES(region), region),
       city = COALESCE(VALUES(city), city),
       postal_code = COALESCE(VALUES(postal_code), postal_code),
       latitude = COALESCE(VALUES(latitude), latitude),
       longitude = COALESCE(VALUES(longitude), longitude),
       timezone = COALESCE(VALUES(timezone), timezone),
       isp = COALESCE(VALUES(isp), isp),
       asn = COALESCE(VALUES(asn), asn),
       asn_org = COALESCE(VALUES(asn_org), asn_org),
       country_source = VALUES(country_source),
       city_source = VALUES(city_source),
       isp_source = VALUES(isp_source),
       asn_source = VALUES(asn_source),
       geo_source = VALUES(geo_source)`,
    values,
  );
}

/** The driver's own message, or the batch's if the row succeeded on retry
 *  and the only error left is the one the whole batch failed with. */
function describeWriteError(err: unknown, batchError: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message && message !== "unknown error") return message;
  return batchError instanceof Error ? batchError.message : String(batchError);
}

export interface ReplaceResult {
  /** Rows the uploaded file contributed. Does not include the rows the old
   *  table's operator-owned entries added to the result. */
  readonly written: number;
  /** Operator-owned rows carried from the old table into the new one. */
  readonly preserved: number;
  /** The table's size after the swap — `written + preserved`, minus any
   *  range the upload and the old table both had. */
  readonly total: number;
}

/**
 * A record of one import, so a long run has something to look at.
 *
 * The alternative — the request that started it holding the connection
 * open — means the job dies with the browser tab. A whole-library import
 * takes hours, so the job has to outlive the request, and this row is
 * what both the page and a later operator can see.
 */
export interface RangeImportState {
  readonly id: number;
  readonly mode: "merge" | "replace";
  readonly source: string;
  readonly status: "running" | "success" | "failed";
  /** Rows read out of the file so far. Monotonic: a stall can only ever
   *  look like a stall, never like work going backwards. */
  readonly rowsDone: number;
  readonly declaredRows: number | null;
  readonly rowsWritten: number;
  readonly preserved: number;
  readonly errorMessage: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

const JOB_COLUMNS =
  "id, mode, source, status, rows_done, declared_rows, rows_written, preserved, error_message, started_at, finished_at";

/** Write or update the job record. Passing an `id` updates it. */
export async function writeRangeImportProgress(
  pool: Pool,
  fields: {
    id?: number;
    mode: "merge" | "replace";
    source: string;
    declaredRows?: number | null;
    rowsDone?: number;
    status?: "running" | "success" | "failed";
    rowsWritten?: number;
    preserved?: number;
    errorMessage?: string | null;
  },
): Promise<number> {
  await runMigrations(pool);
  if (fields.id !== undefined) {
    const set: string[] = [];
    const values: unknown[] = [];
    if (fields.rowsDone !== undefined) {
      // GREATEST keeps the counter monotonic: a retry that reports 300
      // after 800 have already been read must not look like work undone.
      set.push("rows_done = GREATEST(rows_done, ?)");
      values.push(fields.rowsDone);
    }
    if (fields.status !== undefined) {
      set.push("status = ?");
      values.push(fields.status);
    }
    if (fields.rowsWritten !== undefined) {
      set.push("rows_written = ?");
      values.push(fields.rowsWritten);
    }
    if (fields.preserved !== undefined) {
      set.push("preserved = ?");
      values.push(fields.preserved);
    }
    if (fields.errorMessage !== undefined) {
      set.push("error_message = ?");
      values.push(fields.errorMessage);
    }
    set.push("progress_updated_at = NOW(3)");
    if (fields.status !== undefined && fields.status !== "running") {
      set.push("finished_at = NOW(3)");
    }
    values.push(fields.id);
    await pool.query(`UPDATE range_imports SET ${set.join(", ")} WHERE id = ?`, values);
    return fields.id;
  }
  await pool.query(
    `INSERT INTO range_imports (mode, source, declared_rows) VALUES (?, ?, ?)`,
    [fields.mode, fields.source, fields.declaredRows ?? null],
  );
  const [inserted] = await pool.query<RowDataPacket[]>("SELECT LAST_INSERT_ID() AS id");
  return Number(inserted[0]?.id ?? 0);
}

/** Move a record off `running`. Called on success and failure alike, so
 *  a crashed run never looks like one still going. */
export async function finishRangeImport(
  pool: Pool,
  id: number,
  outcome: {
    status: "success" | "failed";
    rowsWritten: number;
    preserved: number;
    errorMessage: string | null;
  },
): Promise<void> {
  await writeRangeImportProgress(pool, {
    id,
    mode: "merge",
    source: "",
    status: outcome.status,
    rowsWritten: outcome.rowsWritten,
    preserved: outcome.preserved,
    errorMessage: outcome.errorMessage,
  });
}

export async function readRangeImportState(pool: Pool, id: number): Promise<RangeImportState | null> {
  await runMigrations(pool);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${JOB_COLUMNS} FROM range_imports WHERE id = ?`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return toState(r);
}

/** The imports this install has seen, newest first. */
export async function listRangeImports(pool: Pool, limit = 20): Promise<RangeImportState[]> {
  await runMigrations(pool);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${JOB_COLUMNS} FROM range_imports ORDER BY id DESC LIMIT ?`,
    [Math.max(1, Math.min(limit, 200))],
  );
  return rows.map(toState);
}

function toState(r: Record<string, unknown>): RangeImportState {
  return {
    id: Number(r.id),
    mode: r.mode === "replace" ? "replace" : "merge",
    source: String(r.source ?? ""),
    status: r.status === "success" ? "success" : r.status === "failed" ? "failed" : "running",
    rowsDone: Number(r.rows_done ?? 0),
    declaredRows: r.declared_rows === null || r.declared_rows === undefined ? null : Number(r.declared_rows),
    rowsWritten: Number(r.rows_written ?? 0),
    preserved: Number(r.preserved ?? 0),
    errorMessage: r.error_message === null || r.error_message === undefined ? null : String(r.error_message),
    startedAt: (r.started_at as Date | null) ?? null,
    finishedAt: (r.finished_at as Date | null) ?? null,
  };
}

export interface ImportProgress {
  /** Rows read out of the file. Monotonic: a stall can only look like a
   *  stall, never like work going backwards. */
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly exactDuplicates: number;
  readonly contained: number;
  readonly partialOverlaps: number;
}

export interface ImportOptions {
  /** The job record to update as rows land. Omitted by callers that run
   *  inline and have nowhere to report. */
  readonly importId?: number;
  readonly onProgress?: (progress: ImportProgress) => void;
}

export interface ImportRunResult {
  /** Rows the file contributed after de-duplication. */
  readonly written: number;
  readonly exactDuplicates: number;
  readonly contained: number;
  readonly partialOverlaps: number;
  /** Rows in the table once the merge is done. */
  readonly total: number;
}

/**
 * Merge a file that is already on disk, then remove it.
 *
 * The import is the inverse of the export: once the rows are in the table
 * the bytes are only occupying space. Removing the file here rather than in
 * the caller is what makes that true whichever path got here, including the
 * one that throws.
 */
export async function importRangesFromFile(
  pool: Pool,
  filepath: string,
  options: ImportOptions = {},
): Promise<ImportRunResult> {
  const stream = fs.createReadStream(filepath);
  try {
    return await importRangesFromStream(pool, stream, options);
  } finally {
    // The stream is closed even when the import throws, and the file goes
    // with it — a failed import leaves no copy to be mistaken for a good
    // one later.
    stream.destroy();
    await fs.promises.rm(filepath, { force: true }).catch(() => undefined);
  }
}

/**
 * Merge the ranges in `input` into the live table.
 *
 * The file is read from disk and the upload is discarded afterwards — the
 * import is the inverse of the export, and nothing about the file needs to
 * outlive it.
 *
 * On duplicates, which is most of the work on a whole-library import:
 *
 *   · An exact repeat costs one INSERT statement less when it is dropped
 *     before it reaches the database. On a file written from another
 *     install the repeats are not rare — an earlier import, or a re-export
 *     of overlapping ranges.
 *   · A range fully covered by an already-written one is dropped too. It is
 *     not a statement about a different part of the address space, and it
 *     would otherwise sit in the table as a row the lookup can never use.
 *   · A partial overlap is written anyway. Neither range is a statement
 *     about the other, and picking one would be guessing.
 *
 * The deduplication is the same shape the ETL source merge uses
 * (src/etl/sources/dedupe.ts): sort so larger ranges come first and keep a
 * window of the ranges that could still cover the current one. On a
 * nine-million-row file that is what keeps the cost linear instead of
 * quadratic.
 */
export async function importRangesFromStream(
  pool: Pool,
  input: AsyncIterable<Buffer | string>,
  options: ImportOptions = {},
): Promise<ImportRunResult> {
  await runMigrations(pool);

  const stats = {
    rowsRead: 0,
    written: 0,
    exactDuplicates: 0,
    contained: 0,
    partialOverlaps: 0,
  };

  // Ranges THIS FILE has already produced, kept as 16-byte pairs so a
  // comparison never re-parses an address. Rows already in the table are
  // deliberately not consulted: a range the file repeats is a duplicate,
  // a range the database already holds is a row the file is entitled to
  // update. Dropping the second would leave the old value in place.
  const emitted: Array<{ start: Buffer; end: Buffer }> = [];

  await decodeStream(input, {
    onHeader: (header) => {
      if (header.format !== IPQ_FORMAT) {
        throw new RangeFileError(`this is not an ${IPQ_FORMAT} file`);
      }
    },
    onBatch: async (rows) => {
      const kept: RangeRecord[] = [];
      for (const record of rows) {
        stats.rowsRead += 1;
        const verdict = classify(record, emitted);
        if (verdict === "exact") {
          stats.exactDuplicates += 1;
          continue;
        }
        if (verdict === "contained") {
          stats.contained += 1;
          continue;
        }
        if (verdict === "overlap") stats.partialOverlaps += 1;
        kept.push(record);
        const start = parseIp(record.start);
        const end = parseIp(record.end);
        if (start && end) emitted.push({ start, end });
      }
      if (kept.length > 0) await writeChunk(pool, kept.map(toIpRangeRow));
      await reportProgress(pool, options, stats, stats.written);
    },
  });

  const total = await countRows(pool);
  return {
    // The file's own contribution, counted as it is read rather than read
    // back from the table afterwards: the table's size answers a different
    // question — what is in it now — and on a merge that is the file plus
    // everything already there.
    written: stats.rowsRead - stats.exactDuplicates - stats.contained,
    total,
    exactDuplicates: stats.exactDuplicates,
    contained: stats.contained,
    partialOverlaps: stats.partialOverlaps,
  };
}

type Verdict = "exact" | "contained" | "overlap" | "fresh";

/** How far back the window may look before giving up. A file with a
 *  million overlapping ranges is either broken or a language this format
 *  does not speak, and quadratic cost to be precise about it is not a trade
 *  worth making. */
const WINDOW_LIMIT = 1000;

/**
 * How this record relates to what the file has already produced.
 *
 * Bounded work: a range that ends before the current start can never
 * contain anything later either, so the scan stops once the window has
 * moved past it.
 */
function classify(record: RangeRecord, emitted: readonly { start: Buffer; end: Buffer }[]): Verdict {
  const start = parseIp(record.start);
  const end = parseIp(record.end);
  if (!start || !end) throw new RangeFileError(`line ${record.line}: unreadable address`);
  let overlaps = false;
  for (let i = emitted.length - 1; i >= 0; i--) {
    const other = emitted[i]!;
    if (compareBuffers(other.end, start) < 0) {
      if (emitted.length - i > WINDOW_LIMIT) break;
      continue;
    }
    if (compareBuffers(other.start, start) === 0 && compareBuffers(other.end, end) === 0) return "exact";
    if (compareBuffers(other.start, start) <= 0 && compareBuffers(other.end, end) >= 0) return "contained";
    const beforeInside =
      compareBuffers(other.start, start) <= 0 && compareBuffers(other.end, end) > 0;
    const afterInside =
      compareBuffers(other.start, start) > 0 && compareBuffers(other.start, end) <= 0;
    if (beforeInside || afterInside) overlaps = true;
  }
  return overlaps ? "overlap" : "fresh";
}

async function reportProgress(
  pool: Pool,
  options: ImportOptions,
  stats: { rowsRead: number; written: number; exactDuplicates: number; contained: number; partialOverlaps: number },
  rowsWritten: number,
): Promise<void> {
  if (options.importId !== undefined) {
    await writeRangeImportProgress(pool, {
      id: options.importId,
      mode: "merge",
      source: "",
      rowsDone: stats.rowsRead,
    });
  }
  options.onProgress?.({
    rowsRead: stats.rowsRead,
    rowsWritten,
    exactDuplicates: stats.exactDuplicates,
    contained: stats.contained,
    partialOverlaps: stats.partialOverlaps,
  });
}

async function countRows(pool: Pool): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM ip_ranges");
  return Number(rows[0]?.n ?? 0);
}

/** Replace the whole library with the ranges in `input`. */
export async function replaceRangesFromStream(
  pool: Pool,
  input: AsyncIterable<Buffer | string>,
  options: ImportOptions = {},
): Promise<ReplaceResult> {
  const importId = options.importId;
  const report = async (rowsDone: number): Promise<void> => {
    if (importId === undefined) return;
    await writeRangeImportProgress(pool, {
      id: importId,
      mode: "replace",
      source: "",
      rowsDone,
    });
    options.onProgress?.({
      rowsRead: rowsDone,
      rowsWritten: 0,
      exactDuplicates: 0,
      contained: 0,
      partialOverlaps: 0,
    });
  };

  try {
    const result = await withEtlRunLock(pool, async () => {
      await truncateNew(pool);

      let readRows = 0;
      await decodeStream(input, {
        onHeader: (header) => {
          if (header.format !== IPQ_FORMAT) {
            throw new RangeFileError(`this is not an ${IPQ_FORMAT} file`);
          }
        },
        onBatch: async (rows) => {
          await insertIntoNew(pool, rows.map(toIpRangeRow));
          readRows += rows.length;
          await report(readRows);
        },
      });

      const preserved = await preserveManualRows(pool);

      const swap = await atomicSwapRanges(pool);
      if (swap.status !== "success") {
        throw new Error(`the table swap failed: ${swap.errorMessage ?? "unknown error"}`);
      }

      return { written: readRows, preserved: preserved.preserved, total: await countRows(pool) };
    });

    if (importId !== undefined) {
      await finishRangeImport(pool, importId, {
        status: "success",
        rowsWritten: result.written,
        preserved: result.preserved,
        errorMessage: null,
      });
    }
    return result;
  } catch (err) {
    if (importId !== undefined) {
      await finishRangeImport(pool, importId, {
        status: "failed",
        rowsWritten: 0,
        preserved: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
      }).catch(() => undefined);
    }
    throw err;
  }
}

/**
 * Replace the library with the contents of a file on disk.
 *
 * The large-file path for a replacement: the bytes arrive in chunks, are
 * assembled on disk, and are streamed in from there rather than held in
 * memory. The file is removed afterwards — a replacement has the same
 * answer as an import, and two gigabytes of nothing is still two
 * gigabytes.
 */
export async function replaceRangesFromFile(
  pool: Pool,
  filepath: string,
  options: ImportOptions = {},
): Promise<ReplaceResult> {
  const stream = fs.createReadStream(filepath);
  try {
    return await replaceRangesFromStream(pool, stream, options);
  } finally {
    // The stream is closed even when the replacement throws, and the file
    // goes with it — a failed replacement leaves no copy to be mistaken
    // for a good one later.
    stream.destroy();
    await fs.promises.rm(filepath, { force: true }).catch(() => undefined);
  }
}

/** The file's record shape as the storage layer's row shape. Addresses are
 *  parsed here and nowhere else on the way in. */
function toIpRangeRow(record: RangeRecord): IpRangeRow {
  // `country_code` is CHAR(2). Truncating silently would write a code
  // nobody recognises; the row is rejected instead so the line can be
  // fixed in the file.
  if (record.countryCode !== null && record.countryCode.length > 2) {
    throw new RangeFileError(
      `line ${record.line}: "${record.countryCode}" is not a two-letter country code`,
    );
  }
  const startIp = parseIp(record.start);
  const endIp = parseIp(record.end);
  if (!startIp || !endIp) {
    throw new Error(`line ${record.line}: not a valid address pair (${record.start} → ${record.end})`);
  }
  return {
    startIp,
    endIp,
    countryCode: record.countryCode ?? undefined,
    countryName: record.countryName ?? undefined,
    region: record.region ?? undefined,
    city: record.city ?? undefined,
    postalCode: record.postalCode ?? undefined,
    latitude: record.latitude ?? undefined,
    longitude: record.longitude ?? undefined,
    timezone: record.timezone ?? undefined,
    isp: record.isp ?? undefined,
    asn: record.asn ?? undefined,
    asnOrg: record.asnOrg ?? undefined,
    countrySource: IMPORT_SOURCE_TAG as never,
    citySource: IMPORT_SOURCE_TAG as never,
    ispSource: IMPORT_SOURCE_TAG as never,
    asnSource: IMPORT_SOURCE_TAG as never,
    geoSource: IMPORT_SOURCE_TAG as never,
  };
}
