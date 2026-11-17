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
import type { Pool } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { parseIp } from "../ip";
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
export async function importRanges(
  pool: Pool,
  records: readonly RangeRecord[],
): Promise<ImportResult> {
  let inserted = 0;
  const failures: ImportFailure[] = [];

  for (let i = 0; i < records.length; i += CHUNK_ROWS) {
    const chunk = records.slice(i, i + CHUNK_ROWS);
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
            line: record.line,
            start: record.start,
            reason: describeWriteError(err, batchError),
          });
        }
      }
    }
  }

  return { inserted, failed: failures.length, failures };
}

async function writeChunk(pool: Pool, records: readonly RangeRecord[]): Promise<void> {
  const values: unknown[] = [];
  const placeholders = records.map((record) => {
    const startIp = parseIp(record.start);
    const endIp = parseIp(record.end);
    if (!startIp || !endIp) {
      throw new Error(`not a valid address pair: ${record.start} → ${record.end}`);
    }
    values.push(
      startIp,
      endIp,
      computeRangeSize(startIp, endIp).toString(),
      record.countryCode,
      record.countryName,
      record.region,
      record.city,
      record.postalCode,
      record.latitude,
      record.longitude,
      record.timezone,
      record.isp,
      record.asn,
      record.asnOrg,
      IMPORT_SOURCE_TAG,
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

export interface ReplaceOptions {
  /** The job record to update as rows land. Omitted by callers that run
   *  inline and have nowhere to report. */
  readonly importId?: number;
  /** Called with the running total so a long run can show a bar. */
  readonly onProgress?: (rowsDone: number) => void;
}

/**
 * Replace the whole library with the ranges in `input`.
 *
 * Staging, then RENAME — the same shape the ETL uses, for the same reason.
 * A nine-million-row merge through `ON DUPLICATE KEY UPDATE` is hours of
 * index work with the live table being written the whole time. Filling
 * `ip_ranges_new` and swapping touches the live table for the instant the
 * RENAME takes.
 *
 * What makes the swap safe to offer at all:
 *
 *   · The live table is not touched until the upload has been read to the
 *     end and every row is in the staging table. A file that turns out to
 *     be broken on its last line leaves the old table exactly as it was.
 *   · Operator-owned rows (`multi-provider`, `import`) are copied forward
 *     first, so a replacement does not silently undo an import or a
 *     backfill.
 *   · The run takes the ETL lock. Both flows truncate `ip_ranges_new` and
 *     RENAME it; running them together means one wipe takes the other's
 *     partial insert with it and the survivor is whichever rename landed
 *     second.
 */
export async function replaceRangesFromStream(
  pool: Pool,
  input: AsyncIterable<Buffer | string>,
  options: ReplaceOptions = {},
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
    options.onProgress?.(rowsDone);
  };

  try {
    const result = await withEtlRunLock(pool, async () => {
      await runMigrations(pool);
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

      // The old table's operator-owned rows come forward, minus the ones
      // the upload already covers — the uploaded row is the newer
      // statement of intent and wins.
      const preserved = await preserveManualRows(pool);

      const swap = await atomicSwapRanges(pool);
      if (swap.status !== "success") {
        throw new Error(`the table swap failed: ${swap.errorMessage ?? "unknown error"}`);
      }

      const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM ip_ranges");
      return {
        written: readRows,
        preserved: preserved.preserved,
        total: Number(rows[0]?.n ?? 0),
      };
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
      // A record left at `running` is indistinguishable from one still
      // going — the bar sits at 40% forever and the next import is refused
      // as "one is already in progress".
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

/** The file's record shape as the storage layer's row shape. Addresses are
 *  parsed here and nowhere else on the way in. */
function toIpRangeRow(record: RangeRecord): IpRangeRow {
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
