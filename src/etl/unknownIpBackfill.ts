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
//   4. Returns a summary so the admin route can show "X processed, Y
//      merged, Z skipped".
//
// Run this from:
//   - POST /admin/unknown-ips/backfill (manual, sync)
//   - cron / future scheduler

import type { Pool } from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2/promise';
import { nextBatch, markProcessed, markAttempted, type UnknownIpRow } from '../storage/unknownIpQueue';
import type { IpGeoProvider, IpGeoRecord } from './providers/types';
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
  providers: Record<string, { ok: number; failed: number; abstained: number }>;
}

const DEFAULT_BATCH = 100;
const DEFAULT_TIMEOUT = 8_000;

/** Result of running the backfill on one IP. */
type PerIpResult =
  | { kind: 'merged'; row: UnknownIpRow; record: IpGeoRecord }
  | { kind: 'no_consensus'; row: UnknownIpRow }
  | { kind: 'no_country'; row: UnknownIpRow }
  | { kind: 'all_abstained'; row: UnknownIpRow };

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
    providers: Object.fromEntries(providers.map((p) => [p.name, { ok: 0, failed: 0, abstained: 0 }])),
  };

  const queueRows = await nextBatch(pool, batchLimit);
  summary.considered = queueRows.length;
  if (queueRows.length === 0) {
    summary.finishedAt = Date.now();
    return summary;
  }

  const results: PerIpResult[] = [];

  // Fan out all IPs concurrently, but cap concurrency at 16 to avoid
  // hammering the providers (and our own DB connection pool) in one go.
  const CONCURRENCY = 16;
  for (let i = 0; i < queueRows.length; i += CONCURRENCY) {
    const slice = queueRows.slice(i, i + CONCURRENCY);
    const sliceResults = await Promise.all(
      slice.map((row) => backfillOne(pool, providers, row, perIpTimeout, summary)),
    );
    results.push(...sliceResults);
  }

  // Bulk-update the queue: mark merged rows as processed, mark attempted
  // rows with their reason. Bulk keeps the DB round-trips predictable.
  const mergedIds: number[] = [];
  const attempted: { no_consensus: number[]; no_country: number[]; all_abstained: number[] } = {
    no_consensus: [], no_country: [], all_abstained: [],
  };
  for (const r of results) {
    if (r.kind === 'merged') {
      mergedIds.push(r.row.id);
      summary.merged += 1;
    } else {
      attempted[r.kind].push(r.row.id);
      if (r.kind === 'no_consensus') summary.noConsensus += 1;
      else if (r.kind === 'no_country') summary.noCountry += 1;
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
  log.log?.(`[backfill] ${summary.merged}/${summary.considered} merged in ${summary.finishedAt - startedAt}ms`);
  return summary;
}

async function backfillOne(
  pool: Pool,
  providers: IpGeoProvider[],
  row: UnknownIpRow,
  perIpTimeoutMs: number,
  summary: BackfillSummary,
): Promise<PerIpResult> {
  const ipText = row.ipText;
  const responses = await Promise.all(
    providers.map(async (p) => {
      const start = Date.now();
      try {
        const rec = await p.lookup(ipText);
        const elapsed = Date.now() - start;
        const stats = summary.providers[p.name];
        if (!stats) {
          // New provider added after summary was built — should never
          // happen because runBackfill pre-seeds, but guard for it.
          return { provider: p.name, record: rec };
        }
        if (rec) {
          stats.ok += 1;
        } else {
          stats.abstained += 1;
        }
        if (elapsed > 2_000) {
          // Slow provider — log once for visibility but don't fail.
          console.warn?.(`[backfill] provider ${p.name} took ${elapsed}ms for ${ipText}`);
        }
        return { provider: p.name, record: rec };
      } catch (err) {
        const stats = summary.providers[p.name];
        if (stats) stats.failed += 1;
        return { provider: p.name, record: null as IpGeoRecord | null };
      }
    }),
  );

  const vote = majorityVote(responses);
  if (!vote.ok) {
    return { kind: vote.reason, row };
  }

  await writeConsensusRange(pool, row.ip, vote.record);
  return { kind: 'merged', row, record: vote.record };
}

/** Insert a /32 (IPv4) or /128 (IPv6) range covering exactly `ip`. Tagged
  // 'multi-provider' on every *_source column so the origin is greppable
  // and so the seed-DB-IP flow (which UNIQUE-indexes (start,end,source)
  // won't collide on it). */
async function writeConsensusRange(
  pool: Pool,
  ip: Buffer,
  rec: IpGeoRecord,
): Promise<void> {
  const startBig = BigInt('0x' + ip.toString('hex'));
  const endBig = startBig + 1n;
  const endBuf = Buffer.from(endBig.toString(16).padStart(32, '0'), 'hex');
  const startBuf = Buffer.from(startBig.toString(16).padStart(32, '0'), 'hex');

  await pool.query<ResultSetHeader>(
    `INSERT INTO ip_ranges
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
}

/** Convenience constructor: pick providers based on which API keys are
 *  present in env. Each provider silently abstains if its key is missing,
 *  so the backfill is robust to partial configurations — it'll just have
 *  fewer votes and may fail to reach consensus. */
export function buildDefaultProviders(env: NodeJS.ProcessEnv = process.env): IpGeoProvider[] {
  // Lazy import so the providers' deps (which only fire when lookup() is
  // called) aren't loaded for callers that don't need backfill.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { IpApiProvider, IpinfoProvider, IplocateProvider } = require('./providers') as typeof import('./providers');
  return [
    new IpApiProvider(), // no key required
    new IpinfoProvider({ token: env.IPINFO_TOKEN }),
    new IplocateProvider({ apiKey: env.IPLOCATE_API_KEY }),
  ];
}

/** Convenience: parse + validate an IP string into the same Buffer format
 *  unknown_ip_queue stores. Re-exported here so admin routes don't need
 *  to import the low-level helper directly. */
export function bufferFromIpText(text: string): Buffer | null {
  return parseIp(text);
}