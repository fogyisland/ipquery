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

import type { Pool, RowDataPacket } from "mysql2/promise";
import type { ResultSetHeader } from "mysql2/promise";
import { nextBatch, markProcessed, markAttempted, type UnknownIpRow } from "../storage/unknownIpQueue";
import type { IpGeoProvider, IpGeoLookupResult, IpGeoRecord } from "./providers/types";
import type { ProviderConfigRow } from "../storage/ingestProviders";
import { touchProviderError, touchProviderCalled, updateProviderConfig } from "../storage/ingestProviders";
import { recordProviderError, getCircuitBreakerConfig } from "../storage/providerErrorLog";
import { majorityVote } from "./majority";
import { parseIp } from "../ip";
import { recordRandomProbe, type PerProviderDetail } from "../storage/randomProbeLog";
import { providerFanoutLock, type ProviderLock } from "./providerLock";
import { randomUUID } from "node:crypto";

export interface BackfillOptions {
  /** How many IPs to pull per run. Each IP fans out to all providers so
   *  effective provider-call count is `batchLimit * providers.length`. */
  batchLimit?: number;
  /** Per-IP timeout for the fan-out (covers slowest provider). */
  perIpTimeoutMs?: number;
  /** Which flow triggered this run. Recorded into provider_error_log so
   *  the Failure Logs tab can filter by trigger source. Defaults to
   *  'auto' (queue-driven backfill). */
  mode?: "auto" | "manual" | "random";
  /** When true, skip all writes (ip_ranges INSERT + queue mark
   *  processed/attempted). Used by the preview-before-commit admin flow
   *  so operators can review consensus results before any row lands in
   *  the main table. Defaults to false (existing behavior). */
  dryRun?: boolean;
  /** The provider-fan-out mutex to use. Defaults to the shared
   *  instance so the backfill route, the manual-generate button and
   *  the continuous runner can't all hammer the same free-tier quota at
   *  once. Tests can pass their own lock to stay isolated. */
  lock?: ProviderLock;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

/** One row of preview output — what would happen for this IP if the
 *  operator confirms the run. Per-provider detail is reduced to the
 *  minimum the admin UI needs (name / ok flag / country / errorCode). */
export interface BackfillPreviewRow {
  ipText: string;
  /** Null when the IP did not reach consensus / had no country. */
  countryCode: string | null;
  city: string | null;
  asn: number | string | null;
  /** Final per-IP outcome from majorityVote / write path. */
  outcome: "merged" | "no_consensus" | "no_country" | "all_abstained";
  perProvider: Array<{ name: string; ok: boolean; country: string | null; errorCode: string | null }>;
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
  /** 'preview' when dryRun=true (no writes happened). 'committed' on
   *  a normal run. Existing callers (random-gen, cron) always see
   *  'committed'. */
  mode: "preview" | "committed";
  /** Per-IP preview rows. Populated when mode === 'preview'; empty
   *  array on committed runs to keep the shape stable. */
  previewRows: BackfillPreviewRow[];
  /** True when the run was skipped because another provider fan-out was
   *  already in flight (the shared provider mutex was busy). The run
   *  performed NO provider calls and NO writes — every counter stays
   *  at zero and `startedAt === finishedAt`. The admin UI surfaces this
   *  as "another ingest run was already in progress". */
  skippedLockBusy?: boolean;
}

const DEFAULT_BATCH = 100;
const DEFAULT_TIMEOUT = 8_000;

/** Per-IP outcome returned by processIp. `merged` carries `newlyInserted`
 *  so the random-IP flow can tell genuinely-new rows apart from
 *  duplicates-that-were-ignored. Backfill doesn't care about the
 *  distinction (queue rows are unique by construction). */
export type IpOutcome =
  | { kind: "merged"; record: IpGeoRecord; newlyInserted: boolean }
  | { kind: "no_consensus" }
  | { kind: "no_country" }
  | { kind: "all_abstained" };

/** Returned by processIp alongside the outcome. Carries the per-provider
 *  detail so the caller (random-gen flow, manual-generate, backfill) can
 *  record a self-contained row into random_probe_log without re-running
 *  any provider call. */
export interface ProcessIpResult {
  outcome: IpOutcome;
  perProvider: PerProviderDetail[];
}

export async function runBackfill(
  pool: Pool,
  providers: IpGeoProvider[],
  opts: BackfillOptions = {},
): Promise<BackfillSummary> {
  const batchLimit = opts.batchLimit ?? DEFAULT_BATCH;
  const perIpTimeout = opts.perIpTimeoutMs ?? DEFAULT_TIMEOUT;
  const log = opts.logger ?? console;

  const startedAt = Date.now();
  const dryRun = opts.dryRun ?? false;
  const summary: BackfillSummary = {
    considered: 0,
    merged: 0,
    noConsensus: 0,
    noCountry: 0,
    allAbstained: 0,
    alreadyCovered: 0,
    startedAt,
    finishedAt: 0,
    providers: Object.fromEntries(
      providers.map((p) => [p.name, { ok: 0, failed: 0, abstained: 0, rateLimited: 0 }]),
    ),
    providersDisabled: [],
    mode: dryRun ? "preview" : "committed",
    previewRows: [],
  };
  // Mode is threaded through to processIp so failure rows carry the
  // right tag in provider_error_log. Defaults to 'auto' (queue backfill).
  const runMode = opts.mode ?? "auto";

  const queueRows = await nextBatch(pool, batchLimit);
  summary.considered = queueRows.length;
  if (queueRows.length === 0) {
    summary.finishedAt = Date.now();
    return summary;
  }

  // One batchId per run groups every probe from this tick for the admin UI.
  const batchId = randomUUID();

  // Take the shared provider-fan-out mutex. If another ingest path is
  // already calling the external providers, skip this run entirely —
  // no provider calls, no writes. Running concurrently would double the
  // request rate against a shared free-tier quota.
  const lock = opts.lock ?? providerFanoutLock;
  const attempt = lock.tryAcquire();
  if (!attempt.acquired) {
    summary.finishedAt = Date.now();
    summary.skippedLockBusy = true;
    // The queue rows were read before we took the lock, but this run
    // considered nothing — reset the counter so the UI doesn't report
    // "1 candidate" for a run that made zero provider calls. The rows
    // are untouched (not marked processed/attempted), so the next run
    // picks them up again.
    summary.considered = 0;
    log.warn?.(
      "[backfill] skipped — another provider fan-out is already in flight; " + "no provider calls were made",
    );
    return summary;
  }

  try {
    return await runBackfillLocked(
      pool,
      providers,
      queueRows,
      summary,
      opts,
      runMode,
      dryRun,
      perIpTimeout,
      batchId,
      log,
    );
  } finally {
    lock.release();
  }
}

/** The provider-calling body of runBackfill. Runs with the shared
 *  provider mutex already held by the caller. Split out so the lock's
 *  acquire/release pair wraps exactly the fan-out + write section and
 *  the queue read stays outside it. */
async function runBackfillLocked(
  pool: Pool,
  providers: IpGeoProvider[],
  queueRows: UnknownIpRow[],
  summary: BackfillSummary,
  opts: BackfillOptions,
  runMode: "auto" | "manual" | "random",
  dryRun: boolean,
  perIpTimeout: number,
  batchId: string,
  log: Pick<Console, "log" | "warn" | "error">,
): Promise<BackfillSummary> {
  const startedAt = summary.startedAt;

  const outcomes: Array<{ row: UnknownIpRow; outcome: IpOutcome }> = [];

  // Fan out all IPs concurrently, but cap concurrency at 16 to avoid
  // hammering the providers (and our own DB connection pool) in one go.
  const CONCURRENCY = 16;
  for (let i = 0; i < queueRows.length; i += CONCURRENCY) {
    const slice = queueRows.slice(i, i + CONCURRENCY);
    const sliceOutcomes = await Promise.all(
      slice.map(async (row) => {
        const result = await processIp(
          pool,
          providers,
          row.ipText,
          row.ip,
          perIpTimeout,
          summary,
          runMode,
          dryRun,
        );
        const outcome = result.outcome;
        const consensus = outcome.kind === "merged" ? outcome.record : null;
        // Fire-and-forget probe audit. Same defensive pattern as
        // recordProviderError above — a write failure must never poison
        // the backfill loop.
        recordRandomProbe(pool, {
          ipText: row.ipText,
          ipBinary: row.ip,
          mode: runMode,
          outcome: outcome.kind,
          consensusCountry: consensus?.countryCode ?? null,
          consensusCity: consensus?.city ?? null,
          consensusAsn: consensus?.asn ?? null,
          mergedRunId: outcome.kind === "merged" ? null : null, // no etl_runs row for backfill
          providers: result.perProvider,
          batchId,
        }).catch(() => {
          /* swallow */
        });
        // Preview rows: only populated when dryRun=true. We capture
        // per-IP detail for the admin to review before confirming.
        if (dryRun) {
          summary.previewRows.push({
            ipText: row.ipText,
            countryCode: consensus?.countryCode ?? null,
            city: consensus?.city ?? null,
            asn: consensus?.asn ?? null,
            outcome: outcome.kind,
            perProvider: result.perProvider.map((p) => ({
              name: p.provider,
              // 'ok' = provider returned a non-null record (regardless
              // of whether it agreed with the majority). A 429 or
              // network error sets ok=false.
              ok: p.countryCode !== null && !p.rateLimited && !p.errorCode,
              country: p.countryCode ?? null,
              errorCode: p.errorCode ?? (p.rateLimited ? "429" : null),
            })),
          });
        }
        return { row, outcome };
      }),
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
    no_consensus: [],
    no_country: [],
    all_abstained: [],
  };
  for (const { row, outcome } of outcomes) {
    if (outcome.kind === "merged") {
      mergedIds.push(row.id);
      summary.merged += 1;
    } else {
      attempted[outcome.kind].push(row.id);
      if (outcome.kind === "no_consensus") summary.noConsensus += 1;
      else if (outcome.kind === "no_country") summary.noCountry += 1;
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
    // Skip in dry-run mode: processIp's INSERT IGNORE was a no-op too,
    // so we must not mutate the queue rows or they'd get stuck in the
    // 'attempted' state without an actual run.
    if (!dryRun) await markProcessed(pool, mergedIds, 0);
  }
  if (!dryRun) {
    if (attempted.no_consensus.length > 0) await markAttempted(pool, attempted.no_consensus, "no_consensus");
    if (attempted.no_country.length > 0) await markAttempted(pool, attempted.no_country, "no_country");
    if (attempted.all_abstained.length > 0)
      await markAttempted(pool, attempted.all_abstained, "all_abstained");
  }

  summary.finishedAt = Date.now();
  log.log?.(
    `[backfill] ${summary.merged}/${summary.considered} merged in ${summary.finishedAt - startedAt}ms; disabled=${summary.providersDisabled.join(",") || "none"}${dryRun ? " [DRY-RUN]" : ""}`,
  );
  return summary;
}

/** Per-IP fan-out + vote + write. Used by both the queue-driven backfill
 *  and the random-IP generator. Updates `summary.providers[name]` stats
 *  in place. Returns the outcome so the caller can track it.
 *
 *  Each non-OK per-provider call is recorded into provider_error_log so
 *  the Failure Logs tab can audit exactly what failed and why. The
 *  record is fire-and-forget — a failure to log must not poison the
 *  vote. */
export async function processIp(
  pool: Pool,
  providers: IpGeoProvider[],
  ipText: string,
  ipBuffer: Buffer,
  _perIpTimeoutMs: number,
  summary: BackfillSummary,
  mode: "auto" | "manual" | "random" = "auto",
  dryRun: boolean = false,
): Promise<ProcessIpResult> {
  // Collect per-provider detail for the probe log alongside the
  // vote-shape we feed into majorityVote. The two arrays share the same
  // providers in the same order, so zip by index.
  const perProvider: PerProviderDetail[] = [];
  const responses: Array<{ provider: string; record: IpGeoRecord | null; rateLimited: boolean }> =
    await Promise.all(
      providers.map(async (p) => {
        const start = Date.now();
        let result: IpGeoLookupResult;
        try {
          result = await p.lookup(ipText);
        } catch (err) {
          const stats = summary.providers[p.name];
          if (stats) stats.failed += 1;
          const msg = err instanceof Error ? err.message : String(err);
          const code = msg.includes("timeout") || msg.includes("aborted") ? "timeout" : "network";
          // Fire-and-forget; logging failures shouldn't break the backfill.
          recordProviderError(pool, {
            providerName: p.name,
            ipText,
            mode,
            errorCode: code,
            reason: `lookup() threw: ${msg.slice(0, 200)}`,
            rawResponse: null,
          }).catch(() => {
            /* swallow */
          });
          // Fire-and-forget the per-provider, per-UTC-day counter. Same
          // defensive .catch — a DB write failure must never poison the
          // fan-out loop.
          touchProviderCalled(pool, p.name, { rateLimited: false, errorCode: code }).catch(() => {
            /* swallow */
          });
          const elapsed = Date.now() - start;
          perProvider.push({
            provider: p.name,
            countryCode: null,
            city: null,
            asn: null,
            rateLimited: false,
            errorCode: code,
            durationMs: elapsed,
            rawResponse: null,
          });
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
        // Fire-and-forget the per-provider, per-UTC-day counter. Same
        // defensive .catch — covers rateLimited, errored, AND successful
        // responses (so the "calls_total" widget reflects real traffic,
        // not just failures).
        touchProviderCalled(pool, p.name, {
          rateLimited: result.rateLimited,
          errorCode: result.errorCode,
        }).catch(() => {
          /* swallow */
        });
        // Record every non-OK, non-abstain call (i.e. providers that returned
        // an explicit errorCode) into the failure log. We skip abstains
        // (provider returned no record, no errorCode) because they reflect
        // "this IP has no data" — not a provider fault.
        if (!result.rateLimited && !result.record && result.errorCode) {
          const reason =
            result.errorCode === "no_country"
              ? `provider returned no country code for ${ipText}`
              : `${result.errorCode}: ${(result.rawResponse ?? "").slice(0, 180) || "(no body)"}`;
          recordProviderError(pool, {
            providerName: p.name,
            ipText,
            mode,
            errorCode: result.errorCode,
            reason: reason.slice(0, 255),
            rawResponse: result.rawResponse ?? null,
          }).catch(() => {
            /* swallow */
          });
        }
        perProvider.push({
          provider: p.name,
          countryCode: result.record?.countryCode ?? null,
          city: result.record?.city ?? null,
          asn: result.record?.asn ?? null,
          rateLimited: result.rateLimited,
          errorCode: result.errorCode ?? null,
          durationMs: elapsed,
          rawResponse: result.rawResponse ?? null,
        });
        return { provider: p.name, record: result.record, rateLimited: result.rateLimited };
      }),
    );

  const vote = majorityVote(responses);
  if (!vote.ok) {
    return { outcome: { kind: vote.reason }, perProvider };
  }

  // In dry-run mode, skip the actual INSERT and report `newlyInserted`
  // as if the row would be written. The caller can still render
  // summary.previewRows knowing each would-be-merged /32.
  if (dryRun) {
    return { outcome: { kind: "merged", record: vote.record, newlyInserted: true }, perProvider };
  }
  const newlyInserted = await writeConsensusRange(pool, ipBuffer, vote.record);
  return { outcome: { kind: "merged", record: vote.record, newlyInserted }, perProvider };
}

/** Disable any provider whose rateLimited counter > 0. Idempotent. Also
 *  consults the circuit-breaker config: when the failure rate (non-ok
 *  outcomes / total) over the configured window exceeds the threshold,
 *  the provider is auto-disabled even without a 429. The breaker reads
 *  the persisted `provider_error_log` for a sliding-window check. */
export async function disableRateLimitedProviders(
  pool: Pool,
  providers: IpGeoProvider[],
  summary: BackfillSummary,
): Promise<void> {
  const liveProviders = new Set(providers.map((p) => p.name));
  // Read the breaker config ONCE per run — it's stable for the duration.
  const cb = await getCircuitBreakerConfig(pool);
  for (const [name, stats] of Object.entries(summary.providers)) {
    if (!liveProviders.has(name)) continue;
    if (summary.providersDisabled.includes(name)) continue;
    let shouldDisable = false;
    let reason = "";
    if (stats.rateLimited > 0) {
      shouldDisable = true;
      reason = `429 rate limited (${stats.rateLimited}x in this run)`;
    } else if (cb.enabled) {
      // Count failures for this provider over the sliding window.
      const total = stats.ok + stats.failed + stats.abstained;
      const failures = stats.failed;
      const rate = total > 0 ? (failures / total) * 100 : 0;
      if (total >= 5 && rate >= cb.failureThresholdPct) {
        shouldDisable = true;
        reason = `circuit breaker: ${Math.round(rate)}% failure rate (${failures}/${total} in run, threshold ${cb.failureThresholdPct}%)`;
      } else {
        // Cross-window check via provider_error_log — only fires when the
        // run had too few calls for a clean local decision.
        const windowTotal = await countProviderCallsInWindow(pool, name, cb.windowMinutes);
        const windowFailed = await countProviderFailuresInWindow(pool, name, cb.windowMinutes);
        if (windowTotal >= 10) {
          const winRate = (windowFailed / windowTotal) * 100;
          if (winRate >= cb.failureThresholdPct) {
            shouldDisable = true;
            reason = `circuit breaker: ${Math.round(winRate)}% failure rate (${windowFailed}/${windowTotal} in ${cb.windowMinutes}m window, threshold ${cb.failureThresholdPct}%)`;
          }
        }
      }
    }
    if (!shouldDisable) continue;
    try {
      const autoReenableAt = new Date(Date.now() + cb.cooldownMinutes * 60_000);
      // Single UPDATE write: enabled=0, auto_reenable_at=now+cooldown,
      // auto_disabled_reason=reason. The reaper (see
      // randomIpGeneratorRunner.reapProviders) flips back to enabled=1
      // once auto_reenable_at <= NOW(3).
      await updateProviderConfig(pool, name, {
        enabled: false,
        autoReenableAt,
        autoDisabledReason: reason,
      });
      // Keep touchProviderError around — UI cells ("Last error" /
      // "Last error reason") read from last_error_at + last_error_reason
      // and don't auto-clear like auto_disabled_reason would. Keeping
      // both stores lets the UI choose which surface to render.
      await touchProviderError(pool, name, reason);
      summary.providersDisabled.push(name);
      console.warn?.(
        `[backfill] auto-disabled provider ${name}: ${reason} (re-enable in ${cb.cooldownMinutes}m)`,
      );
    } catch (err) {
      console.error?.(`[backfill] failed to disable ${name}:`, err);
    }
  }
}

async function countProviderCallsInWindow(
  pool: Pool,
  providerName: string,
  windowMinutes: number,
): Promise<number> {
  // Denominator for the circuit-breaker failure-rate calculation. Uses
  // provider_call_counter (which records EVERY call — ok, 429, timeout,
  // network, other) rather than provider_error_log (which only records
  // errored calls). Reading total = error count previously caused the
  // rate to compute as 100% whenever any error existed in the window.
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(calls_total), 0) AS total
       FROM provider_call_counter
      WHERE provider_name = ?
        AND day_utc >= (UTC_DATE() - INTERVAL ? DAY)`,
    [providerName, Math.max(1, Math.ceil(windowMinutes / (24 * 60)))],
  );
  return Number(rows[0]?.total ?? 0);
}

async function countProviderFailuresInWindow(
  pool: Pool,
  providerName: string,
  windowMinutes: number,
): Promise<number> {
  // Numerator for the circuit-breaker. Sums calls_429 + calls_timeout +
  // calls_network_err + calls_other_err across the window. Note: abstains
  // (e.g. 'no_country' which the provider returns as a 200 with no data)
  // are NOT counted as failures — they're tracked separately in
  // calls_other_err at the touchProviderCalled level but here we treat
  // them as "did not produce a result, did not error" and exclude them.
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COALESCE(SUM(calls_429 + calls_timeout + calls_network_err), 0) AS total
       FROM provider_call_counter
      WHERE provider_name = ?
        AND day_utc >= (UTC_DATE() - INTERVAL ? DAY)`,
    [providerName, Math.max(1, Math.ceil(windowMinutes / (24 * 60)))],
  );
  return Number(rows[0]?.total ?? 0);
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
async function writeConsensusRange(pool: Pool, ip: Buffer, rec: IpGeoRecord): Promise<boolean> {
  const startBig = BigInt("0x" + ip.toString("hex"));
  const endBig = startBig + 1n;
  const endBuf = Buffer.from(endBig.toString(16).padStart(32, "0"), "hex");
  const startBuf = Buffer.from(startBig.toString(16).padStart(32, "0"), "hex");

  const [res] = await pool.query<ResultSetHeader>(
    `INSERT IGNORE INTO ip_ranges
       (start_ip, end_ip, range_size, country_code, country_name, region, city,
        latitude, longitude, timezone, isp, asn, asn_org,
        country_source, city_source, isp_source, asn_source, geo_source)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider', 'multi-provider')`,
    [
      startBuf,
      endBuf,
      rec.countryCode,
      rec.countryName,
      rec.region,
      rec.city,
      rec.latitude,
      rec.longitude,
      rec.timezone,
      rec.isp,
      rec.asn,
      rec.asnOrg,
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
  const { IpApiProvider, IpinfoProvider, IplocateProvider, FreeIpApiProvider, IpapiCoProvider } =
    require("./providers") as typeof import("./providers");
  return [
    new IpApiProvider(), // no key required, 45/min HTTP
    new IpinfoProvider({ token: env.IPINFO_TOKEN }), // key optional, 50k/month HTTPS
    new IplocateProvider({ apiKey: env.IPLOCATE_API_KEY }), // key optional, 1k/day HTTPS
    new FreeIpApiProvider(), // no key, 60/min HTTPS
    new IpapiCoProvider(), // no key, 30k/month HTTPS
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
