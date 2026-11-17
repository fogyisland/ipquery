"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RangeFileError = exports.IPQ_DEFAULT_MAX_ROWS = exports.IPQ_VERSION = exports.IPQ_FORMAT = void 0;
exports.encodeHeader = encodeHeader;
exports.encodeRange = encodeRange;
exports.decodeFile = decodeFile;
// SPDX-License-Identifier: MIT
//
// The .ipq range file format.
//
// One JSON object per line: a header first, then one row per IP range. It is
// the same file for export and import, so an operator can move ranges from
// one install to another by downloading a file and uploading it back.
//
// Why JSON Lines and not a binary format, a CSV, or a single JSON array:
//
//   · An array has to be read whole before anything can be done with it.
//     A library-sized export is around two gigabytes; this way the exporter
//     streams line by line and the importer reads what it needs.
//   · CSV would need a column-order contract, and the moment a column is
//     added the older files mean something different.
//   · A binary format needs a parser, a byte-order decision and a tool of
//     its own to inspect. An operator debugging a bad import can read this
//     file, grep it, and diff two of them.
//
// The header is not decoration. It is what makes a truncated download
// detectable: a file without it is refused outright rather than imported as
// "zero ranges, everything went fine".
const ip_1 = require("../ip");
exports.IPQ_FORMAT = "ipquery-ranges";
exports.IPQ_VERSION = 1;
/** The most a single import reads, unless the caller says otherwise. */
exports.IPQ_DEFAULT_MAX_ROWS = 1_000_000;
/** A file that cannot be imported. The message names the line, because the
 *  operator is holding the file and has nothing else to go on. */
class RangeFileError extends Error {
    constructor(message) {
        super(message);
        this.name = "RangeFileError";
    }
}
exports.RangeFileError = RangeFileError;
/** Which columns the file writes. A field listed here is written when it
 *  has a value and left out when it does not. */
const FIELDS = [
    ["countryCode", "country"],
    ["countryName", "countryName"],
    ["region", "region"],
    ["city", "city"],
    ["postalCode", "postalCode"],
    ["latitude", "lat"],
    ["longitude", "lon"],
    ["timezone", "timezone"],
    ["isp", "isp"],
    ["asn", "asn"],
    ["asnOrg", "asnOrg"],
];
function encodeHeader(meta) {
    return JSON.stringify({
        format: exports.IPQ_FORMAT,
        version: exports.IPQ_VERSION,
        exportedAt: meta.exportedAt,
        rows: meta.rows,
    });
}
function encodeRange(row) {
    const out = { start: row.start, end: row.end };
    for (const [field, name] of FIELDS) {
        const value = row[field];
        if (value === null || value === undefined || value === "")
            continue;
        out[name] = value;
    }
    return JSON.stringify(out);
}
/**
 * Read a whole .ipq file held in memory.
 *
 * The streaming path (`readRangeFileStream`) is what the route uses for an
 * upload; this one exists for the parts that are easier to state as data —
 * a pasted snippet, a fixture, and every test of the format itself.
 */
function decodeFile(text, options = {}) {
    const maxRows = options.maxRows ?? exports.IPQ_DEFAULT_MAX_ROWS;
    const lines = text.split(/\r?\n/);
    const header = parseHeader(lines[0] ?? "");
    const ranges = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === "")
            continue;
        if (ranges.length >= maxRows) {
            throw new RangeFileError(`this file holds more than ${maxRows} ranges; split it or raise the ceiling before importing`);
        }
        // The record carries its own line number so a write failure can be
        // reported against the line the operator has to look at.
        ranges.push(parseRangeLine(line, i + 1));
    }
    return { header, ranges };
}
function parseHeader(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        throw new RangeFileError(`line 1: this is not an .ipq file — the first line must be the format header, ` +
            `and it could not be read as JSON`);
    }
    if (typeof parsed !== "object" || parsed === null) {
        throw new RangeFileError("line 1: the format header must be a JSON object");
    }
    const obj = parsed;
    if (obj.format !== exports.IPQ_FORMAT) {
        throw new RangeFileError(`line 1: this is not an ipquery-ranges file (found format ${JSON.stringify(obj.format)})`);
    }
    const version = Number(obj.version);
    if (version !== exports.IPQ_VERSION) {
        throw new RangeFileError(`line 1: this file is version ${String(obj.version)}, and this build reads version ${exports.IPQ_VERSION}. ` +
            `Upgrade the server, or export the file again from a build that writes that version.`);
    }
    return {
        format: exports.IPQ_FORMAT,
        version: exports.IPQ_VERSION,
        exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
        rows: typeof obj.rows === "number" ? obj.rows : 0,
    };
}
function parseRangeLine(line, lineNumber) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        throw new RangeFileError(`line ${lineNumber}: this line is not valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new RangeFileError(`line ${lineNumber}: expected a JSON object describing one range`);
    }
    const obj = parsed;
    const start = readAddress(obj.start, "start", lineNumber);
    const end = readAddress(obj.end, "end", lineNumber);
    const startBuf = (0, ip_1.parseIp)(start);
    const endBuf = (0, ip_1.parseIp)(end);
    // The two families share a 16-byte column: an IPv4 address is stored in
    // the last four bytes with twelve zeros in front. A file that mixes them
    // produces a range spanning most of the IPv6 space, and the lookup would
    // then answer with this row for addresses it has nothing to do with.
    if (isV6(start) !== isV6(end)) {
        throw new RangeFileError(`line ${lineNumber}: the range mixes IPv4 and IPv6 (${start} → ${end})`);
    }
    if ((0, ip_1.compareBuffers)(startBuf, endBuf) > 0) {
        throw new RangeFileError(`line ${lineNumber}: range ends before it starts (${start} → ${end})`);
    }
    return {
        line: lineNumber,
        start,
        end,
        countryCode: readText(obj.country, "country", lineNumber),
        countryName: readText(obj.countryName, "countryName", lineNumber),
        region: readText(obj.region, "region", lineNumber),
        city: readText(obj.city, "city", lineNumber),
        postalCode: readText(obj.postalCode, "postalCode", lineNumber),
        latitude: readNumber(obj.lat, "lat", lineNumber),
        longitude: readNumber(obj.lon, "lon", lineNumber),
        timezone: readText(obj.timezone, "timezone", lineNumber),
        isp: readText(obj.isp, "isp", lineNumber),
        asn: readInteger(obj.asn, "asn", lineNumber),
        asnOrg: readText(obj.asnOrg, "asnOrg", lineNumber),
    };
}
/** An address written either way parses to 16 bytes; only the original text
 *  says which family it was. */
function isV6(address) {
    return address.includes(":");
}
function readAddress(value, name, lineNumber) {
    if (typeof value !== "string" || value === "") {
        throw new RangeFileError(`line ${lineNumber}: "${name}" must be an IP address`);
    }
    if (!(0, ip_1.isValidIp)(value)) {
        throw new RangeFileError(`line ${lineNumber}: "${name}" is not a valid IP address: ${value}`);
    }
    return value;
}
function readText(value, name, lineNumber) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string") {
        throw new RangeFileError(`line ${lineNumber}: "${name}" must be text`);
    }
    return value === "" ? null : value;
}
function readNumber(value, name, lineNumber) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new RangeFileError(`line ${lineNumber}: "${name}" must be a number`);
    }
    return value;
}
function readInteger(value, name, lineNumber) {
    const n = readNumber(value, name, lineNumber);
    if (n === null)
        return null;
    // asn is INT UNSIGNED in the table. A negative or fractional ASN in a
    // hand-edited file would otherwise fail at INSERT with a driver error
    // that names a column instead of a line.
    if (!Number.isInteger(n) || n < 0) {
        throw new RangeFileError(`line ${lineNumber}: "${name}" must be a whole number`);
    }
    return n;
}
//# sourceMappingURL=rangeFile.js.map