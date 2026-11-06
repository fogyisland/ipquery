// SPDX-License-Identifier: MIT
import * as mysql from "mysql2/promise";
import type { AppConfig } from "../config";
import type { IpRangeRow, EtlRun, Source } from "../types";
import { compareBuffers } from "../ip";

export function createPool(cfg: AppConfig): mysql.Pool {
  return mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
    connectionLimit: cfg.db.poolSize,
    waitForConnections: true,
    multipleStatements: true,
    timezone: "Z",
    dateStrings: false,
  });
}

export async function truncateNew(pool: mysql.Pool): Promise<void> {
  await pool.query("TRUNCATE TABLE ip_ranges_new");
}

// BIGINT UNSIGNED max (2^64 - 1). range_size can't store anything bigger;
// coarse IPv6 ranges (e.g. ::/3) easily exceed 2^64. Clamp so the column
// accepts every row, and `ORDER BY range_size ASC` still picks the most
// specific covering range — all over-2^64 rows collapse to MAX, but those
// are uniformly catchall /16-/3-style allocations where any one is fine.
const MAX_RANGE_SIZE = (1n << 64n) - 1n;

function rangeSize(startIp: Buffer, endIp: Buffer): bigint {
  // BINARY(16) values are 16-byte big-endian unsigned integers. range_size
  // = end - start, used by findRange to pick the smallest covering range.
  // Subtract byte-by-byte with borrow to avoid losing precision on the
  // full IPv6 address space (2^128).
  const start = BigInt("0x" + startIp.toString("hex"));
  const end = BigInt("0x" + endIp.toString("hex"));
  if (end < start) return 0n;
  const diff = end - start;
  return diff > MAX_RANGE_SIZE ? MAX_RANGE_SIZE : diff;
}

export async function insertIntoNew(pool: mysql.Pool, rows: IpRangeRow[]): Promise<void> {
  if (rows.length === 0) return;
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const placeholders = slice
      .map((r) => {
        values.push(
          r.startIp,
          r.endIp,
          rangeSize(r.startIp, r.endIp).toString(),
          r.countryCode ?? null,
          r.countryName ?? null,
          r.region ?? null,
          r.city ?? null,
          r.postalCode ?? null,
          r.latitude ?? null,
          r.longitude ?? null,
          r.timezone ?? null,
          r.isp ?? null,
          r.asn ?? null,
          r.asnOrg ?? null,
          r.countrySource ?? null,
          r.citySource ?? null,
          r.ispSource ?? null,
          r.asnSource ?? null,
          r.geoSource ?? null,
        );
        return "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
      })
      .join(",");
    await pool.query(
      `INSERT INTO ip_ranges_new (start_ip,end_ip,range_size,country_code,country_name,region,city,postal_code,latitude,longitude,timezone,isp,asn,asn_org,country_source,city_source,isp_source,asn_source,geo_source) VALUES ${placeholders}`,
      values,
    );
  }
}

// Upsert variant for the streaming ETL fast path: dedupe rows from multiple
// DB-IP files (city / country / asn) that share identical (start_ip, end_ip)
// ranges by only filling columns that are still NULL. Requires the
// UNIQUE KEY uniq_start_end on ip_ranges_new (migration 013).
//
// `fillCols` lists the columns this chunk is allowed to populate. For
// city-lite that's the full set; for country-lite just `country_code` and
// `country_source`; for asn-lite `asn`, `asn_org`, `asn_source`. Any other
// columns on the row are ignored at INSERT time so a later, higher-priority
// file can backfill them via `COALESCE`.
//
// Returns an UpsertCount so the pipeline can persist per-file counters to
// etl_run_inserts. Counting relies on mysql2's ResultSetHeader.affectedRows
// semantics: with the pool's default flag (CLIENT_FOUND_ROWS off),
// affectedRows === 1 for a successful INSERT and === 2 for an UPDATE kicked
// off by ON DUPLICATE KEY UPDATE. So inserted = affectedRows and
// duplicates = slice.length - affectedRows.
export interface UpsertCount {
  attempted: number;
  inserted: number;
  duplicates: number;
  batchCount: number;
}

export async function insertIntoNewUpsert(
  pool: mysql.Pool,
  rows: IpRangeRow[],
  fillCols: ReadonlySet<keyof IpRangeRow>,
): Promise<UpsertCount> {
  const totals: UpsertCount = { attempted: 0, inserted: 0, duplicates: 0, batchCount: 0 };
  if (rows.length === 0) return totals;
  const CHUNK = 1000;
  totals.attempted = rows.length;
  const allCols: Array<keyof IpRangeRow> = [
    "startIp",
    "endIp",
    "countryCode",
    "countryName",
    "region",
    "city",
    "postalCode",
    "latitude",
    "longitude",
    "timezone",
    "isp",
    "asn",
    "asnOrg",
    "countrySource",
    "citySource",
    "ispSource",
    "asnSource",
    "geoSource",
  ];
  // Always insert start, end, range_size; fillCols decides what else.
  const insertCols: Array<keyof IpRangeRow | "rangeSize"> = [
    "startIp",
    "endIp",
    "rangeSize",
    ...allCols.filter((c) => c !== "startIp" && c !== "endIp" && fillCols.has(c)),
  ];
  const colSql = (c: keyof IpRangeRow | "rangeSize"): string => {
    switch (c) {
      case "startIp":
        return "start_ip";
      case "endIp":
        return "end_ip";
      case "rangeSize":
        return "range_size";
      case "countryCode":
        return "country_code";
      case "countryName":
        return "country_name";
      case "postalCode":
        return "postal_code";
      case "asnOrg":
        return "asn_org";
      case "countrySource":
        return "country_source";
      case "citySource":
        return "city_source";
      case "ispSource":
        return "isp_source";
      case "asnSource":
        return "asn_source";
      case "geoSource":
        return "geo_source";
      default:
        return c;
    }
  };
  // range_size is always overwritten with the new row's computed size
  // because (start_ip, end_ip) is the unique key — same key means same
  // range, so the size is necessarily identical.
  const updateClauses = allCols
    .filter((c) => c !== "startIp" && c !== "endIp" && fillCols.has(c))
    .map((c) => `${colSql(c)} = COALESCE(${colSql(c)}, VALUES(${colSql(c)}))`)
    .concat(["range_size = VALUES(range_size)"])
    .join(", ");
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const placeholders = slice
      .map((r) => {
        for (const c of insertCols) {
          if (c === "startIp") values.push(r.startIp);
          else if (c === "endIp") values.push(r.endIp);
          else if (c === "rangeSize") values.push(rangeSize(r.startIp, r.endIp).toString());
          else values.push((r as unknown as Record<string, unknown>)[c as string] ?? null);
        }
        return `(${insertCols.map(() => "?").join(",")})`;
      })
      .join(",");
    const [res] = await pool.query<mysql.ResultSetHeader>(
      `INSERT INTO ip_ranges_new (${insertCols.map(colSql).join(",")}) VALUES ${placeholders}` +
        ` ON DUPLICATE KEY UPDATE ${updateClauses}`,
      values,
    );
    const affected = Number(res.affectedRows);
    // MySQL semantics for INSERT ... ON DUPLICATE KEY UPDATE:
    //   fresh insert     → affectedRows += 1
    //   duplicate updated→ affectedRows += 2
    // So `affected - slice.length` is the duplicate count, and the
    // remainder (slice.length - duplicates) is the freshly inserted rows.
    // (INSERT IGNORE would give 0 for dup, but we use ON DUPLICATE so we
    // can fill in missing columns via COALESCE.)
    const duplicates = Math.max(0, affected - slice.length);
    totals.duplicates += duplicates;
    totals.inserted += slice.length - duplicates;
    totals.batchCount += 1;
  }
  return totals;
}

export interface SwapResult {
  status: "success" | "failed";
  durationMs: number;
  errorMessage?: string;
}

export async function atomicSwapRanges(pool: mysql.Pool): Promise<SwapResult> {
  const conn = await pool.getConnection();
  const t0 = Date.now();
  try {
    await conn.beginTransaction();
    await conn.query(
      "RENAME TABLE ip_ranges TO ip_ranges_old, ip_ranges_new TO ip_ranges, ip_ranges_old TO ip_ranges_new",
    );
    await conn.commit();
    return { status: "success", durationMs: Date.now() - t0 };
  } catch (err) {
    await conn.rollback();
    const msg = (err as Error).message;
    return { status: "failed", durationMs: Date.now() - t0, errorMessage: msg };
  } finally {
    conn.release();
  }
}

export async function findRange(pool: mysql.Pool, ipBuf: Buffer): Promise<IpRangeRow | null> {
  // Two-step lookup. We can't just `ORDER BY range_size ASC LIMIT 1` because
  // MySQL 5.7 (no descending indexes) falls back to a full index scan over
  // idx_range_size to apply the WHERE filter — ~9s on the 8.3M-row DB-IP
  // table for mid-range IPv4 targets. Instead:
  //   1. Pull the 100 ranges with the largest start_ip <= target. The
  //      uniq_start_end index satisfies this as a backward range scan with
  //      LIMIT — measured ~100ms for mid-range IPv4 (vs ~9s above).
  //   2. In JS, keep only rows that actually cover the target (end_ip >=
  //      target), then sort by range_size ASC and pick the smallest.
  //
  // LIMIT 100 is the safety margin: in DB-IP data, the number of distinct
  // covering ranges for any IP is small (typically 1-3 — one city-lite
  // /24 plus zero or one coarser country/asn range). 100 covers all
  // realistic overlap while keeping the row fetch cheap.
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT start_ip, end_ip, country_code, country_name, region, city, postal_code,
            latitude, longitude, timezone, isp, asn, asn_org,
            country_source, city_source, isp_source, asn_source, geo_source,
            range_size
       FROM ip_ranges USE INDEX (uniq_start_end)
       WHERE start_ip <= ?
       ORDER BY start_ip DESC
       LIMIT 100`,
    [ipBuf],
  );
  // Filter to rows that actually cover the target, then pick the smallest
  // range_size among them. range_size is stored as a decimal string in MySQL
  // (BIGINT UNSIGNED) — parse it back to bigint for an exact sort.
  let best: { row: mysql.RowDataPacket; size: bigint } | null = null;
  for (const r of rows) {
    const endIp = r.end_ip as Buffer;
    if (compareBuffers(endIp, ipBuf) < 0) continue;
    const size = BigInt(r.range_size as string | number);
    if (best === null || size < best.size) best = { row: r, size };
  }
  if (best === null) return null;
  const r = best.row;
  return {
    startIp: r.start_ip as Buffer,
    endIp: r.end_ip as Buffer,
    countryCode: r.country_code,
    countryName: r.country_name,
    region: r.region,
    city: r.city,
    postalCode: r.postal_code,
    latitude: r.latitude == null ? undefined : Number(r.latitude),
    longitude: r.longitude == null ? undefined : Number(r.longitude),
    timezone: r.timezone,
    isp: r.isp,
    asn: r.asn == null ? undefined : Number(r.asn),
    asnOrg: r.asn_org,
    countrySource: r.country_source as Source | undefined,
    citySource: r.city_source as Source | undefined,
    ispSource: r.isp_source as Source | undefined,
    asnSource: r.asn_source as Source | undefined,
    geoSource: r.geo_source as Source | undefined,
  };
}

export async function recordEtlStart(pool: mysql.Pool): Promise<number> {
  const [res] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO etl_runs (started_at, status) VALUES (NOW(3), 'running')`,
  );
  return res.insertId;
}

export async function recordEtlFinish(
  pool: mysql.Pool,
  id: number,
  status: "success" | "failed",
  fields: Partial<EtlRun>,
): Promise<void> {
  const set: string[] = ["finished_at = NOW(3)", "status = ?"];
  const values: unknown[] = [status];
  if (fields.maxmindRecords !== undefined) {
    set.push("maxmind_records = ?");
    values.push(fields.maxmindRecords);
  }
  if (fields.ip2regionRecords !== undefined) {
    set.push("ip2region_records = ?");
    values.push(fields.ip2regionRecords);
  }
  if (fields.dbipRecords !== undefined) {
    set.push("dbip_records = ?");
    values.push(fields.dbipRecords);
  }
  if (fields.mergedRecords !== undefined) {
    set.push("merged_records = ?");
    values.push(fields.mergedRecords);
  }
  if (fields.errorMessage !== undefined) {
    set.push("error_message = ?");
    values.push(fields.errorMessage);
  }
  if (fields.maxmindBuiltAt !== undefined) {
    set.push("maxmind_built_at = ?");
    values.push(fields.maxmindBuiltAt);
  }
  if (fields.ip2regionBuiltAt !== undefined) {
    set.push("ip2region_built_at = ?");
    values.push(fields.ip2regionBuiltAt);
  }
  if (fields.dbipBuiltAt !== undefined) {
    set.push("dbip_built_at = ?");
    values.push(fields.dbipBuiltAt);
  }
  // Mirror final progress counters onto the run row so the run-detail
  // page renders a clean post-mortem bar without polling per-file stages.
  if (fields.downloadBytesDone !== undefined) {
    set.push("download_bytes_done = ?");
    values.push(fields.downloadBytesDone);
  }
  if (fields.downloadBytesTotal !== undefined) {
    set.push("download_bytes_total = ?");
    values.push(fields.downloadBytesTotal);
  }
  if (fields.insertRowsDone !== undefined) {
    set.push("insert_rows_done = ?");
    values.push(fields.insertRowsDone);
  }
  if (fields.insertRowsTotal !== undefined) {
    set.push("insert_rows_total = ?");
    values.push(fields.insertRowsTotal);
  }
  if (fields.currentStage !== undefined) {
    set.push("current_stage = ?");
    values.push(fields.currentStage);
  }
  values.push(id);
  await pool.query(`UPDATE etl_runs SET ${set.join(", ")} WHERE id = ?`, values);
}

/** Live-progress columns to refresh while the run is in flight. Called
 *  by the pipeline's progress sink — throttled to ≤1 UPDATE/sec to keep
 *  the poll endpoint cheap and to avoid hammering the DB during the
 *  1000-row INSERT batches. Unknown-total values (null) are stored as
 *  NULL so the UI can render an indeterminate bar. */
export async function updateEtlRunProgress(
  pool: mysql.Pool,
  id: number,
  fields: {
    downloadBytesDone?: number;
    downloadBytesTotal?: number | null;
    insertRowsDone?: number;
    insertRowsTotal?: number | null;
    currentStage?: EtlRun["currentStage"];
  },
): Promise<void> {
  const set: string[] = ["progress_updated_at = NOW(3)"];
  const values: unknown[] = [];
  if (fields.downloadBytesDone !== undefined) {
    set.push("download_bytes_done = ?");
    values.push(fields.downloadBytesDone);
  }
  if (fields.downloadBytesTotal !== undefined) {
    set.push("download_bytes_total = ?");
    values.push(fields.downloadBytesTotal);
  }
  if (fields.insertRowsDone !== undefined) {
    set.push("insert_rows_done = ?");
    values.push(fields.insertRowsDone);
  }
  if (fields.insertRowsTotal !== undefined) {
    set.push("insert_rows_total = ?");
    values.push(fields.insertRowsTotal);
  }
  if (fields.currentStage !== undefined) {
    set.push("current_stage = ?");
    values.push(fields.currentStage);
  }
  values.push(id);
  await pool.query(`UPDATE etl_runs SET ${set.join(", ")} WHERE id = ?`, values);
}

/** Cheap poll target — reads ONLY the progress columns (no JOINs, no
 *  per-stage rows). The admin UI calls this every 5s while the run is
 *  running. Once the run finishes the page stops polling and switches
 *  to the regular detail view. */
export async function getEtlRunProgress(
  pool: mysql.Pool,
  id: number,
): Promise<{
  status: "running" | "success" | "failed";
  currentStage: EtlRun["currentStage"] | null;
  downloadBytesDone: number;
  downloadBytesTotal: number;
  insertRowsDone: number;
  insertRowsTotal: number;
  progressUpdatedAt: Date | null;
  errorMessage: string | null;
} | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT status, current_stage, download_bytes_done, download_bytes_total,
            insert_rows_done, insert_rows_total, progress_updated_at, error_message
       FROM etl_runs WHERE id = ?`,
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    status: r.status,
    currentStage: r.current_stage ?? null,
    downloadBytesDone: Number(r.download_bytes_done ?? 0),
    downloadBytesTotal: Number(r.download_bytes_total ?? 0),
    insertRowsDone: Number(r.insert_rows_done ?? 0),
    insertRowsTotal: Number(r.insert_rows_total ?? 0),
    progressUpdatedAt: r.progress_updated_at ?? null,
    errorMessage: r.error_message ?? null,
  };
}

export async function lastEtlRun(pool: mysql.Pool): Promise<EtlRun | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT * FROM etl_runs ORDER BY id DESC LIMIT 1`);
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return etlRunFromRow(r);
}

export async function recentEtlRuns(pool: mysql.Pool, limit: number): Promise<EtlRun[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT * FROM etl_runs ORDER BY id DESC LIMIT ?`, [
    limit,
  ]);
  return rows.map((r) => etlRunFromRow(r));
}

function etlRunFromRow(r: mysql.RowDataPacket): EtlRun {
  return {
    id: Number(r.id),
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    maxmindRecords: r.maxmind_records,
    ip2regionRecords: r.ip2region_records,
    dbipRecords: r.dbip_records,
    mergedRecords: r.merged_records,
    errorMessage: r.error_message,
    maxmindBuiltAt: r.maxmind_built_at,
    ip2regionBuiltAt: r.ip2region_built_at,
    dbipBuiltAt: r.dbip_built_at,
    downloadBytesDone: r.download_bytes_done != null ? Number(r.download_bytes_done) : undefined,
    downloadBytesTotal: r.download_bytes_total != null ? Number(r.download_bytes_total) : undefined,
    insertRowsDone: r.insert_rows_done != null ? Number(r.insert_rows_done) : undefined,
    insertRowsTotal: r.insert_rows_total != null ? Number(r.insert_rows_total) : undefined,
    currentStage: r.current_stage ?? undefined,
    progressUpdatedAt: r.progress_updated_at ?? undefined,
  };
}

export async function lastSuccessfulEtl(pool: mysql.Pool): Promise<Date | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT finished_at FROM etl_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1`,
  );
  if (rows.length === 0 || !rows[0]?.finished_at) return null;
  return rows[0].finished_at as Date;
}

// ─── etl_run_* stage-row helpers ──────────────────────────────────────
// Persisted by the pipeline rewrite in Task 1.5. Read by the run-detail
// page in PR 2. Snake-case column mapping is consistent with the rest
// of this file; RowDataPacket coercion uses explicit String/Number/Date.

export type EtlRunDownloadSource = "dbip-city" | "dbip-country" | "dbip-asn";
export type EtlRunDownloadStatus = "success" | "failed" | "missing" | "skipped";

export interface EtlRunDownloadRow {
  runId: number;
  source: EtlRunDownloadSource;
  destName: string;
  sourceUrl: string | null;
  month: string | null;
  status: EtlRunDownloadStatus;
  bytes: number | null;
  durationMs: number | null;
  retryCount: number;
  errorMessage: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

function etlRunDownloadFromRow(r: mysql.RowDataPacket): EtlRunDownloadRow {
  return {
    runId: Number(r.run_id),
    source: String(r.source) as EtlRunDownloadSource,
    destName: String(r.dest_name),
    sourceUrl: r.source_url == null ? null : String(r.source_url),
    month: r.month == null ? null : String(r.month),
    status: String(r.status) as EtlRunDownloadStatus,
    bytes: r.bytes == null ? null : Number(r.bytes),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    retryCount: Number(r.retry_count),
    errorMessage: r.error_message == null ? null : String(r.error_message),
    startedAt: new Date(r.started_at),
    finishedAt: r.finished_at == null ? null : new Date(r.finished_at),
  };
}

export async function insertEtlRunDownload(pool: mysql.Pool, row: EtlRunDownloadRow): Promise<void> {
  await pool.query(
    `INSERT INTO etl_run_downloads
       (run_id, source, dest_name, source_url, month, status, bytes,
        duration_ms, retry_count, error_message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.runId,
      row.source,
      row.destName,
      row.sourceUrl,
      row.month,
      row.status,
      row.bytes,
      row.durationMs,
      row.retryCount,
      row.errorMessage ? row.errorMessage.slice(0, 512) : null,
      row.startedAt,
      row.finishedAt,
    ],
  );
}

export async function listEtlRunDownloads(pool: mysql.Pool, runId: number): Promise<EtlRunDownloadRow[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT run_id, source, dest_name, source_url, month, status, bytes,
            duration_ms, retry_count, error_message, started_at, finished_at
       FROM etl_run_downloads
      WHERE run_id = ?
      ORDER BY id ASC`,
    [runId],
  );
  return rows.map(etlRunDownloadFromRow);
}

export interface EtlRunParseRow {
  runId: number;
  source: EtlRunDownloadSource;
  destName: string;
  rowsEmitted: number;
  rowsSkippedShort: number;
  rowsSkippedHeader: number;
  rowsSkippedUnparseableIp: number;
  rowsSkippedMissingCol: number;
  rowsSkippedNanAsn: number;
  rowsSkippedOther: number;
  gunzipErrors: number;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
}

function etlRunParseFromRow(r: mysql.RowDataPacket): EtlRunParseRow {
  return {
    runId: Number(r.run_id),
    source: String(r.source) as EtlRunDownloadSource,
    destName: String(r.dest_name),
    rowsEmitted: Number(r.rows_emitted),
    rowsSkippedShort: Number(r.rows_skipped_short),
    rowsSkippedHeader: Number(r.rows_skipped_header),
    rowsSkippedUnparseableIp: Number(r.rows_skipped_unparseable_ip),
    rowsSkippedMissingCol: Number(r.rows_skipped_missing_col),
    rowsSkippedNanAsn: Number(r.rows_skipped_nan_asn),
    rowsSkippedOther: Number(r.rows_skipped_other),
    gunzipErrors: Number(r.gunzip_errors),
    startedAt: new Date(r.started_at),
    finishedAt: r.finished_at == null ? null : new Date(r.finished_at),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
  };
}

export async function insertEtlRunParse(pool: mysql.Pool, row: EtlRunParseRow): Promise<void> {
  await pool.query(
    `INSERT INTO etl_run_parses
       (run_id, source, dest_name, rows_emitted,
        rows_skipped_short, rows_skipped_header, rows_skipped_unparseable_ip,
        rows_skipped_missing_col, rows_skipped_nan_asn, rows_skipped_other,
        gunzip_errors, started_at, finished_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.runId,
      row.source,
      row.destName,
      row.rowsEmitted,
      row.rowsSkippedShort,
      row.rowsSkippedHeader,
      row.rowsSkippedUnparseableIp,
      row.rowsSkippedMissingCol,
      row.rowsSkippedNanAsn,
      row.rowsSkippedOther,
      row.gunzipErrors,
      row.startedAt,
      row.finishedAt,
      row.durationMs,
    ],
  );
}

export async function listEtlRunParses(pool: mysql.Pool, runId: number): Promise<EtlRunParseRow[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT run_id, source, dest_name, rows_emitted,
            rows_skipped_short, rows_skipped_header, rows_skipped_unparseable_ip,
            rows_skipped_missing_col, rows_skipped_nan_asn, rows_skipped_other,
            gunzip_errors, started_at, finished_at, duration_ms
       FROM etl_run_parses
      WHERE run_id = ?
      ORDER BY id ASC`,
    [runId],
  );
  return rows.map(etlRunParseFromRow);
}

export interface EtlRunInsertRow {
  runId: number;
  source: EtlRunDownloadSource;
  destName: string;
  rowsAttempted: number;
  rowsInserted: number;
  rowsDuplicates: number;
  batchCount: number;
  durationMs: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}

function etlRunInsertFromRow(r: mysql.RowDataPacket): EtlRunInsertRow {
  return {
    runId: Number(r.run_id),
    source: String(r.source) as EtlRunDownloadSource,
    destName: String(r.dest_name),
    rowsAttempted: Number(r.rows_attempted),
    rowsInserted: Number(r.rows_inserted),
    rowsDuplicates: Number(r.rows_duplicates),
    batchCount: Number(r.batch_count),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    startedAt: new Date(r.started_at),
    finishedAt: r.finished_at == null ? null : new Date(r.finished_at),
  };
}

export async function insertEtlRunInsert(pool: mysql.Pool, row: EtlRunInsertRow): Promise<void> {
  await pool.query(
    `INSERT INTO etl_run_inserts
       (run_id, source, dest_name, rows_attempted, rows_inserted,
        rows_duplicates, batch_count, duration_ms, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.runId,
      row.source,
      row.destName,
      row.rowsAttempted,
      row.rowsInserted,
      row.rowsDuplicates,
      row.batchCount,
      row.durationMs,
      row.startedAt,
      row.finishedAt,
    ],
  );
}

export async function listEtlRunInserts(pool: mysql.Pool, runId: number): Promise<EtlRunInsertRow[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT run_id, source, dest_name, rows_attempted, rows_inserted,
            rows_duplicates, batch_count, duration_ms, started_at, finished_at
       FROM etl_run_inserts
      WHERE run_id = ?
      ORDER BY id ASC`,
    [runId],
  );
  return rows.map(etlRunInsertFromRow);
}

export type EtlRunSwapStatus = "success" | "failed";

export interface EtlRunSwapRow {
  runId: number;
  status: EtlRunSwapStatus;
  durationMs: number | null;
  errorMessage: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

function etlRunSwapFromRow(r: mysql.RowDataPacket): EtlRunSwapRow {
  return {
    runId: Number(r.run_id),
    status: String(r.status) as EtlRunSwapStatus,
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    errorMessage: r.error_message == null ? null : String(r.error_message),
    startedAt: new Date(r.started_at),
    finishedAt: r.finished_at == null ? null : new Date(r.finished_at),
  };
}

export async function upsertEtlRunSwap(pool: mysql.Pool, row: EtlRunSwapRow): Promise<void> {
  await pool.query(
    `INSERT INTO etl_run_swaps
       (run_id, status, duration_ms, error_message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       duration_ms = VALUES(duration_ms),
       error_message = VALUES(error_message),
       started_at = VALUES(started_at),
       finished_at = VALUES(finished_at)`,
    [
      row.runId,
      row.status,
      row.durationMs,
      row.errorMessage ? row.errorMessage.slice(0, 512) : null,
      row.startedAt,
      row.finishedAt,
    ],
  );
}

export async function getEtlRunSwap(pool: mysql.Pool, runId: number): Promise<EtlRunSwapRow | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT run_id, status, duration_ms, error_message, started_at, finished_at
       FROM etl_run_swaps
      WHERE run_id = ?`,
    [runId],
  );
  if (rows.length === 0) return null;
  return etlRunSwapFromRow(rows[0]!);
}

export { runMigrations, getAppliedVersions, migrationStatus } from "./migrations/runner";
