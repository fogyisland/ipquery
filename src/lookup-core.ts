// SPDX-License-Identifier: MIT
// Shared lookup core used by both the HTTP API route and the MCP server.
// Extracted from src/api/routes/lookup.ts so the MCP tool reuses the exact
// same business logic (including the unknown_ip_queue miss side effect)
// instead of duplicating it.
import { parseIp } from "./ip";
import { findRange, lastSuccessfulEtl } from "./storage/mysql";
import { insertOrIncrement } from "./storage/unknownIpQueue";
import type { Pool } from "mysql2/promise";
import type { LookupResult } from "./types";

/** Minimal logger surface doLookupCore needs (satisfied by fastify's logger). */
export interface CoreLogger {
  warn: (obj: unknown, msg: string) => void;
}

export async function doLookupCore(pool: Pool, log: CoreLogger, ip: string): Promise<LookupResult> {
  const buf = parseIp(ip);
  if (!buf) {
    const err = new Error(`invalid ip: ${ip}`);
    (err as any).statusCode = 400;
    (err as any).code = "invalid_ip";
    throw err;
  }
  const row = await findRange(pool, buf);
  if (!row) {
    // Queue this miss for the backfill job. The DB write is fire-and-forget
    // at the *response* level: any failure here must NOT mask the 404 the
    // caller asked for. If insertOrIncrement throws (e.g. pool exhausted),
    // we log and still throw the not_found err below.
    try {
      await insertOrIncrement(pool, buf, ip);
    } catch (e) {
      log.warn({ err: e, ip }, "unknown_ip_queue insert failed; responding 404 anyway");
    }
    const err = new Error(`not found: ${ip}`);
    (err as any).statusCode = 404;
    (err as any).code = "not_found";
    (err as any).ip = ip;
    throw err;
  }
  const lastRun = await lastSuccessfulEtl(pool);
  const etag = lastRun ? lastRun.toISOString() : "never";
  return {
    ip,
    country: { code: row.countryCode, name: row.countryName, source: row.countrySource ?? "maxmind" },
    region: row.region,
    city: row.city ? { name: row.city, source: row.citySource ?? "maxmind" } : undefined,
    postalCode: row.postalCode,
    location:
      row.latitude !== undefined && row.longitude !== undefined
        ? { lat: row.latitude, lon: row.longitude, source: row.geoSource ?? "maxmind" }
        : undefined,
    timezone: row.timezone,
    isp: row.isp ? { name: row.isp, source: row.ispSource ?? "maxmind" } : undefined,
    asn:
      row.asn !== undefined
        ? { number: row.asn, org: row.asnOrg, source: row.asnSource ?? "maxmind" }
        : undefined,
    etag,
  };
}
