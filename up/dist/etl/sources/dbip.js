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
exports.parseDbipCsvStream = exports.parseDbipCsv = void 0;
exports.parseDbipCityCsvStream = parseDbipCityCsvStream;
exports.parseDbipCityCsv = parseDbipCityCsv;
exports.parseDbipCityCsvStreamWithStats = parseDbipCityCsvStreamWithStats;
exports.parseDbipCountryCsvStream = parseDbipCountryCsvStream;
exports.parseDbipCountryCsv = parseDbipCountryCsv;
exports.parseDbipCountryCsvStreamWithStats = parseDbipCountryCsvStreamWithStats;
exports.parseDbipAsnCsvStream = parseDbipAsnCsvStream;
exports.parseDbipAsnCsv = parseDbipAsnCsv;
exports.parseDbipAsnCsvStreamWithStats = parseDbipAsnCsvStreamWithStats;
// SPDX-License-Identifier: MIT
const fs = __importStar(require("node:fs"));
const zlib = __importStar(require("node:zlib"));
const readline = __importStar(require("node:readline"));
const ip_1 = require("../../ip");
// DB-IP distributes its free data as separate CSV.gz files, one per
// information slice. All three cover the same IP ranges (a row in the
// country-lite file points at the same start/end IPs as the matching row
// in the city-lite file), so they are stitched together per segment by
// the insert stage, which upserts each file in priority order and lets
// a lower-priority file fill only the columns the higher-priority one
// left NULL (INSERT ... ON DUPLICATE KEY UPDATE col = COALESCE(col,
// VALUES(col))). The per-file column sets are declared by DBIP_FILES in
// ../pipeline.ts.
//
// Column layouts we consume:
//
//   city-lite   : start, end, continent, country, region, city, lat, lon
//   country-lite: start, end, country
//   asn-lite    : start, end, asn, asn_org
//
// The naive readFileSync + gunzipSync + toString blows Node's single-string
// limit (~512 MB) on the full city-lite set (~706 MB uncompressed), and
// materialising the full NormalizedRecord[] exhausts the 4 GB V8 heap at
// ~7.9M rows. Each parser below streams one record at a time so callers
// can route rows straight into the new table without keeping the array
// resident.
function parseInt10(s) {
    if (s === undefined || s === "")
        return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
}
function parseDec(s) {
    if (s === undefined || s === "")
        return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
}
// Minimal RFC 4180-ish CSV line parser: handles double-quoted fields that
// may contain commas and `""`-escaped quotes. Doesn't handle embedded
// newlines because DB-IP rows don't have them.
function parseCsvLine(line) {
    const out = [];
    let i = 0;
    while (i <= line.length) {
        if (i === line.length) {
            out.push("");
            break;
        }
        if (line[i] === '"') {
            let buf = "";
            i++;
            while (i < line.length) {
                if (line[i] === '"' && line[i + 1] === '"') {
                    buf += '"';
                    i += 2;
                    continue;
                }
                if (line[i] === '"') {
                    i++;
                    break;
                }
                buf += line[i];
                i++;
            }
            out.push(buf);
            if (i < line.length && line[i] === ",")
                i++;
        }
        else {
            let j = i;
            while (j < line.length && line[j] !== ",")
                j++;
            out.push(line.slice(i, j));
            i = j + 1;
        }
    }
    return out;
}
async function* streamGzippedCsv(gzPath, header) {
    const gunzip = zlib.createGunzip();
    const fileStream = fs.createReadStream(gzPath);
    const lines = readline.createInterface({ input: fileStream.pipe(gunzip), crlfDelay: Infinity });
    let isFirst = true;
    for await (const line of lines) {
        if (!line)
            continue;
        if (isFirst) {
            isFirst = false;
            if (header)
                continue;
        }
        yield parseCsvLine(line);
    }
}
function isHeaderRow(cols) {
    return cols[0] === "ip_start" || cols[0] === "start_ip";
}
function newStats() {
    return {
        rowsEmitted: 0,
        skipped: { shortLine: 0, headerRow: 0, unparseableIp: 0, missingCol: 0, nonNumericAsn: 0, other: 0 },
        gunzipErrors: 0,
    };
}
async function* parseDbipCityLines(gzPath, stats) {
    for await (const cols of streamGzippedCsv(gzPath, true)) {
        if (cols.length < 5) {
            stats.skipped.shortLine++;
            continue;
        }
        if (isHeaderRow(cols)) {
            stats.skipped.headerRow++;
            continue;
        }
        const start = (0, ip_1.parseIp)(cols[0]);
        const end = (0, ip_1.parseIp)(cols[1]);
        if (!start || !end) {
            stats.skipped.unparseableIp++;
            continue;
        }
        const rec = { startIp: start, endIp: end, source: "dbip" };
        // cols[3] is the ISO country code; cols[2] is the continent code we ignore.
        if (cols[3])
            rec.countryCode = cols[3];
        if (cols[4])
            rec.region = cols[4];
        if (cols[5])
            rec.city = cols[5];
        const lat = parseDec(cols[6]);
        if (lat !== undefined)
            rec.latitude = lat;
        const lon = parseDec(cols[7]);
        if (lon !== undefined)
            rec.longitude = lon;
        stats.rowsEmitted++;
        yield rec;
    }
}
async function* parseDbipCountryLines(gzPath, stats) {
    for await (const cols of streamGzippedCsv(gzPath, true)) {
        if (cols.length < 3) {
            stats.skipped.shortLine++;
            continue;
        }
        if (isHeaderRow(cols)) {
            stats.skipped.headerRow++;
            continue;
        }
        const start = (0, ip_1.parseIp)(cols[0]);
        const end = (0, ip_1.parseIp)(cols[1]);
        if (!start || !end) {
            stats.skipped.unparseableIp++;
            continue;
        }
        const rec = { startIp: start, endIp: end, source: "dbip" };
        if (cols[2])
            rec.countryCode = cols[2];
        stats.rowsEmitted++;
        yield rec;
    }
}
async function* parseDbipAsnLines(gzPath, stats) {
    for await (const cols of streamGzippedCsv(gzPath, true)) {
        if (cols.length < 4) {
            stats.skipped.shortLine++;
            continue;
        }
        if (isHeaderRow(cols)) {
            stats.skipped.headerRow++;
            continue;
        }
        const start = (0, ip_1.parseIp)(cols[0]);
        const end = (0, ip_1.parseIp)(cols[1]);
        if (!start || !end) {
            stats.skipped.unparseableIp++;
            continue;
        }
        const rec = { startIp: start, endIp: end, source: "dbip" };
        const asn = parseInt10(cols[2]);
        if (asn !== undefined) {
            rec.asn = asn;
        }
        else {
            // cols[2] present but not a clean integer — track it so the admin
            // run-detail page can show "X rows had a non-numeric ASN" without
            // the caller having to compare against the file separately. The
            // row is still yielded (preserves the legacy behaviour where the
            // record is emitted with asn undefined).
            stats.skipped.nonNumericAsn++;
        }
        if (cols[3])
            rec.asnOrg = cols[3];
        stats.rowsEmitted++;
        yield rec;
    }
}
// City-lite: country + region + city + (lat,lon ignored).
// Streaming variants are the production path; array variants stay for tests.
async function* parseDbipCityCsvStream(gzPath) {
    const { records } = parseDbipCityCsvStreamWithStats(gzPath);
    yield* records;
}
async function parseDbipCityCsv(gzPath) {
    const out = [];
    for await (const r of parseDbipCityLines(gzPath, newStats()))
        out.push(r);
    return out;
}
function parseDbipCityCsvStreamWithStats(gzPath) {
    const stats = newStats();
    return { records: parseDbipCityLines(gzPath, stats), stats };
}
// Country-lite: country code only.
async function* parseDbipCountryCsvStream(gzPath) {
    const { records } = parseDbipCountryCsvStreamWithStats(gzPath);
    yield* records;
}
async function parseDbipCountryCsv(gzPath) {
    const out = [];
    for await (const r of parseDbipCountryLines(gzPath, newStats()))
        out.push(r);
    return out;
}
function parseDbipCountryCsvStreamWithStats(gzPath) {
    const stats = newStats();
    return { records: parseDbipCountryLines(gzPath, stats), stats };
}
// ASN-lite: ASN number + ASN organization.
async function* parseDbipAsnCsvStream(gzPath) {
    const { records } = parseDbipAsnCsvStreamWithStats(gzPath);
    yield* records;
}
async function parseDbipAsnCsv(gzPath) {
    const out = [];
    for await (const r of parseDbipAsnLines(gzPath, newStats()))
        out.push(r);
    return out;
}
function parseDbipAsnCsvStreamWithStats(gzPath) {
    const stats = newStats();
    return { records: parseDbipAsnLines(gzPath, stats), stats };
}
// Backwards-compatible aliases: the original parseDbipCsv referred to the
// city file. Existing tests and pipeline paths use these names.
exports.parseDbipCsv = parseDbipCityCsv;
exports.parseDbipCsvStream = parseDbipCityCsvStream;
//# sourceMappingURL=dbip.js.map