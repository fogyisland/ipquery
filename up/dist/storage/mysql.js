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
exports.migrationStatus = exports.getAppliedVersions = exports.runMigrations = exports.MANUAL_SOURCE_TAGS = void 0;
exports.createPool = createPool;
exports.createPoolFor = createPoolFor;
exports.truncateNew = truncateNew;
exports.insertIntoNew = insertIntoNew;
exports.insertIntoNewUpsert = insertIntoNewUpsert;
exports.preserveManualRows = preserveManualRows;
exports.atomicSwapRanges = atomicSwapRanges;
exports.findRange = findRange;
exports.recordEtlStart = recordEtlStart;
exports.recordEtlFinish = recordEtlFinish;
exports.updateEtlRunProgress = updateEtlRunProgress;
exports.getEtlRunProgress = getEtlRunProgress;
exports.lastEtlRun = lastEtlRun;
exports.recentEtlRuns = recentEtlRuns;
exports.lastSuccessfulEtl = lastSuccessfulEtl;
exports.insertEtlRunDownload = insertEtlRunDownload;
exports.listEtlRunDownloads = listEtlRunDownloads;
exports.insertEtlRunParse = insertEtlRunParse;
exports.listEtlRunParses = listEtlRunParses;
exports.insertEtlRunInsert = insertEtlRunInsert;
exports.listEtlRunInserts = listEtlRunInserts;
exports.upsertEtlRunSwap = upsertEtlRunSwap;
exports.getEtlRunSwap = getEtlRunSwap;
// SPDX-License-Identifier: MIT
const mysql = __importStar(require("mysql2/promise"));
const ip_1 = require("../ip");
function createPool(cfg) {
    return createPoolFor({
        host: cfg.db.host,
        port: cfg.db.port,
        user: cfg.db.user,
        password: cfg.db.password,
        database: cfg.db.database,
        poolSize: cfg.db.poolSize,
    });
}
function createPoolFor(conn) {
    return mysql.createPool({
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
        database: conn.database,
        connectionLimit: conn.poolSize,
        waitForConnections: true,
        multipleStatements: true,
        timezone: "Z",
        dateStrings: false,
        ...(conn.connectTimeout === undefined ? {} : { connectTimeout: conn.connectTimeout }),
    });
}
async function truncateNew(pool) {
    await pool.query("TRUNCATE TABLE ip_ranges_new");
}
// BIGINT UNSIGNED max (2^64 - 1). range_size can't store anything bigger;
// coarse IPv6 ranges (e.g. ::/3) easily exceed 2^64. Clamp so the column
// accepts every row, and `ORDER BY range_size ASC` still picks the most
// specific covering range — all over-2^64 rows collapse to MAX, but those
// are uniformly catchall /16-/3-style allocations where any one is fine.
const MAX_RANGE_SIZE = (1n << 64n) - 1n;
function rangeSize(startIp, endIp) {
    // BINARY(16) values are 16-byte big-endian unsigned integers. range_size
    // = end - start, used by findRange to pick the smallest covering range.
    // Subtract byte-by-byte with borrow to avoid losing precision on the
    // full IPv6 address space (2^128).
    const start = BigInt("0x" + startIp.toString("hex"));
    const end = BigInt("0x" + endIp.toString("hex"));
    if (end < start)
        return 0n;
    const diff = end - start;
    return diff > MAX_RANGE_SIZE ? MAX_RANGE_SIZE : diff;
}
async function insertIntoNew(pool, rows) {
    if (rows.length === 0)
        return;
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const slice = rows.slice(i, i + CHUNK);
        const values = [];
        const placeholders = slice
            .map((r) => {
            values.push(r.startIp, r.endIp, rangeSize(r.startIp, r.endIp).toString(), r.countryCode ?? null, r.countryName ?? null, r.region ?? null, r.city ?? null, r.postalCode ?? null, r.latitude ?? null, r.longitude ?? null, r.timezone ?? null, r.isp ?? null, r.asn ?? null, r.asnOrg ?? null, r.countrySource ?? null, r.citySource ?? null, r.ispSource ?? null, r.asnSource ?? null, r.geoSource ?? null);
            return "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
        })
            .join(",");
        await pool.query(`INSERT INTO ip_ranges_new (start_ip,end_ip,range_size,country_code,country_name,region,city,postal_code,latitude,longitude,timezone,isp,asn,asn_org,country_source,city_source,isp_source,asn_source,geo_source) VALUES ${placeholders}`, values);
    }
}
async function insertIntoNewUpsert(pool, rows, fillCols) {
    const totals = { attempted: 0, inserted: 0, duplicates: 0, batchCount: 0 };
    if (rows.length === 0)
        return totals;
    const CHUNK = 1000;
    totals.attempted = rows.length;
    const allCols = [
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
    const insertCols = [
        "startIp",
        "endIp",
        "rangeSize",
        ...allCols.filter((c) => c !== "startIp" && c !== "endIp" && fillCols.has(c)),
    ];
    const colSql = (c) => {
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
        const values = [];
        const placeholders = slice
            .map((r) => {
            for (const c of insertCols) {
                if (c === "startIp")
                    values.push(r.startIp);
                else if (c === "endIp")
                    values.push(r.endIp);
                else if (c === "rangeSize")
                    values.push(rangeSize(r.startIp, r.endIp).toString());
                else
                    values.push(r[c] ?? null);
            }
            return `(${insertCols.map(() => "?").join(",")})`;
        })
            .join(",");
        const [res] = await pool.query(`INSERT INTO ip_ranges_new (${insertCols.map(colSql).join(",")}) VALUES ${placeholders}` +
            ` ON DUPLICATE KEY UPDATE ${updateClauses}`, values);
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
exports.MANUAL_SOURCE_TAGS = ["multi-provider"];
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
async function preserveManualRows(pool) {
    const tagPlaceholders = exports.MANUAL_SOURCE_TAGS.map(() => "?").join(",");
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
    const [countRows] = await pool.query(`SELECT COUNT(*) AS n
       FROM ip_ranges old
       JOIN ip_ranges_new fresh
              ON fresh.start_ip = old.start_ip AND fresh.end_ip = old.end_ip
      WHERE old.country_source IN (${tagPlaceholders})`, [...exports.MANUAL_SOURCE_TAGS]);
    const conflicts = Number(countRows[0]?.n ?? 0);
    // Copy the manual rows the staging table does not have yet. The
    // LEFT JOIN's IS NULL filter does that in one pass; NOT EXISTS would
    // be equivalent.
    const [result] = await pool.query(`INSERT IGNORE INTO ip_ranges_new (${columnList})
     SELECT ${selectList}
       FROM ip_ranges old
       LEFT JOIN ip_ranges_new fresh
              ON fresh.start_ip = old.start_ip AND fresh.end_ip = old.end_ip
      WHERE old.country_source IN (${tagPlaceholders})
        AND fresh.id IS NULL`, [...exports.MANUAL_SOURCE_TAGS]);
    // affectedRows counts only rows actually inserted; INSERT IGNORE
    // reports 0 for the ones it skipped on a duplicate key.
    const preserved = Number(result.affectedRows);
    return { preserved, conflicts };
}
async function atomicSwapRanges(pool) {
    const conn = await pool.getConnection();
    const t0 = Date.now();
    try {
        await conn.beginTransaction();
        await conn.query("RENAME TABLE ip_ranges TO ip_ranges_old, ip_ranges_new TO ip_ranges, ip_ranges_old TO ip_ranges_new");
        await conn.commit();
        return { status: "success", durationMs: Date.now() - t0 };
    }
    catch (err) {
        await conn.rollback();
        const msg = err.message;
        return { status: "failed", durationMs: Date.now() - t0, errorMessage: msg };
    }
    finally {
        conn.release();
    }
}
async function findRange(pool, ipBuf) {
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
    const [rows] = await pool.query(`SELECT start_ip, end_ip, country_code, country_name, region, city, postal_code,
            latitude, longitude, timezone, isp, asn, asn_org,
            country_source, city_source, isp_source, asn_source, geo_source,
            CAST(range_size AS CHAR) AS range_size
       FROM ip_ranges USE INDEX (uniq_start_end)
       WHERE start_ip <= ?
       ORDER BY start_ip DESC
       LIMIT 100`, [ipBuf]);
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
    let best = null;
    for (const r of rows) {
        const endIp = r.end_ip;
        if ((0, ip_1.compareBuffers)(endIp, ipBuf) < 0)
            continue;
        const size = BigInt(r.range_size);
        const isSeed = r.country_source === "seed";
        if (best === null) {
            best = { row: r, size, isSeed };
            continue;
        }
        // Real data beats seed data outright. Between two rows of the same
        // kind, the smaller range is the more precise one.
        if (isSeed !== best.isSeed) {
            if (isSeed)
                continue; // a seed row never displaces a real one
        }
        else if (size >= best.size) {
            continue;
        }
        best = { row: r, size, isSeed };
    }
    if (best === null)
        return null;
    const r = best.row;
    return {
        startIp: r.start_ip,
        endIp: r.end_ip,
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
        countrySource: r.country_source,
        citySource: r.city_source,
        ispSource: r.isp_source,
        asnSource: r.asn_source,
        geoSource: r.geo_source,
    };
}
async function recordEtlStart(pool) {
    const [res] = await pool.query(`INSERT INTO etl_runs (started_at, status) VALUES (NOW(3), 'running')`);
    return res.insertId;
}
async function recordEtlFinish(pool, id, status, fields) {
    const set = ["finished_at = NOW(3)", "status = ?"];
    const values = [status];
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
async function updateEtlRunProgress(pool, id, fields) {
    const set = ["progress_updated_at = NOW(3)"];
    const values = [];
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
async function getEtlRunProgress(pool, id) {
    const [rows] = await pool.query(`SELECT status, current_stage, download_bytes_done, download_bytes_total,
            insert_rows_done, insert_rows_total, progress_updated_at, error_message
       FROM etl_runs WHERE id = ?`, [id]);
    if (rows.length === 0)
        return null;
    const r = rows[0];
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
async function lastEtlRun(pool) {
    const [rows] = await pool.query(`SELECT * FROM etl_runs ORDER BY id DESC LIMIT 1`);
    if (rows.length === 0)
        return null;
    const r = rows[0];
    return etlRunFromRow(r);
}
async function recentEtlRuns(pool, limit) {
    const [rows] = await pool.query(`SELECT * FROM etl_runs ORDER BY id DESC LIMIT ?`, [
        limit,
    ]);
    return rows.map((r) => etlRunFromRow(r));
}
function etlRunFromRow(r) {
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
async function lastSuccessfulEtl(pool) {
    const [rows] = await pool.query(`SELECT finished_at FROM etl_runs WHERE status = 'success' ORDER BY id DESC LIMIT 1`);
    if (rows.length === 0 || !rows[0]?.finished_at)
        return null;
    return rows[0].finished_at;
}
function etlRunDownloadFromRow(r) {
    return {
        runId: Number(r.run_id),
        source: String(r.source),
        destName: String(r.dest_name),
        sourceUrl: r.source_url == null ? null : String(r.source_url),
        month: r.month == null ? null : String(r.month),
        status: String(r.status),
        bytes: r.bytes == null ? null : Number(r.bytes),
        durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
        retryCount: Number(r.retry_count),
        errorMessage: r.error_message == null ? null : String(r.error_message),
        startedAt: new Date(r.started_at),
        finishedAt: r.finished_at == null ? null : new Date(r.finished_at),
    };
}
async function insertEtlRunDownload(pool, row) {
    await pool.query(`INSERT INTO etl_run_downloads
       (run_id, source, dest_name, source_url, month, status, bytes,
        duration_ms, retry_count, error_message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
    ]);
}
async function listEtlRunDownloads(pool, runId) {
    const [rows] = await pool.query(`SELECT run_id, source, dest_name, source_url, month, status, bytes,
            duration_ms, retry_count, error_message, started_at, finished_at
       FROM etl_run_downloads
      WHERE run_id = ?
      ORDER BY id ASC`, [runId]);
    return rows.map(etlRunDownloadFromRow);
}
function etlRunParseFromRow(r) {
    return {
        runId: Number(r.run_id),
        source: String(r.source),
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
async function insertEtlRunParse(pool, row) {
    await pool.query(`INSERT INTO etl_run_parses
       (run_id, source, dest_name, rows_emitted,
        rows_skipped_short, rows_skipped_header, rows_skipped_unparseable_ip,
        rows_skipped_missing_col, rows_skipped_nan_asn, rows_skipped_other,
        gunzip_errors, started_at, finished_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
    ]);
}
async function listEtlRunParses(pool, runId) {
    const [rows] = await pool.query(`SELECT run_id, source, dest_name, rows_emitted,
            rows_skipped_short, rows_skipped_header, rows_skipped_unparseable_ip,
            rows_skipped_missing_col, rows_skipped_nan_asn, rows_skipped_other,
            gunzip_errors, started_at, finished_at, duration_ms
       FROM etl_run_parses
      WHERE run_id = ?
      ORDER BY id ASC`, [runId]);
    return rows.map(etlRunParseFromRow);
}
function etlRunInsertFromRow(r) {
    return {
        runId: Number(r.run_id),
        source: String(r.source),
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
async function insertEtlRunInsert(pool, row) {
    await pool.query(`INSERT INTO etl_run_inserts
       (run_id, source, dest_name, rows_attempted, rows_inserted,
        rows_duplicates, batch_count, duration_ms, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
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
    ]);
}
async function listEtlRunInserts(pool, runId) {
    const [rows] = await pool.query(`SELECT run_id, source, dest_name, rows_attempted, rows_inserted,
            rows_duplicates, batch_count, duration_ms, started_at, finished_at
       FROM etl_run_inserts
      WHERE run_id = ?
      ORDER BY id ASC`, [runId]);
    return rows.map(etlRunInsertFromRow);
}
function etlRunSwapFromRow(r) {
    return {
        runId: Number(r.run_id),
        status: String(r.status),
        durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
        errorMessage: r.error_message == null ? null : String(r.error_message),
        startedAt: new Date(r.started_at),
        finishedAt: r.finished_at == null ? null : new Date(r.finished_at),
    };
}
async function upsertEtlRunSwap(pool, row) {
    await pool.query(`INSERT INTO etl_run_swaps
       (run_id, status, duration_ms, error_message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       duration_ms = VALUES(duration_ms),
       error_message = VALUES(error_message),
       started_at = VALUES(started_at),
       finished_at = VALUES(finished_at)`, [
        row.runId,
        row.status,
        row.durationMs,
        row.errorMessage ? row.errorMessage.slice(0, 512) : null,
        row.startedAt,
        row.finishedAt,
    ]);
}
async function getEtlRunSwap(pool, runId) {
    const [rows] = await pool.query(`SELECT run_id, status, duration_ms, error_message, started_at, finished_at
       FROM etl_run_swaps
      WHERE run_id = ?`, [runId]);
    if (rows.length === 0)
        return null;
    return etlRunSwapFromRow(rows[0]);
}
var runner_1 = require("./migrations/runner");
Object.defineProperty(exports, "runMigrations", { enumerable: true, get: function () { return runner_1.runMigrations; } });
Object.defineProperty(exports, "getAppliedVersions", { enumerable: true, get: function () { return runner_1.getAppliedVersions; } });
Object.defineProperty(exports, "migrationStatus", { enumerable: true, get: function () { return runner_1.migrationStatus; } });
//# sourceMappingURL=mysql.js.map