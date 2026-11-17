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
exports.exportRangesToFile = exportRangesToFile;
const fs = __importStar(require("node:fs"));
const ip_1 = require("../ip");
const rangeFile_1 = require("./rangeFile");
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
];
/**
 * Write every matching range to `filePath` as an .ipq file.
 *
 * The file is written to a temporary name and renamed on completion, so a
 * failed export never leaves a half-written file that looks downloadable.
 */
async function exportRangesToFile(pool, filePath, filter = {}) {
    const total = await countMatching(pool, filter);
    const partial = `${filePath}.partial`;
    const handle = await fs.promises.open(partial, "w");
    let written = 0;
    try {
        await handle.writeFile(`${(0, rangeFile_1.encodeHeader)({ exportedAt: new Date().toISOString(), rows: total })}\n`);
        // Batched keyset paging on the primary key rather than LIMIT/OFFSET:
        // OFFSET re-reads every skipped row, and on a nine-million-row table
        // the second half of an export is unusably slow.
        let lastId = 0;
        for (;;) {
            const rows = await readBatch(pool, lastId, filter);
            if (rows.length === 0)
                break;
            let chunk = "";
            for (const row of rows) {
                chunk += `${(0, rangeFile_1.encodeRange)(row.record)}\n`;
                written += 1;
            }
            await handle.writeFile(chunk);
            lastId = rows[rows.length - 1].id;
            filter.onProgress?.(written, total);
            if (rows.length < BATCH_ROWS)
                break;
        }
        const { size } = await handle.stat();
        await handle.close();
        await fs.promises.rename(partial, filePath);
        return { rows: written, bytes: size, path: filePath };
    }
    catch (err) {
        // An unfinished file must not be left behind under the real name, or
        // the next download serves a truncated export as if it were whole.
        await handle.close().catch(() => undefined);
        await fs.promises.rm(partial, { force: true }).catch(() => undefined);
        throw err;
    }
}
const BATCH_ROWS = 2000;
async function countMatching(pool, filter) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM ip_ranges${whereClause(filter)}`, filter.countryCode ? [filter.countryCode] : []);
    return Number(rows[0]?.n ?? 0);
}
async function readBatch(pool, lastId, filter) {
    const params = [lastId];
    if (filter.countryCode)
        params.push(filter.countryCode);
    const [rows] = await pool.query(`SELECT id, ${SELECT_COLUMNS.join(",")} FROM ip_ranges
      WHERE id > ?${filter.countryCode ? " AND country_code = ?" : ""}
      ORDER BY id ASC
      LIMIT ${BATCH_ROWS}`, params);
    return rows.map((r) => ({
        id: Number(r.id),
        record: toRecord(r),
    }));
}
function whereClause(filter) {
    return filter.countryCode ? " WHERE country_code = ?" : "";
}
function toRecord(row) {
    return {
        line: 0,
        start: (0, ip_1.bufferToString)(row.start_ip),
        end: (0, ip_1.bufferToString)(row.end_ip),
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
//# sourceMappingURL=rangeExport.js.map