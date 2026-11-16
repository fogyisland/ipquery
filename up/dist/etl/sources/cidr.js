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
exports.parseCidrLine = parseCidrLine;
exports.parseMetowolfCidrStreamWithStats = parseMetowolfCidrStreamWithStats;
exports.parseRunishiwoV4CidrStreamWithStats = parseRunishiwoV4CidrStreamWithStats;
exports.parseRunishiwoV6CidrStreamWithStats = parseRunishiwoV6CidrStreamWithStats;
// SPDX-License-Identifier: MIT
const fs = __importStar(require("node:fs"));
const readline = __importStar(require("node:readline"));
const ip_1 = require("../../ip");
const types_1 = require("./types");
const ADDRESS_BITS = 128n;
const ALL_ONES = (1n << ADDRESS_BITS) - 1n;
function bufferToBigInt(buffer) {
    return BigInt(`0x${buffer.toString("hex")}`);
}
function bigIntToBuffer(value) {
    const hex = value.toString(16).padStart(32, "0");
    return Buffer.from(hex, "hex");
}
function parseCidrLine(line) {
    const text = line.trim();
    if (text === "" || text.startsWith("#") || text.startsWith("//"))
        return null;
    const separator = text.indexOf("/");
    const address = separator === -1 ? text : text.slice(0, separator);
    if (address.includes(":") && address.includes("."))
        return null;
    const parsed = (0, ip_1.parseIp)(address);
    if (!parsed)
        return null;
    const family = address.includes(":") ? "v6" : "v4";
    const prefixText = separator === -1 ? null : text.slice(separator + 1);
    if (prefixText !== null && !/^\d{1,3}$/.test(prefixText))
        return null;
    const prefix = prefixText === null ? (family === "v4" ? 32 : 128) : Number(prefixText);
    if (prefix < 0 || prefix > (family === "v4" ? 32 : 128))
        return null;
    const offset = family === "v4" ? 96 : 0;
    const hostBits = BigInt(ADDRESS_BITS - BigInt(offset) - BigInt(prefix));
    const mask = hostBits === 0n ? ALL_ONES : (ALL_ONES << hostBits) & ALL_ONES;
    const addressValue = bufferToBigInt(parsed);
    const startValue = addressValue & mask;
    const endValue = startValue | ((1n << hostBits) - 1n);
    return {
        startIp: bigIntToBuffer(startValue),
        endIp: bigIntToBuffer(endValue),
        countryCode: "CN",
        family,
    };
}
async function* parseCidrLines(filePath, stats, source, etlSource, expectedFamily) {
    const lines = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });
    try {
        for await (const line of lines) {
            const range = parseCidrLine(line);
            if (!range) {
                const trimmed = line.trim();
                if (trimmed !== "" && !trimmed.startsWith("#") && !trimmed.startsWith("//")) {
                    stats.skipped.unparseableIp += 1;
                }
                continue;
            }
            if (range.family !== expectedFamily) {
                stats.skipped.other += 1;
                continue;
            }
            stats.rowsEmitted += 1;
            yield {
                startIp: range.startIp,
                endIp: range.endIp,
                countryCode: range.countryCode,
                source,
                etlSource,
                family: range.family,
            };
        }
    }
    finally {
        lines.close();
    }
}
function parseCidrStreamWithStats(filePath, source, etlSource, expectedFamily) {
    const stats = (0, types_1.newStats)();
    return {
        records: parseCidrLines(filePath, stats, source, etlSource, expectedFamily),
        stats,
    };
}
function parseMetowolfCidrStreamWithStats(filePath) {
    return parseCidrStreamWithStats(filePath, "metowolf-cn", "metowolf-cn", "v4");
}
function parseRunishiwoV4CidrStreamWithStats(filePath) {
    return parseCidrStreamWithStats(filePath, "runishiwo-cn", "runishiwo-cn", "v4");
}
function parseRunishiwoV6CidrStreamWithStats(filePath) {
    return parseCidrStreamWithStats(filePath, "runishiwo-cn", "runishiwo-v6", "v6");
}
//# sourceMappingURL=cidr.js.map