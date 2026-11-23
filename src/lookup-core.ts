// SPDX-License-Identifier: MIT
// Shared lookup core used by both the HTTP API route and the MCP server.
// Extracted from src/api/routes/lookup.ts so the MCP tool reuses the exact
// same business logic (including the unknown_ip_queue miss side effect)
// instead of duplicating it.
import { parseIp } from "./ip";
import { findRange, lastSuccessfulEtl } from "./storage/mysql";
import { insertOrIncrement } from "./storage/unknownIpQueue";
import { englishCountryName } from "./country-names";
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
  // `country_name` is NULL for every row the ETL loads: DB-IP's free CSVs
  // carry a country code only, and no source in the pipeline fills a
  // name. Fall back to the ISO 3166-1 name for the code, so the API
  // answers "Hong Kong" rather than a bare "HK" with a null name. An
  // unknown code still yields no name: inventing one for a code we don't
  // recognise would be worse than admitting we don't.
  //
  // The `?? "unknown"` fallbacks on the source fields are the last
  // resort for a row that carries no source at all. The normal path
  // never reaches them: findRange() normalizes every source column
  // through normalizeSource(), so a row that names a source the
  // pipeline never wrote comes back as "unknown" already.
  //
  // The fallback used to say "maxmind". The pipeline has never fetched
  // MaxMind, so every one of those rows was answered with a source
  // this project never used — a false claim about where the data came
  // from, made by the field whose whole job is to say where the data
  // came from. "unknown" says what is actually true.
  const countryName = row.countryName ?? englishCountryName(row.countryCode) ?? undefined;
  return {
    ip,
    country: { code: row.countryCode, name: countryName, source: row.countrySource ?? "unknown" },
    region: row.region,
    city: row.city ? { name: row.city, source: row.citySource ?? "unknown" } : undefined,
    postalCode: row.postalCode,
    location:
      row.latitude !== undefined && row.longitude !== undefined
        ? { lat: row.latitude, lon: row.longitude, source: row.geoSource ?? "unknown" }
        : undefined,
    timezone: row.timezone,
    isp: row.isp ? { name: row.isp, source: row.ispSource ?? "unknown" } : undefined,
    asn:
      row.asn !== undefined
        ? { number: row.asn, org: row.asnOrg, source: row.asnSource ?? "unknown" }
        : undefined,
    etag,
  };
}
