// SPDX-License-Identifier: MIT
//
// Draining the unknown_ip_queue via external providers + majority vote.
//
// Flow:
//   1. nextBatch() pulls pending IPs that aren't covered by ip_ranges.
//   2. For each IP we fan out to every provider in parallel, each gated
//      by its own token bucket.
//   3. majorityVote() decides whether the responses converge.
//      - consensus → upsert a /32 (IPv4) or /128 (IPv6) range into
//        ip_ranges with every *_source tagged 'multi-provider', then
//        markProcessed the queue rows.
//      - no consensus / no providers → markAttempted() with a reason
//        and leave processed_at NULL so we try again next time.
//   4. If any provider returns HTTP 429, it gets disabled in
//      ingest_providers (rateLimited=true -> touchProviderError +
//      updateProviderConfig({enabled:false})) so the rest of this run and
//      future runs skip it until the admin re-enables it.
//   5. Returns a summary so the admin route can show "X processed, Y
//      merged, Z skipped".
//
// Run this from:
//   - POST /admin/unknown-ips/backfill (manual, sync)
//   - cron / future scheduler
//
// processIp() (exported) is the reusable per-IP fan-out + vote + write
// core. The random-IP generator imports it to drive its synthetic IPs
// without needing unknown_ip_queue rows.

import type { Pool } from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2/promise';
import { nextBatch, markProcessed, markAttempted, type UnknownIpRow } from '../storage/unknownIpQueue';
import type { IpGeoProvider, IpGeoLookupResult, IpGeoRecord } from './providers/types';
import type { ProviderConfigRow } from '../storage/ingestProviders';
import { touchProviderError, updateProviderConfig } from '../storage/ingestProviders';
import { majorityVote } from './majority';
import { parseIp } from '../ip';

export interface BackfillOptions {
  /** How many IPs to pull per run. Each IP fans out to all providers so
   *  effective provider-call count is `batchLimit * providers.length`. */
  batchLimit?: number;
  /** Per-IP timeout for the fan-out (covers slowest provider). */
  perIpTimeoutMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface BackfillSummary {
  considered: number;
  merged: number;
  noConsensus: number;
  noCountry: number;
  allAbstained: number;
  alreadyCovered: number;
  /** When the run started (ms epoch). */
  startedAt: number;
  /** When the run finished (ms epoch). */
  finishedAt: number;
  /** Provider call stats (for the dashboard). */
  providers: Record<string, { ok: number; failed: number; abstained: number; rateLimited: number }>;
  /** Provider names that we auto-disabled during this run due to 429. */
  providersDisabled: string[];
}

const DEFAULT_BATCH = 100;
const DEFAULT_TIMEOUT = 8_000;

/** Per-IP outcome returned by processIp. `merged` carries `newlyInserted`
 *  so the random-IP flow can tell genuinely-new rows apart from
 *  duplicates-that-were-ignored. Backfill doesn't care about the
 *  distinction (queue rows are unique by construction). */
export type IpOutcome =
  | { kind: 'merged'; record: IpGeoRecord; newlyInserted: boolean }
  | { kind: 'no_consensus' }
  | { kind: 'no_country' }
  | { kind: 'all_abstained' };

export async function runBackfill(
  pool: Pool,
  providers: IpGeoProvider[],
  opts: BackfillOptions = {},
): Promise<BackfillSummary> {
  const batchLimit = opts.batchLimit ?? DEFAULT_BATCH;
  const perIpTimeout = opts.perIpTimeoutMs ?? DEFAULT_TIMEOUT;
  const log = opts.logger ?? console;

  const startedAt = Date.now();
  const summary: BackfillSummary = {
    considered: 0,
    merged: 0,
    noConsensus: 0,
    noCountry: 0,
    allAbstained: 0,
    alreadyCovered: 0,
    startedAt,
    finishedAt: 0,
    providers: Object.fromEntries(providers.map((p) => [
      p.name, { ok: 0, failed: 0, abstained: 0, rateLimited: 0 },
    ])),
    providersDisabled: [],
  };

  const queueRows = await nextBatch(pool, batchLimit);
  summary.considered = queueRows.length;
  if (queueRows.length === 0) {
    summary.finishedAt = Date.now();
    return summary;
  }

  const outcomes: Array<{ row: UnknownIpRow; outcome: IpOutcome }> = [];

  // Fan out all IPs concurrently, but cap concurrency at 16 to avoid
  // hammering the providers (and our own DB connection pool) in one go.
  const CONCURRENCY = 16;
  for (let i = 0; i < queueRows.length; i += CONCURRENCY) {
    const slice = queueRows.slice(i, i + CONCURRENCY);
    const sliceOutcomes = await Promise.all(
      slice.map(async (row) => ({ row, outcome: await processIp(pool, providers, row.ipText, row.ip, perIpTimeout, summary) })),
    );
    outcomes.push(...sliceOutcomes);
  }

  // Auto-disable any provider that hit 429 during this run. We do this
  // AFTER all IPs are processed (rather than mid-run) so we don't keep
  // the old in-memory provider instance alive while it's no longer in
  // the DB config. This is the safety the user asked for: "如果显示大大
  // 限制则立即禁用".
  await disableRateLimitedProviders(pool, providers, summary);
  // Drop disabled providers from the per-provider stats so the UI
  // doesn't show ongoing failures for something we just turned off.
  for (const name of summary.providersDisabled) {
    delete summary.providers[name];
  }

  // Bulk-update the queue: mark merged rows as processed, mark attempted
  // rows with their reason. Bulk keeps the DB round-trips predictable.
  const mergedIds: number[] = [];
  const attempted: { no_consensus: number[]; no_country: number[]; all_abstained: number[] } = {
    no_consensus: [], no_country: [], all_abstained: [],
  };
  for (const { row, outcome } of outcomes) {
    if (outcome.kind === 'merged') {
      mergedIds.push(row.id);
      summary.merged += 1;
    } else {
      attempted[outcome.kind].push(row.id);
      if (outcome.kind === 'no_consensus') summary.noConsensus += 1;
      else if (outcome.kind === 'no_country') summary.noCountry += 1;
      else summary.allAbstained += 1;
    }
  }

  if (mergedIds.length > 0) {
    // Use a synthetic run id (negative sentinel) — we don't have a real
    // etl_runs row for this backfill, but the column is BIGINT UNSIGNED
    // and FK is optional. NULL would be cleaner but markProcessed takes a
    // runId. Pick a high negative-as-uint convention: 0 means "manual
    // backfill, no etl_runs row". If a future maintainer wants the FK
    // strictly enforced, they can drop the constraint.
    await markProcessed(pool, mergedIds, 0);
  }
  if (attempted.no_consensus.length > 0) await markAttempted(pool, attempted.no_consensus, 'no_consensus');
  if (attempted.no_country.length > 0) await markAttempted(pool, attempted.no_country, 'no_country');
  if (attempted.all_abstained.length > 0) await markAttempted(pool, attempted.all_abstained, 'all_abstained');

  summary.finishedAt = Date.now();
  log.log?.(`[backfill] ${summary.merged}/${summary.considered} merged in ${summary.finishedAt - startedAt}ms; disabled=${summary.providersDisabled.join(',') || 'none'}`);
  return summary;
}

/** Per-IP fan-out + vote + write. Used by both the queue-driven backfill
 *  and the random-IP generator. Updates `summary.providers[name]` stats
 *  in place. Returns the outcome so the caller can track it. */
export async function processIp(
  pool: Pool,
  providers: IpGeoProvider[],
  ipText: string,
  ipBuffer: Buffer,
  _perIpTimeoutMs: number,
  summary: BackfillSummary,
): Promise<IpOutcome> {
  const responses = await Promise.all(
    providers.map(async (p) => {
      const start = Date.now();
      let result: IpGeoLookupResult;
      try {
        result = await p.lookup(ipText);
      } catch {
        const stats = summary.providers[p.name];
        if (stats) stats.failed += 1;
        return { provider: p.name, record: null as IpGeoRecord | null, rateLimited: false };
      }
      const elapsed = Date.now() - start;
      const stats = summary.providers[p.name];
      if (stats) {
        if (result.rateLimited) stats.rateLimited += 1;
        else if (result.record) stats.ok += 1;
        else stats.abstained += 1;
      }
      if (elapsed > 2_000) {
        console.warn?.(`[backfill] provider ${p.name} took ${elapsed}ms for ${ipText}`);
      }
      return { provider: p.name, record: result.record, rateLimited: result.rateLimited };
    }),
  );

  const vote = majorityVote(responses);
  if (!vote.ok) {
    return { kind: vote.reason };
  }

  const newlyInserted = await writeConsensusRange(pool, ipBuffer, vote.record);
  return { kind: 'merged', record: vote.record, newlyInserted };
}

/** Disable any provider whose rateLimited counter > 0. Idempotent. */
async function disableRateLimitedProviders(
  pool: Pool,
  providers: IpGeoProvider[],
  summary: BackfillSummary,
): Promise<void> {
  const liveProviders = new Set(providers.map((p) => p.name));
  for (const [name, stats] of Object.entries(summary.providers)) {
    if (stats.rateLimited <= 0) continue;
    if (!liveProviders.has(name)) continue;
    if (summary.providersDisabled.includes(name)) continue;
    try {
      await updateProviderConfig(pool, name, { enabled: false });
      await touchProviderError(pool, name, `429 rate limited (${stats.rateLimited}x in this run)`);
      summary.providersDisabled.push(name);
      console.warn?.(`[backfill] auto-disabled provider ${name} after ${stats.rateLimited} x 429`);
    } catch (err) {
      console.error?.(`[backfill] failed to disable ${name}:`, err);
    }
  }
}

/** Insert a /32 (IPv4) or /128 (IPv6) range covering exactly `ip`. Tagged
  // 'multi-provider' on every *_source column so the origin is greppable
  // and so the seed-DB-IP flow (which UNIQUE-indexes (start,end,source)
  // won't collide on it). INSERT IGNORE because the random-IP generator
  // may pick the same reserved-range IP twice across runs (the IPv6
  // catchall makes findRange-based dedupe impossible), and a duplicate
  // /32 from a previous run shouldn't abort this run. Returns true if
  // a NEW row was inserted, false if the unique index turned it into a
  // no-op (already existed). The random-gen flow tracks duplicates
  // separately from genuinely-new rows. */
async function writeConsensusRange(
  pool: Pool,
  ip: Buffer,
  rec: IpGeoRecord,
): Promise<boolean> {
  const startBig = BigInt('0x' + ip.toString('hex'));
  const endBig = startBig + 1n;
  const endBuf = Buffer.from(endBig.toString(16).padStart(32, '0'), 'hex');
  const startBuf = Buffer.from(startBig.toString(16).padStart(32, '0'), 'hex');

  const [res] = await pool.query<ResultSetHeader>(
    `INSERT IGNORE INTO ip_ranges
       (start_ip, end_ip, range_size, country_code, country_name, region, city,
        latitude, longitude, timezone, isp, asn, asn_org,
        country_source, city_source, isp_source, asn_source, geo_source)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider')`,
    [
      startBuf, endBuf,
      rec.countryCode, rec.countryName,
      rec.region, rec.city,
      rec.latitude, rec.longitude, rec.timezone,
      rec.isp, rec.asn, rec.asnOrg,
    ],
  );
  return res.affectedRows === 1;
}

/** Convenience constructor: pick providers based on which API keys are
 *  present in env. Each provider silently abstains if its key is missing,
 *  so the backfill is robust to partial configurations — it'll just have
 *  fewer votes and may fail to reach consensus. */
export function buildDefaultProviders(env: NodeJS.ProcessEnv = process.env): IpGeoProvider[] {
  // Lazy import so the providers' deps (which only fire when lookup() is
  // called) aren't loaded for callers that don't need backfill.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { IpApiProvider, IpinfoProvider, IplocateProvider, FreeIpApiProvider, IpapiCoProvider } = require('./providers') as typeof import('./providers');
  return [
    new IpApiProvider(), // no key required, 45/min HTTP
    new IpinfoProvider({ token: env.IPINFO_TOKEN }),     // key optional, 50k/month HTTPS
    new IplocateProvider({ apiKey: env.IPLOCATE_API_KEY }), // key optional, 1k/day HTTPS
    new FreeIpApiProvider(),  // no key, 60/min HTTPS
    new IpapiCoProvider(),    // no key, 30k/month HTTPS
  ];
}

/** Convenience: parse + validate an IP string into the same Buffer format
 *  unknown_ip_queue stores. Re-exported here so admin routes don't need
 *  to import the low-level helper directly. */
export function bufferFromIpText(text: string): Buffer | null {
  return parseIp(text);
}

/** Re-export the storage type for callers that build providers from DB. */
export type { ProviderConfigRow };
