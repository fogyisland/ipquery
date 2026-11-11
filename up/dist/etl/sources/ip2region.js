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
exports.parseIp2regionXdb = parseIp2regionXdb;
// SPDX-License-Identifier: MIT
const fs = __importStar(require("node:fs"));
const ip_1 = require("../../ip");
/**
 * v1: parses JSON-export form of ip2region. Future work: replace with
 * a real binary .xdb reader per https://gitee.com/lionsoul/ip2region
 */
async function parseIp2regionXdb(xdbPath) {
    const raw = fs.readFileSync(xdbPath, "utf8");
    const rows = JSON.parse(raw);
    const records = [];
    for (const row of rows) {
        const start = (0, ip_1.parseIp)(row.start);
        const end = (0, ip_1.parseIp)(row.end);
        if (!start || !end)
            continue;
        const rec = { startIp: start, endIp: end, source: "ip2region" };
        const cc = countryNameToCode(row.country);
        if (cc) {
            rec.countryCode = cc;
            rec.countryName = row.country;
        }
        if (row.province)
            rec.region = row.province;
        if (row.city)
            rec.city = row.city;
        if (row.isp)
            rec.isp = row.isp;
        records.push(rec);
    }
    return records;
}
const COUNTRY_NAME_TO_CODE = {
    中国: "CN",
    美国: "US",
    日本: "JP",
    韩国: "KR",
    英国: "GB",
    德国: "DE",
    法国: "FR",
    俄罗斯: "RU",
    加拿大: "CA",
    澳大利亚: "AU",
    巴西: "BR",
    印度: "IN",
};
function countryNameToCode(name) {
    return COUNTRY_NAME_TO_CODE[name];
}
//# sourceMappingURL=ip2region.js.map