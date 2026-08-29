// SPDX-License-Identifier: MIT
//
// "Generate N random IPs and ingest them" admin feature.
//
// Flow:
//   1. pickRandomIpsNotInRanges(pool, count) — generates random IPv4s in
//      the full 0.0.0.0/0 space and keeps ones that are NOT covered by
//      any existing ip_ranges row. Retries up to MAX_TRIES_PER_IP times
//      per slot to absorb the ~95% coverage of the public IPv4 space.
//   2. For each picked IP, calls processIp() from unknownIpBackfill —
//      same fan-out + vote + write logic the queue-driven backfill uses,
//      minus the queue-row bookkeeping.
//   3. If any provider returns HTTP 429 it gets auto-disabled in
//      ingest_providers (handled by disableRateLimitedProviders).
//
// Target: 10 IPs in 10 minutes. With 5 providers in parallel the per-IP
// fan-out takes ~2s (the slowest provider), so 10 IPs in 10 minutes
// (avg 60s/IP) is comfortable headroom. We process serially rather than
// in parallel so a single click doesn't burst 50 concurrent provider
// calls — gentler on shared rate limits.
//
// This file deliberately does NOT touch unknown_ip_queue — random IPs
// are NOT queue-bound; they're picked fresh on each click.

import type { Pool } from 'mysql2/promise';
import type { IpGeoProvider } from './providers/types';
import type { ProviderConfigRow } from '../storage/ingestProviders';
import { touchProviderError, updateProviderConfig } from '../storage/ingestProviders';
import { processIp, disableRateLimitedProviders, type BackfillSummary } from './unknownIpBackfill';
import { recordRandomProbe } from '../storage/randomProbeLog';
import { randomUUID } from 'node:crypto';

export interface RandomGenerationOptions {
  /** How many random IPs to pick. Default 10 — the user asked for 10. */
  count?: number;
  /** Per-IP timeout for the fan-out (covers slowest provider). */
  perIpTimeoutMs?: number;
  /** Stop retrying on collision after this many attempts per slot.
   *  Default 50 — should be plenty for 10 IPs in the full IPv4 space
   *  where ~95% of random IPs are already covered. */
  maxTriesPerIp?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface RandomGenerationSummary {
  /** How many unique random IPs we attempted to generate. */
  considered: number;
  /** Wrote a NEW /32 range from consensus (excludes duplicates that
   *  were silently no-op'd by INSERT IGNORE). */
  merged: number;
  /** Reserved-range IP that already existed in ip_ranges from a previous
   *  run — INSERT IGNORE turned it into a no-op. */
  duplicates: number;
  /** No 2/3 country agreement — couldn't merge. */
  noConsensus: number;
  /** Providers didn't return a country at all. */
  noCountry: number;
  /** Every provider abstained (e.g. all 429'd). */
  allAbstained: number;
  /** Random IPs that were already covered by ip_ranges (filtered out).
   *  Always 0 in the reserved-pool flow — findRange would match the
   *  IPv6 catchall for everything. Kept for diagnostic parity with the
   *  backfill summary. */
  alreadyCovered: number;
  /** Generated IPs but ran out of retries before finding an uncovered one.
   *  Always 0 with the reserved-pool design — the pool is ~4.1M IPs. */
  exhaustedRetries: number;
  /** The actual IPs we processed (so the admin can see what we tried). */
  generatedIps: string[];
  /** When the run started. */
  startedAt: number;
  finishedAt: number;
  /** Per-provider call stats. */
  providers: Record<string, { ok: number; failed: number; abstained: number; rateLimited: number }>;
  /** Provider names auto-disabled during this run. */
  providersDisabled: string[];
}

const DEFAULT_COUNT = 10;
const DEFAULT_TIMEOUT = 8_000;
const DEFAULT_MAX_TRIES = 50;

/** Run the random-IP generation flow. Returns a summary so the admin
 *  route can show counts inline. */
export async function runRandomGeneration(
  pool: Pool,
  providers: IpGeoProvider[],
  opts: RandomGenerationOptions = {},
): Promise<RandomGenerationSummary> {
  const count = opts.count ?? DEFAULT_COUNT;
  const perIpTimeout = opts.perIpTimeoutMs ?? DEFAULT_TIMEOUT;
  const maxTries = opts.maxTriesPerIp ?? DEFAULT_MAX_TRIES;
  const log = opts.logger ?? console;

  const startedAt = Date.now();

  // processIp() updates summary.providers in place. We use a BackfillSummary
  // here even though this flow doesn't touch the queue — the fields are
  // the same shape. Convert to RandomGenerationSummary at the end.
  const workSummary: BackfillSummary = {
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

  // Step 1: pick random IPs not in ip_ranges.
  const picked = await pickRandomIpsNotInRanges(pool, count, maxTries);
  workSummary.alreadyCovered = picked.coveredSkips;
  workSummary.considered = picked.ips.length;
  const exhaustedRetries = picked.exhausted;

  let duplicates = 0;
  // One UUID per run groups every probe from this tick. The admin UI's
  // "Recent Probes" table can use it to surface "10 IPs processed at
  // 2026-08-29 12:34:56 UTC" as a logical batch.
  const batchId = randomUUID();

  if (picked.ips.length === 0) {
    workSummary.finishedAt = Date.now();
  } else {
    // Step 2: serial fan-out per IP.
    for (const slot of picked.ips) {
      const result = await processIp(pool, providers, slot.text, slot.buffer, perIpTimeout, workSummary, 'random');
      const outcome = result.outcome;
      const consensus = outcome.kind === 'merged' ? outcome.record : null;
      // Fire-and-forget the per-IP probe audit. Must NEVER poison the
      // run on a write failure — same defensive pattern as recordProviderError.
      recordRandomProbe(pool, {
        ipText: slot.text,
        ipBinary: slot.buffer,
        mode: 'random',
        outcome: outcome.kind,
        consensusCountry: consensus?.countryCode ?? null,
        consensusCity: consensus?.city ?? null,
        consensusAsn: consensus?.asn ?? null,
        mergedRunId: null, // random-gen doesn't write to etl_runs
        providers: result.perProvider,
        batchId,
      }).catch(() => { /* swallow */ });
      if (outcome.kind === 'merged') {
        if (outcome.newlyInserted) workSummary.merged += 1;
        else duplicates += 1;
      } else if (outcome.kind === 'no_consensus') workSummary.noConsensus += 1;
      else if (outcome.kind === 'no_country') workSummary.noCountry += 1;
      else workSummary.allAbstained += 1;
    }
  }

  // Step 3: auto-disable any provider that hit 429.
  await disableRateLimitedProviders(pool, providers, workSummary);
  for (const name of workSummary.providersDisabled) {
    delete workSummary.providers[name];
  }

  workSummary.finishedAt = Date.now();
  log.log?.(`[random-gen] ${workSummary.merged}/${workSummary.considered} merged (${duplicates} duplicates) in ${workSummary.finishedAt - startedAt}ms; disabled=${workSummary.providersDisabled.join(',') || 'none'}; exhausted=${exhaustedRetries}`);

  return {
    considered: workSummary.considered,
    merged: workSummary.merged,
    duplicates,
    noConsensus: workSummary.noConsensus,
    noCountry: workSummary.noCountry,
    allAbstained: workSummary.allAbstained,
    alreadyCovered: workSummary.alreadyCovered,
    exhaustedRetries,
    generatedIps: picked.ips.map((p) => p.text),
    startedAt: workSummary.startedAt,
    finishedAt: workSummary.finishedAt,
    providers: workSummary.providers,
    providersDisabled: workSummary.providersDisabled,
  };
}

/** Generate random IPv4s that don't fall in any existing ip_ranges row.
 *  Uses crypto for unbiased random.
 *
 *  Real-world problem: our ip_ranges includes an IPv6 catchall that
 *  covers the entire IPv4-mapped space (start_ip=0..0 end_ip=0x1FFF..F).
 *  Bytewise comparison in findRange() matches every random IPv4 against
 *  this catchall, so the "not covered" check would always fail.
 *
 *  Workaround: pick from reserved/uncatalogued ranges that no real
 *  commercial IP-geolocation DB covers (RFC 5737 documentation +
 *  RFC 6890 CGNAT). If a candidate from these ranges happens to be
 *  already in ip_ranges (e.g. an admin pre-seeded it), the INSERT in
 *  writeConsensusRange() will fail on the unique index — that's the
 *  "duplicate" path the user asked us to handle ("有则删除" / skip).
 *  processIp() catches the duplicate-key error and the caller marks
 *  it as `no_consensus` rather than aborting the whole run.
 */
export async function pickRandomIpsNotInRanges(
  pool: Pool,
  count: number,
  _maxTriesPerSlot: number = DEFAULT_MAX_TRIES,
): Promise<{ ips: Array<{ text: string; buffer: Buffer }>; exhausted: number; coveredSkips: number }> {
  const out: Array<{ text: string; buffer: Buffer }> = [];
  const seen = new Set<string>();
  let coveredSkips = 0;

  for (let i = 0; i < count; i++) {
    let picked: { text: string; buffer: Buffer } | null = null;
    // Try up to 10 random reserved picks per slot. The reserved pool is
    // ~4.1M addresses, so collisions within a single 10-IP run are
    // effectively impossible. findRange is skipped because the catchall
    // would match every input — see comment block above.
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = randomReservedIpv4();
      if (seen.has(candidate.text)) continue;
      seen.add(candidate.text);
      picked = candidate;
      break;
    }
    if (picked === null) continue; // dedupe exhausted (basically never)
    out.push(picked);
  }
  // coveredSkips is no longer tracked at this layer — the catchall
  // matches every IPv4 so the count would be misleading. Reserved-pool
  // duplicates (if any) surface as INSERT failures downstream.
  return { ips: out, exhausted: 0, coveredSkips };
}

/** RFC 5737 + RFC 6890 (benchmark only) ranges. None of these have
 *  meaningful IP-geo data in any commercial DB; perfect for testing
 *  ingest pipelines.
 *
 *  IMPORTANT: do NOT add ranges that any provider would classify as
 *  "private" — the backfill would record those into ip_ranges and
 *  future /lookups against those IPs would return the geolocation
 *  we voted on, polluting the public-space data with internal/CGNAT
 *  answers. See EXCLUDED_RANGES below for the keep-out list. */
const RESERVED_RANGES: Array<[number, number]> = [
  // RFC 5737 documentation: TEST-NET-1, TEST-NET-2, TEST-NET-3
  [ipToInt('192.0.2.0'),   ipToInt('192.0.2.255')],
  [ipToInt('198.51.100.0'), ipToInt('198.51.100.255')],
  [ipToInt('203.0.113.0'),  ipToInt('203.0.113.255')],
  // RFC 6890 benchmark testing: 198.18.0.0/15
  [ipToInt('198.18.0.0'),   ipToInt('198.19.255.255')],
];

/** Ranges we MUST NOT generate, even if they look "reserved" by IANA.
 *  Providers treat any IP in these ranges as private/non-routable and
 *  return country=null or country=US (geo location for the operator's
 *  country) — ingesting those would write misleading rows.
 *
 *  - 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 — RFC 1918 private
 *  - 127.0.0.0/8 — loopback
 *  - 169.254.0.0/16 — link-local
 *  - 100.64.0.0/10 — RFC 6598 shared address space (CGNAT)
 *  - 224.0.0.0/4 — multicast
 *  - 240.0.0.0/4 — reserved (includes 255.255.255.255 broadcast) */
const EXCLUDED_RANGES: Array<[number, number]> = [
  [ipToInt('10.0.0.0'),     ipToInt('10.255.255.255')],
  [ipToInt('100.64.0.0'),   ipToInt('100.127.255.255')],
  [ipToInt('127.0.0.0'),    ipToInt('127.255.255.255')],
  [ipToInt('169.254.0.0'),  ipToInt('169.254.255.255')],
  [ipToInt('172.16.0.0'),   ipToInt('172.31.255.255')],
  [ipToInt('192.168.0.0'),  ipToInt('192.168.255.255')],
  [ipToInt('224.0.0.0'),    ipToInt('239.255.255.255')],
  [ipToInt('240.0.0.0'),    ipToInt('255.255.255.255')],
];

/** True iff `n` (a 32-bit unsigned integer form of an IPv4) falls in any
 *  EXCLUDED_RANGES entry. Used as a defensive check after picking. */
function isInExcludedRange(n: number): boolean {
  // Linear scan — list is short, called once per pick.
  for (const [lo, hi] of EXCLUDED_RANGES) {
    if (n >= lo && n <= hi) return true;
  }
  return false;
}

function randomReservedIpv4(): { text: string; buffer: Buffer } {
  // Try up to a small handful of times in case future ranges are added
  // that accidentally overlap an excluded one. With the current
  // RESERVED_RANGES (which are already vetted) this loop always exits
  // on the first iteration.
  for (let attempt = 0; attempt < 16; attempt++) {
    const [lo, hi] = RESERVED_RANGES[Math.floor(Math.random() * RESERVED_RANGES.length)]!;
    const span = hi - lo + 1;
    const offset = Math.floor(Math.random() * span);
    const n = lo + offset;
    if (isInExcludedRange(n)) continue;
    const b0 = (n >>> 24) & 0xff;
    const b1 = (n >>> 16) & 0xff;
    const b2 = (n >>> 8) & 0xff;
    const b3 = n & 0xff;
    const buf = Buffer.from([b0, b1, b2, b3]);
    return {
      text: `${b0}.${b1}.${b2}.${b3}`,
      buffer: buf,
    };
  }
  // Should be unreachable given current RESERVED_RANGES (none overlap
  // EXCLUDED_RANGES). If a future change adds overlap, throw so the
  // problem is caught loudly rather than silently producing private IPs.
  throw new Error('randomReservedIpv4: all picks fell in EXCLUDED_RANGES — RESERVED_RANGES needs review');
}

function ipToInt(s: string): number {
  const parts = s.split('.').map(Number);
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;
  const d = parts[3] ?? 0;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** Re-export so callers building providers from DB don't need a separate
 *  storage import for the type. */
export type { ProviderConfigRow };
