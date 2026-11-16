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
exports.parseSapicsCountryCsvLine = parseSapicsCountryCsvLine;
exports.parseSapicsCountryStreamWithStats = parseSapicsCountryStreamWithStats;
// SPDX-License-Identifier: MIT
const fs = __importStar(require("node:fs"));
const readline = __importStar(require("node:readline"));
const country_names_1 = require("../../country-names");
const ip_1 = require("../../ip");
const dbip_1 = require("./dbip");
const types_1 = require("./types");
function parseSapicsCountryCsvLine(line) {
    const fields = (0, dbip_1.parseCsvLine)(line);
    if (fields.length < 3)
        return null;
    const startText = fields[0].trim();
    const endText = fields[1].trim();
    const code = fields[2].trim().toUpperCase();
    if (!(0, country_names_1.countryNamesFor)(code))
        return null;
    if (startText.includes(":") && startText.includes("."))
        return null;
    if (endText.includes(":") && endText.includes("."))
        return null;
    const startIp = (0, ip_1.parseIp)(startText);
    const endIp = (0, ip_1.parseIp)(endText);
    if (!startIp || !endIp || (0, ip_1.compareBuffers)(startIp, endIp) > 0)
        return null;
    const family = startText.includes(":") ? "v6" : "v4";
    if (family !== (endText.includes(":") ? "v6" : "v4"))
        return null;
    return { startIp, endIp, countryCode: code, family };
}
async function* parseSapicsCountryLines(filePath, stats) {
    const lines = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
    });
    try {
        for await (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === "" || trimmed.startsWith("#"))
                continue;
            const fields = (0, dbip_1.parseCsvLine)(trimmed);
            if (fields.length < 3) {
                stats.skipped.shortLine += 1;
                continue;
            }
            const startText = fields[0].trim();
            const endText = fields[1].trim();
            if ((startText.includes(":") && startText.includes(".")) ||
                (endText.includes(":") && endText.includes("."))) {
                stats.skipped.missingCol += 1;
                continue;
            }
            const code = fields[2].trim().toUpperCase();
            if (!(0, country_names_1.countryNamesFor)(code)) {
                stats.skipped.missingCol += 1;
                continue;
            }
            const range = parseSapicsCountryCsvLine(trimmed);
            if (!range) {
                stats.skipped.other += 1;
                continue;
            }
            stats.rowsEmitted += 1;
            yield {
                startIp: range.startIp,
                endIp: range.endIp,
                countryCode: range.countryCode,
                source: "sapics-user",
                etlSource: "sapics-user",
                family: range.family,
            };
        }
    }
    finally {
        lines.close();
    }
}
function parseSapicsCountryStreamWithStats(filePath) {
    const stats = (0, types_1.newStats)();
    return { records: parseSapicsCountryLines(filePath, stats), stats };
}
//# sourceMappingURL=sapicsCountry.js.map