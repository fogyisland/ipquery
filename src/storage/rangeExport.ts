// SPDX-License-Identifier: MIT
//
// Streaming .ipq export.
//
// A library-sized database holds around nine million ranges, which is close
// to two gigabytes of .ipq. Two consequences shape this file:
//
//   · The rows are read with a streaming query, not `SELECT *`. Buffering
//     the result set would need more memory than the process is allowed.
//   · The file is written to disk and downloaded afterwards, not piped into
//     the HTTP response. A download that a browser, a proxy or a flaky
//     connection can cut off is a download that fails after ten minutes of
//     work, and the operator has no way to tell a truncated file from a
//     complete one.
//
// The header goes out first with the row count already known, so a file
// that stops mid-way is detectably short rather than silently partial.
import type { Pool } from "mysql2/promise";
import * as fs from "node:fs";
import { bufferToString } from "../ip";
import { encodeHeader, encodeRange, type RangeRecord, type RangeRow } from "./rangeFile";

/** What the exporter reads out of ip_ranges, in one statement. */
const SELECT_COLUMNS = [
  "start_ip",
  "end_ip",
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
] as const;

export interface ExportFilter {
  /** Restrict to one ISO country code. */
  readonly countryCode?: string;
  /** Called with the running total as rows are written, so the console can
   *  show a bar instead of a spinner. */
  readonly onProgress?: (written: number, total: number) => void;
}

export interface ExportResult {
  readonly rows: number;
  readonly bytes: number;
  readonly path: string;
}

/**
 * Write every matching range to `filePath` as an .ipq file.
 *
 * The file is written to a temporary name and renamed on completion, so a
 * failed export never leaves a half-written file that looks downloadable.
 */
export async function exportRangesToFile(
  pool: Pool,
  filePath: string,
  filter: ExportFilter = {},
): Promise<ExportResult> {
  const total = await countMatching(pool, filter);
  const partial = `${filePath}.partial`;
  const handle = await fs.promises.open(partial, "w");
  let written = 0;
  try {
    await handle.writeFile(`${encodeHeader({ exportedAt: new Date().toISOString(), rows: total })}\n`);

    // Batched keyset paging on the primary key rather than LIMIT/OFFSET:
    // OFFSET re-reads every skipped row, and on a nine-million-row table
    // the second half of an export is unusably slow.
    let lastId = 0;
    for (;;) {
      const rows = await readBatch(pool, lastId, filter);
      if (rows.length === 0) break;
      let chunk = "";
      for (const row of rows) {
        chunk += `${encodeRange(row.record)}\n`;
        written += 1;
      }
      await handle.writeFile(chunk);
      lastId = rows[rows.length - 1]!.id;
      filter.onProgress?.(written, total);
      if (rows.length < BATCH_ROWS) break;
    }

    const { size } = await handle.stat();
    await handle.close();
    await fs.promises.rename(partial, filePath);
    return { rows: written, bytes: size, path: filePath };
  } catch (err) {
    // An unfinished file must not be left behind under the real name, or
    // the next download serves a truncated export as if it were whole.
    await handle.close().catch(() => undefined);
    await fs.promises.rm(partial, { force: true }).catch(() => undefined);
    throw err;
  }
}

const BATCH_ROWS = 2000;

interface ReadRow {
  readonly id: number;
  readonly record: RangeRow;
}

async function countMatching(pool: Pool, filter: ExportFilter): Promise<number> {
  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM ip_ranges${whereClause(filter)}`,
    filter.countryCode ? [filter.countryCode] : [],
  );
  return Number(rows[0]?.n ?? 0);
}

async function readBatch(pool: Pool, lastId: number, filter: ExportFilter): Promise<ReadRow[]> {
  const params: unknown[] = [lastId];
  if (filter.countryCode) params.push(filter.countryCode);
  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT id, ${SELECT_COLUMNS.join(",")} FROM ip_ranges
      WHERE id > ?${filter.countryCode ? " AND country_code = ?" : ""}
      ORDER BY id ASC
      LIMIT ${BATCH_ROWS}`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    record: toRecord(r as unknown as RawRangeRow),
  }));
}

function whereClause(filter: ExportFilter): string {
  return filter.countryCode ? " WHERE country_code = ?" : "";
}

interface RawRangeRow {
  start_ip: Buffer;
  end_ip: Buffer;
  country_code: string | null;
  country_name: string | null;
  region: string | null;
  city: string | null;
  postal_code: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  timezone: string | null;
  isp: string | null;
  asn: number | null;
  asn_org: string | null;
}

function toRecord(row: RawRangeRow): RangeRecord {
  return {
    line: 0,
    start: bufferToString(row.start_ip),
    end: bufferToString(row.end_ip),
    countryCode: row.country_code ?? null,
    countryName: row.country_name ?? null,
    region: row.region ?? null,
    city: row.city ?? null,
    postalCode: row.postal_code ?? null,
    // DECIMAL comes back as a string from mysql2 to avoid precision loss.
    latitude: row.latitude === null ? null : Number(row.latitude),
    longitude: row.longitude === null ? null : Number(row.longitude),
    timezone: row.timezone ?? null,
    isp: row.isp ?? null,
    asn: row.asn === null ? null : Number(row.asn),
    asnOrg: row.asn_org ?? null,
  };
}
