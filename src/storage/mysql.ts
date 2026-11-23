// SPDX-License-Identifier: MIT
import * as mysql from "mysql2/promise";
import type { AppConfig } from "../config";
import type { IpRangeRow, EtlRun, Source } from "../types";
import { compareBuffers } from "../ip";

/**
 * How long a statement may wait for a METADATA lock, in seconds.
 *
 * MySQL's `lock_wait_timeout` governs metadata locks — the locks
 * `RENAME TABLE` and `LOCK TABLES` take on a table's NAME. It is a
 * different thing from `innodb_lock_wait_timeout`, which governs row
 * locks. The server default is 31,536,000 seconds: a year.
 *
 * A year is a catastrophic default here, because of how metadata locks
 * queue. A SHARED lock does not block another SHARED lock, so a
 * long-running read is not by itself fatal. What is fatal is a PENDING
 * EXCLUSIVE request — the ETL's `RENAME TABLE` swap. Once one is
 * pending, every later request queues behind it, including plain reads
 * that would have been compatible with the reader already running. That
 * is what turned one stuck ETL run into a whole-site outage on
 * 2026-11-23: 47 requests queued behind a rename that was itself
 * waiting for a 42-hour-old diagnostic query to finish.
 *
 * Setting a short timeout on every pooled connection bounds the damage
 * in both directions:
 *
 *   - A read that cannot take the lock fails in seconds and reports
 *     that it was a metadata lock, so the operator knows to look for
 *     the holder rather than at row-level contention.
 *   - The swap gives up instead of sitting in the queue for a year.
 *
 * Ten seconds is long enough that an ordinary lock wait — an ETL
 * transaction committing, a backup snapshot starting — still succeeds.
 * It is short enough that a request never holds a pool connection and
 * a browser tab open for longer than a coffee break.
 */
export const METADATA_LOCK_WAIT_SECONDS = 10;

/**
 * The statement that arms the timeout on a fresh connection.
 *
 * `SET SESSION` scopes the value to the connection it runs on, which is
 * exactly the scope we want: mysql2 pools connections, and a pooled
 * connection can be handed to any later query.
 */
const SET_METADATA_LOCK_TIMEOUT = `SET SESSION lock_wait_timeout = ${METADATA_LOCK_WAIT_SECONDS}`;

export function createPool(cfg: AppConfig): mysql.Pool {
  return createPoolFor({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
    poolSize: cfg.db.poolSize,
  });
}

/**
 * The five connection values plus the pool size, without the whole
 * AppConfig.
 *
 * `createPool` only ever reads `cfg.db`, so this is the honest shape of
 * its input. It exists so the setup wizard can build a candidate pool
 * for a configuration that is not `cfg` yet — without fabricating a
 * whole AppConfig object to satisfy the signature.
 */
export interface PoolConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  poolSize: number;
  /**
   * Connect timeout in milliseconds.
   *
   * Optional: the normal pool leaves it at the driver's default, because
   * the long default is right for a server that should wait for a slow
   * database. The probes that run on the path to serving the wizard
   * override it with something short — an operator waiting on /init should
   * not sit through a 30-second TCP timeout.
   */
  connectTimeout?: number;
}

export function createPoolFor(conn: PoolConnection): mysql.Pool {
  const pool = mysql.createPool({
    host: conn.host,
    port: conn.port,
    user: conn.user,
    password: conn.password,
    database: conn.database,
    connectionLimit: conn.poolSize,
    waitForConnections: true,
    multipleStatements: true,
    // Read and write DATETIME in the SERVER's own clock.
    //
    // `timezone` is a client-side setting and nothing else: it tells the
    // driver how to interpret the wall-clock literals MySQL sends back,
    // and how to render a Date parameter on the way out. It does NOT
    // tell the server which zone to use — that is `SET time_zone`, and
    // mysql2 never issues it. So the server stamps `CURRENT_TIMESTAMP`
    // and `NOW()` in its own zone (SYSTEM), and a reader that assumes
    // UTC reads every one of them shifted by the server's offset from
    // UTC: on a +08:00 host a row created a moment ago comes back eight
    // hours in the future, and the console says so.
    //
    // "local" makes the driver interpret the literal the way the server
    // wrote it. The server's SYSTEM zone is this host's zone and the
    // process runs on the same host, so the two agree.
    timezone: "local",
    dateStrings: false,
    ...(conn.connectTimeout === undefined ? {} : { connectTimeout: conn.connectTimeout }),
  });

  // Arm the metadata-lock timeout on every connection the pool opens.
  //
  // The hook fires once per physical connection, before the pool hands
  // it out. That matters: mysql2 pools connections, so a setting applied
  // to one query's connection would not travel with the connection to
  // the next query. Setting it here means EVERY statement the pool
  // runs — including the reads — is bounded.
  //
  // A failure to set the variable is fatal to the pool's safety, so it
  // is logged loudly rather than swallowed. The connection stays in the
  // pool: the variable is a session default that the server has already
  // had for a lifetime, and a server that rejects `SET SESSION
  // lock_wait_timeout` is not one where a year-long default would be
  // acceptable either.
  pool.on("connection", (rawConnection) => {
    // The `connection` event carries the CORE connection — the callback
    // style one — not the promise wrapper. mysql2's promise pool
    // forwards the event unchanged, so the runtime object and the
    // promise-pool type do not agree; the cast states which one this
    // is.
    const core = rawConnection as unknown as {
      query: (sql: string, cb: (err: unknown) => void) => void;
    };
    core.query(SET_METADATA_LOCK_TIMEOUT, (err: unknown) => {
      if (err) {
        console.warn(
          `[mysql] could not set lock_wait_timeout=${METADATA_LOCK_WAIT_SECONDS} on a pooled connection: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    });
  });

  return pool;
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

/** The size of a range, in addresses. Exported because the .ipq importer has
 *  to compute the same value the ETL does — a file cannot be trusted to
 *  supply a column the lookup sorts by. */
export function computeRangeSize(startIp: Buffer, endIp: Buffer): bigint {
  return rangeSize(startIp, endIp);
}

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

/** Rows whose origin is NOT one of the ETL's own source tags.
 *
 *  The ETL rebuilds ip_ranges from scratch: it truncates ip_ranges_new,
 *  streams the DB-IP files into it, and renames it over ip_ranges. That
 *  is the correct behaviour for the DB-IP data itself — DB-IP re-issues
 *  whole files monthly, so a full refresh is the only way to learn that
 *  a /24 was split into two /25s.
 *
 *  But it also destroys rows the ETL knows nothing about. The
 *  unknown-IP backfill writes /32 rows tagged 'multi-provider' straight
 *  into ip_ranges (see src/etl/unknownIpBackfill.ts). Those rows are
 *  the result of real lookups against external providers; the DB-IP
 *  files will never contain them, so the next ETL run silently
 *  deleted every one of them. An operator who ran the backfill, saw it
 *  work, and then refreshed the library lost the work without any
 *  error — the ETL reported success.
 *
 *  So before the swap, hand-authored rows are copied across. The ETL's
 *  own rows are not: they are the ones the refresh is meant to replace.
 */
/**
 * Source tags whose rows the ETL treats as operator-owned and carries across
 * a full refresh.
 *
 * `multi-provider` is written by the unknown-IP backfill. `import` is
 * written by the .ipq import (/admin/ranges). Both are rows the ETL did not
 * produce, and a rebuild that dropped them would silently undo the
 * operator's work — which is exactly what an untagged import would do.
 */
export const MANUAL_SOURCE_TAGS = ["multi-provider", "import"] as const;

/**
 * The source labels the ETL pipeline writes.
 *
 * Derived from the pipeline's own file table would be ideal, but
 * pipeline.ts imports this module, so the list is written down here and
 * `test/unit/source-normalize.test.ts` keeps the two in step.
 *
 * The manual tags are in the list because they are real provenance:
 * the backfill writes 'multi-provider' and the range importer writes
 * 'import', and the ETL's swap preserves exactly those rows. Dropping
 * them here would erase the record of who wrote a row — and the swap
 * would then have nothing to key on.
 *
 * 'seed' is here for the same reason but is NOT in
 * MANUAL_SOURCE_TAGS: the demo loader writes it, and findRange()
 * demotes a seed row below any real ETL row. It is a real tag on a
 * real row, so normalizing it away would be wrong — but the ETL is
 * meant to replace those rows, so they are not carried across a
 * refresh the way the other two are.
 */
const KNOWN_SOURCES: ReadonlySet<string> = new Set([
  "unknown",
  "dbip",
  "dbip-country",
  "dbip-asn",
  "metowolf-cn",
  "runishiwo-cn",
  "sapics-user",
  "seed",
  ...MANUAL_SOURCE_TAGS,
]);

/**
 * Normalize a source value read out of the database.
 *
 * The source columns on `ip_ranges` are free-form text, and they
 * predate the source tracking: a row inserted by hand, by an older
 * build, or by a backfill carries whatever was there. Two of those
 * values are "maxmind" and "ipinfo" — labels of sources this project
 * never wired into the pipeline.
 *
 * Casting such a value to the `Source` type and returning it would
 * make the API claim the data came from MaxMind for a row MaxMind
 * never touched. An unrecognized label is normalized to "unknown",
 * which is what it actually is.
 */
export function normalizeSource(value: unknown): Source {
  if (typeof value !== "string") return "unknown";
  return KNOWN_SOURCES.has(value) ? (value as Source) : "unknown";
}

export interface PreservedRows {
  /** Rows copied out of the live table into the staging table. */
  preserved: number;
  /** Rows skipped because the staging table already had that range. */
  conflicts: number;
}

/** Copies hand-authored rows from the live ip_ranges into the staging
 *  ip_ranges_new, so that the upcoming swap does not drop them.
 *
 *  Must be called AFTER the staging table has been filled with the
 *  freshly parsed ETL rows and BEFORE the RENAME — otherwise the
 *  preserved rows would be copied into a table that is about to be
 *  replaced anyway.
 *
 *  A row is copied when its country_source is a manual tag. Rows whose
 *  (start_ip, end_ip) already exist in the staging table are skipped:
 *  the ETL's row wins, because it is the more complete one (a real
 *  DB-IP segment carries city, ISP and coordinates where a backfill
 *  row carries a country code). The count of skipped rows is returned
 *  so the pipeline can report it rather than silently losing them.
 */
export async function preserveManualRows(pool: mysql.Pool): Promise<PreservedRows> {
  const tagPlaceholders = MANUAL_SOURCE_TAGS.map(() => "?").join(",");
  // The column list is explicit rather than SELECT * so that a schema
  // change on ip_ranges (a new column) cannot make this insert fail
  // with "column count doesn't match". The two tables are kept in sync
  // by the migrations, but the copy should not be the thing that breaks
  // when they drift.
  const columns = [
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
  ];
  const columnList = columns.join(",");

  // LEFT JOIN against the staging table to find the manual rows the
  // refresh does not already cover. NOT EXISTS would be equivalent
  // here, but the LEFT JOIN lets one statement both filter and count
  // the conflicts, avoiding a second full pass over the manual rows.
  //
  // Every selected column is qualified with the table alias. An
  // unqualified `start_ip` would be ambiguous — both tables have one —
  // and relying on MySQL's resolution of that would make the statement
  // break the moment the query's shape changed.
  const selectList = columns.map((c) => `old.${c}`).join(",");

  // Count the manual rows the staging table already covers BEFORE the
  // insert. After the insert every one of them would be present, and
  // the "still missing" predicate would match nothing — so counting
  // afterwards would report zero conflicts no matter how many rows
  // were actually skipped.
  const [countRows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS n
       FROM ip_ranges old
       JOIN ip_ranges_new fresh
              ON fresh.start_ip = old.start_ip AND fresh.end_ip = old.end_ip
      WHERE old.country_source IN (${tagPlaceholders})`,
    [...MANUAL_SOURCE_TAGS],
  );
  const conflicts = Number(countRows[0]?.n ?? 0);

  // Copy the manual rows the staging table does not have yet. The
  // LEFT JOIN's IS NULL filter does that in one pass; NOT EXISTS would
  // be equivalent.
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT IGNORE INTO ip_ranges_new (${columnList})
     SELECT ${selectList}
       FROM ip_ranges old
       LEFT JOIN ip_ranges_new fresh
              ON fresh.start_ip = old.start_ip AND fresh.end_ip = old.end_ip
      WHERE old.country_source IN (${tagPlaceholders})
        AND fresh.id IS NULL`,
    [...MANUAL_SOURCE_TAGS],
  );
  // affectedRows counts only rows actually inserted; INSERT IGNORE
  // reports 0 for the ones it skipped on a duplicate key.
  const preserved = Number(result.affectedRows);
  return { preserved, conflicts };
}

/**
 * How long the swap waits for the metadata lock it needs, in seconds.
 *
 * `RENAME TABLE` needs an EXCLUSIVE metadata lock (MDL) on every table
 * it touches. MySQL's `lock_wait_timeout` — the timeout that applies to
 * METADATA locks, as opposed to `innodb_lock_wait_timeout` for row
 * locks — defaults to **31,536,000 seconds. That is a year.** A rename
 * that collides with a long-running reader therefore waits for a year
 * instead of failing.
 *
 * The failure mode is not a clean error, it is a wedge:
 *
 *   - The ETL's `etl_runs` row stays at `status='running'` with
 *     `current_stage='swap'`, forever.
 *   - `findRunningEtlRun()` then refuses every subsequent ETL run —
 *     the admin cannot re-run it without hand-editing the database.
 *   - Every reader of `ip_ranges` queues behind the pending rename's
 *     MDL, so `/lookup`, `/dashboard` and the landing page all hang.
 *
 * This happened for real on 2026-11-23: ETL run #6 sat in the swap
 * stage for 5.8 hours while an unrelated ad-hoc diagnostic query held
 * a read on the table, and the whole site was down with it.
 *
 * Thirty seconds is the bound. The rename itself is a metadata-only
 * operation — on this box it takes well under a second once the lock
 * is free — so thirty seconds is several orders of magnitude more than
 * the rename needs, and still short enough that a failed swap is a
 * failed RUN (which the pipeline records, and the operator can retry)
 * rather than a hung server. The session timeout is set on the swap's
 * own connection, so the pool's other connections keep MySQL's default.
 */
const SWAP_LOCK_WAIT_SECONDS = 30;

export async function atomicSwapRanges(pool: mysql.Pool): Promise<SwapResult> {
  const conn = await pool.getConnection();
  const t0 = Date.now();
  try {
    // Bound the metadata-lock wait BEFORE the rename. Without this the
    // rename waits for MySQL's year-long default and the whole run
    // hangs with the live table locked.
    await conn.query(`SET SESSION lock_wait_timeout = ${SWAP_LOCK_WAIT_SECONDS}`);
    await conn.beginTransaction();
    await conn.query(
      "RENAME TABLE ip_ranges TO ip_ranges_old, ip_ranges_new TO ip_ranges, ip_ranges_old TO ip_ranges_new",
    );
    await conn.commit();
    return { status: "success", durationMs: Date.now() - t0 };
  } catch (err) {
    // The rollback itself can fail if the connection is already broken;
    // the original error is the one worth reporting.
    try {
      await conn.rollback();
    } catch (rollbackErr) {
      console.warn(
        `[mysql] swap rollback failed: ${
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        }`,
      );
    }
    const msg = (err as Error).message;
    return { status: "failed", durationMs: Date.now() - t0, errorMessage: msg };
  } finally {
    conn.release();
  }
}

/**
 * Rewrite a MySQL metadata-lock timeout into something an operator can
 * act on.
 *
 * MySQL reports the condition as ER_LOCK_WAIT_TIMEOUT (1205), whose text
 * says "Lock wait timeout exceeded; try restarting transaction". For a
 * ROW lock that is close enough to the truth. For a METADATA lock it is
 * actively misleading: the transaction is not stuck on rows, it is
 * stuck behind a lock on a table's NAME, and "restarting the
 * transaction" will not help — something else has to release it.
 *
 * The distinction matters because the two have completely different
 * fixes. A row-lock timeout is contention and resolves itself. A
 * metadata-lock timeout means a `RENAME TABLE` (the ETL's swap) or a
 * `LOCK TABLES` is holding the table, and the operator has to find it
 * and let it go.
 *
 * Non-timeout errors are returned untouched: a typo in the SQL must not
 * be reported as a lock problem.
 */
export function describeStorageError(err: unknown): Error {
  const original = err instanceof Error ? err : new Error(String(err));
  const code = (original as { code?: unknown }).code;
  const errno = (original as { errno?: unknown }).errno;
  const isMetadataLockTimeout =
    code === "ER_LOCK_WAIT_TIMEOUT" || errno === 1205 || /lock wait timeout/i.test(original.message);

  if (!isMetadataLockTimeout) return original;

  // 503, not 500. The service is up; the dependency it needs is not
  // available right now. A client that sees 500 gives up (or pages
  // someone); a client that sees 503 retries. Getting this wrong turns
  // a ten-second dependency stall into an outage.
  const described = new Error(
    `metadata lock timeout after ${METADATA_LOCK_WAIT_SECONDS}s: the IP range table is held by ` +
      `another session (an ETL swap or a LOCK TABLES). The read was abandoned rather than ` +
      `waiting for the server's one-year default. Find the holder with ` +
      `scripts/dev/probe-lock-queue.ts and release it. Underlying error: ${original.message}`,
  );
  (described as Error & { statusCode?: number }).statusCode = 503;
  (described as Error & { code?: string }).code = "service_unavailable";
  return described;
}

/**
 * How long a read may wait for a metadata lock, when the caller needs
 * the answer to be quick.
 *
 * The pool's default (METADATA_LOCK_WAIT_SECONDS) is the right bound
 * for a query whose result IS the answer: /lookup cannot say anything
 * useful without the row, so it is worth waiting a few seconds.
 *
 * It is the wrong bound for a query whose result is decoration. The
 * dashboard's hero element shows the country of your most recent query;
 * when the IP table is locked that country is simply absent, and the
 * rest of the page is unaffected. Making the visitor stare at a
 * spinner for ten seconds to learn a country code they may not even
 * look at is a bad trade. Two seconds is long enough to cover an
 * ordinary lock (a committing transaction, a starting snapshot) and
 * short enough that the page still feels immediate.
 */
export const OPTIONAL_READ_LOCK_WAIT_SECONDS = 2;

/**
 * Run one query on a connection whose metadata-lock wait is exactly
 * `lockWaitSeconds`.
 *
 * `lock_wait_timeout` is a SESSION variable, so it cannot be changed
 * for a single statement on a pooled connection and changed back —
 * the connection goes back to the pool with whatever value it was left
 * holding. The only way to give one query a different bound is to give
 * it its own connection.
 *
 * The connection is returned to the pool afterwards. Its session
 * timeout is restored to the pool's default first, so the next
 * statement that borrows it inherits the standard bound rather than
 * this short one.
 */
async function queryWithLockWait(
  pool: mysql.Pool,
  sql: string,
  values: unknown[],
  lockWaitSeconds: number,
): Promise<mysql.RowDataPacket[]> {
  const conn = await pool.getConnection();
  try {
    await conn.query(`SET SESSION lock_wait_timeout = ${Math.max(1, Math.floor(lockWaitSeconds))}`);
    const [rows] = await conn.query<mysql.RowDataPacket[]>(sql, values);
    return rows;
  } finally {
    // Restore the pool's standard bound before handing the connection
    // back. If the connection dies here the pool discards it, which is
    // also fine — a discarded connection loses the session with it.
    await conn
      .query(`SET SESSION lock_wait_timeout = ${METADATA_LOCK_WAIT_SECONDS}`)
      .catch((err: unknown) => {
        console.warn(
          `[mysql] could not restore lock_wait_timeout on a pooled connection: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    conn.release();
  }
}

/**
 * Look up the range covering an IP.
 *
 * `options.metadataLockWaitSeconds` overrides how long the query may
 * wait for a metadata lock on `ip_ranges`. When it is set, the query
 * runs on a dedicated connection whose session timeout is armed for
 * exactly that long — because `lock_wait_timeout` is a session
 * variable, a pooled connection's value cannot be changed for one
 * query and changed back.
 */
export async function findRange(
  pool: mysql.Pool,
  ipBuf: Buffer,
  options?: { metadataLockWaitSeconds?: number },
): Promise<IpRangeRow | null> {
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
  const sql = `SELECT start_ip, end_ip, country_code, country_name, region, city, postal_code,
              latitude, longitude, timezone, isp, asn, asn_org,
              country_source, city_source, isp_source, asn_source, geo_source,
              CAST(range_size AS CHAR) AS range_size
         FROM ip_ranges USE INDEX (uniq_start_end)
         WHERE start_ip <= ?
         ORDER BY start_ip DESC
         LIMIT 100`;

  let rows: mysql.RowDataPacket[];
  try {
    if (options?.metadataLockWaitSeconds === undefined) {
      [rows] = await pool.query<mysql.RowDataPacket[]>(sql, [ipBuf]);
    } else {
      rows = await queryWithLockWait(
        pool,
        sql,
        [ipBuf],
        options.metadataLockWaitSeconds,
      );
    }
  } catch (err) {
    // A metadata-lock timeout here means the IP range table is held by
    // another session. Left as a raw ER_LOCK_WAIT_TIMEOUT it would read
    // as row contention and invite the wrong response; see
    // describeStorageError for why the two are different problems.
    throw describeStorageError(err);
  }
  // Filter to rows that actually cover the target, then pick the smallest
  // range_size among them.
  //
  // range_size is a BIGINT UNSIGNED. mysql2 returns BIGINTs as JavaScript
  // numbers, which silently lose precision above 2^53 — and the IPv6
  // catchall rows carry exactly 2^64-1, so BigInt(number) would come back
  // as 2^64 rather than 2^64-1. CAST(... AS CHAR) in the SELECT keeps the
  // exact decimal, and BigInt() parses it without loss.
  //
  // The seed rows are also demoted below the real ETL data. They exist
  // to answer /lookup before the first ETL run; once the real library is
  // loaded its rows carry finer fields (city, ISP, coordinates) and must
  // win. range_size alone cannot express that — a seed row is a single
  // address (range_size 0) and would beat every real range covering it.
  let best: { row: mysql.RowDataPacket; size: bigint; isSeed: boolean } | null = null;
  for (const r of rows) {
    const endIp = r.end_ip as Buffer;
    if (compareBuffers(endIp, ipBuf) < 0) continue;
    const size = BigInt(r.range_size as string);
    const isSeed = r.country_source === "seed";
    if (best === null) {
      best = { row: r, size, isSeed };
      continue;
    }
    // Real data beats seed data outright. Between two rows of the same
    // kind, the smaller range is the more precise one.
    if (isSeed !== best.isSeed) {
      if (isSeed) continue; // a seed row never displaces a real one
    } else if (size >= best.size) {
      continue;
    }
    best = { row: r, size, isSeed };
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
    countrySource: normalizeSource(r.country_source),
    citySource: normalizeSource(r.city_source),
    ispSource: normalizeSource(r.isp_source),
    asnSource: normalizeSource(r.asn_source),
    geoSource: normalizeSource(r.geo_source),
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

export type EtlRunDownloadSource =
  | "dbip-city"
  | "dbip-country"
  | "dbip-asn"
  | "metowolf-cn"
  | "runishiwo-cn"
  | "runishiwo-v6"
  | "sapics-user";
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

export interface EtlRunDedupeRow {
  runId: number;
  inputRows: number;
  contained: number;
  exactDuplicates: number;
  partialOverlaps: number;
  emitted: number;
  durationMs: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}

function etlRunDedupeFromRow(r: mysql.RowDataPacket): EtlRunDedupeRow {
  return {
    runId: Number(r.run_id),
    inputRows: Number(r.input_rows),
    contained: Number(r.contained),
    exactDuplicates: Number(r.exact_duplicates),
    partialOverlaps: Number(r.partial_overlaps),
    emitted: Number(r.emitted),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
    startedAt: new Date(r.started_at),
    finishedAt: r.finished_at == null ? null : new Date(r.finished_at),
  };
}

export async function insertEtlRunDedupe(pool: mysql.Pool, row: EtlRunDedupeRow): Promise<void> {
  await pool.query(
    `INSERT INTO etl_run_dedupe
       (run_id, input_rows, contained, exact_duplicates, partial_overlaps,
        emitted, duration_ms, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.runId,
      row.inputRows,
      row.contained,
      row.exactDuplicates,
      row.partialOverlaps,
      row.emitted,
      row.durationMs,
      row.startedAt,
      row.finishedAt,
    ],
  );
}

export async function getEtlRunDedupe(
  pool: mysql.Pool,
  runId: number,
): Promise<EtlRunDedupeRow | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT run_id, input_rows, contained, exact_duplicates, partial_overlaps,
            emitted, duration_ms, started_at, finished_at
       FROM etl_run_dedupe
      WHERE run_id = ?
      LIMIT 1`,
    [runId],
  );
  if (rows.length === 0) return null;
  return etlRunDedupeFromRow(rows[0]!);
}

export {
  runMigrations,
  getAppliedVersions,
  migrationStatus,
  getSchemaReport,
  getSchemaReportFrom,
  listMigrationEntries,
  buildSchemaReference,
  type MigrationEntry,
  type PendingMigration,
  type SchemaDrift,
  type SchemaReference,
  type SchemaReport,
} from "./migrations/runner";
