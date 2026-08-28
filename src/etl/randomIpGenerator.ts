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
import { findRange } from '../storage/mysql';
import { touchProviderError, updateProviderConfig } from '../storage/ingestProviders';
import { processIp, type BackfillSummary } from './unknownIpBackfill';

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
  /** Wrote a new /32 range from consensus. */
  merged: number;
  /** No 2/3 country agreement — couldn't merge. */
  noConsensus: number;
  /** Providers didn't return a country at all. */
  noCountry: number;
  /** Every provider abstained (e.g. all 429'd). */
  allAbstained: number;
  /** Random IPs that were already covered by ip_ranges (filtered out). */
  alreadyCovered: number;
  /** Generated IPs but ran out of retries before finding an uncovered one. */
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

  if (picked.ips.length === 0) {
    workSummary.finishedAt = Date.now();
  } else {
    // Step 2: serial fan-out per IP.
    for (const slot of picked.ips) {
      const outcome = await processIp(pool, providers, slot.text, slot.buffer, perIpTimeout, workSummary);
      if (outcome.kind === 'merged') workSummary.merged += 1;
      else if (outcome.kind === 'no_consensus') workSummary.noConsensus += 1;
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
  log.log?.(`[random-gen] ${workSummary.merged}/${workSummary.considered} merged in ${workSummary.finishedAt - startedAt}ms; disabled=${workSummary.providersDisabled.join(',') || 'none'}; exhausted=${exhaustedRetries}`);

  return {
    considered: workSummary.considered,
    merged: workSummary.merged,
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

/** Disable any provider that returned 429 during this run. Same shape
 *  as the backfill's helper but lives here so callers don't need the
 *  queue to trigger auto-disable. */
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
      await touchProviderError(pool, name, `429 rate limited (${stats.rateLimited}x in random-gen)`);
      summary.providersDisabled.push(name);
      console.warn?.(`[random-gen] auto-disabled provider ${name} after ${stats.rateLimited} x 429`);
    } catch (err) {
      console.error?.(`[random-gen] failed to disable ${name}:`, err);
    }
  }
}

/** Generate random IPv4s that don't fall in any existing ip_ranges row.
 *  Uses crypto for unbiased random — Math.random() is fine too but
 *  crypto is one less thing to worry about for repeatable testing.
 *  Only IPv4 — IPv6 has ~100% coverage at country level so the "not
 *  covered" check is mostly pointless there. */
export async function pickRandomIpsNotInRanges(
  pool: Pool,
  count: number,
  maxTriesPerSlot: number = DEFAULT_MAX_TRIES,
): Promise<{ ips: Array<{ text: string; buffer: Buffer }>; exhausted: number; coveredSkips: number }> {
  const out: Array<{ text: string; buffer: Buffer }> = [];
  const seen = new Set<string>(); // dedupe in case RNG lands twice
  let exhausted = 0;
  let coveredSkips = 0;

  for (let i = 0; i < count; i++) {
    let picked: { text: string; buffer: Buffer } | null = null;
    for (let attempt = 0; attempt < maxTriesPerSlot; attempt++) {
      const candidate = randomIpv4();
      if (seen.has(candidate.text)) continue;
      const covered = await findRange(pool, candidate.buffer);
      if (covered === null) {
        seen.add(candidate.text);
        picked = candidate;
        break;
      }
      coveredSkips += 1;
    }
    if (picked === null) {
      exhausted += 1;
      continue;
    }
    out.push(picked);
  }
  return { ips: out, exhausted, coveredSkips };
}

function randomIpv4(): { text: string; buffer: Buffer } {
  // crypto.randomFillSync over 4 bytes gives unbiased 32-bit value.
  const buf = Buffer.alloc(4);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('crypto').randomFillSync(buf);
  // 0.0.0.0 and 255.255.255.255 are reserved; if we land there just
  // pick again — easier than special-casing.
  const allZero = buf[0] === 0 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  const allMax = buf[0] === 255 && buf[1] === 255 && buf[2] === 255 && buf[3] === 255;
  if (allZero || allMax) return randomIpv4();
  return {
    text: `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`,
    buffer: buf,
  };
}

/** Re-export so callers building providers from DB don't need a separate
 *  storage import for the type. */
export type { ProviderConfigRow };
