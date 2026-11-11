"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.doLookupCore = doLookupCore;
// SPDX-License-Identifier: MIT
// Shared lookup core used by both the HTTP API route and the MCP server.
// Extracted from src/api/routes/lookup.ts so the MCP tool reuses the exact
// same business logic (including the unknown_ip_queue miss side effect)
// instead of duplicating it.
const ip_1 = require("./ip");
const mysql_1 = require("./storage/mysql");
const unknownIpQueue_1 = require("./storage/unknownIpQueue");
async function doLookupCore(pool, log, ip) {
    const buf = (0, ip_1.parseIp)(ip);
    if (!buf) {
        const err = new Error(`invalid ip: ${ip}`);
        err.statusCode = 400;
        err.code = "invalid_ip";
        throw err;
    }
    const row = await (0, mysql_1.findRange)(pool, buf);
    if (!row) {
        // Queue this miss for the backfill job. The DB write is fire-and-forget
        // at the *response* level: any failure here must NOT mask the 404 the
        // caller asked for. If insertOrIncrement throws (e.g. pool exhausted),
        // we log and still throw the not_found err below.
        try {
            await (0, unknownIpQueue_1.insertOrIncrement)(pool, buf, ip);
        }
        catch (e) {
            log.warn({ err: e, ip }, "unknown_ip_queue insert failed; responding 404 anyway");
        }
        const err = new Error(`not found: ${ip}`);
        err.statusCode = 404;
        err.code = "not_found";
        err.ip = ip;
        throw err;
    }
    const lastRun = await (0, mysql_1.lastSuccessfulEtl)(pool);
    const etag = lastRun ? lastRun.toISOString() : "never";
    return {
        ip,
        country: { code: row.countryCode, name: row.countryName, source: row.countrySource ?? "maxmind" },
        region: row.region,
        city: row.city ? { name: row.city, source: row.citySource ?? "maxmind" } : undefined,
        postalCode: row.postalCode,
        location: row.latitude !== undefined && row.longitude !== undefined
            ? { lat: row.latitude, lon: row.longitude, source: row.geoSource ?? "maxmind" }
            : undefined,
        timezone: row.timezone,
        isp: row.isp ? { name: row.isp, source: row.ispSource ?? "maxmind" } : undefined,
        asn: row.asn !== undefined
            ? { number: row.asn, org: row.asnOrg, source: row.asnSource ?? "maxmind" }
            : undefined,
        etag,
    };
}
//# sourceMappingURL=lookup-core.js.map