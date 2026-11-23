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

/** Largest batch one call will answer. */
export const MAX_BATCH_SIZE = 100;

/** One address inside a batch answer. */
export interface BatchLookupEntry {
  ip: string;
  /** False when the address was malformed or not in the library. */
  found: boolean;
  /** The lookup result, when the address was found. */
  result?: LookupResult;
  /** Why the address was not found: "invalid_ip" or "not_found". */
  error?: string;
}

export interface BatchLookupResult {
  results: BatchLookupEntry[];
  /** How many addresses were asked about. */
  total: number;
  /** How many of them were in the library. */
  found: number;
  /** How many were not — malformed or unknown. */
  notFound: number;
}

/**
 * Look several addresses up in one call.
 *
 * The batch never fails as a whole. One malformed address does not cost
 * the caller the other ninety-nine answers: the bad one is marked and
 * the rest land. A batch that died on the first bad address would be
 * worse than no batch at all — the caller's job is reconciliation, and a
 * single malformed line in a log file must not cost them the file.
 *
 * The HTTP API and the MCP server both call this, so an answer means the
 * same thing whichever way it was asked for.
 */
export async function doLookupBatchCore(
  pool: Pool,
  log: CoreLogger,
  ips: readonly string[],
): Promise<BatchLookupResult> {
  const results: BatchLookupEntry[] = [];
  let found = 0;

  for (const ip of ips) {
    try {
      const result = await doLookupCore(pool, log, ip);
      results.push({ ip, found: true, result });
      found += 1;
    } catch (e) {
      // A miss is an answer, not a failure: the address is simply not in
      // the library. Anything else is reported against that one entry so
      // the rest of the batch still lands.
      const code = (e as { code?: unknown }).code;
      results.push({
        ip,
        found: false,
        error: typeof code === "string" ? code : "lookup_failed",
      });
    }
  }

  return { results, total: ips.length, found, notFound: ips.length - found };
}
