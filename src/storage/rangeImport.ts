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
import { parseIp } from "../ip";
import { computeRangeSize } from "./mysql";
import type { RangeRecord } from "./rangeFile";

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
