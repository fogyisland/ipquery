// SPDX-License-Identifier: MIT
//
// random_probe_log: per-IP audit trail for the API ingest flows
// (runBackfill, runRandomGeneration, manual-generate). Read by the
// /admin/unknown-ips Overview tab "Recent Probes" table; written by the
// call sites of processIp via recordRandomProbe(). See migration 018.

import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getSetting, setSetting } from "./settings";

// ─── Per-provider detail (one slice of providers_json) ────────────────

export interface PerProviderDetail {
  provider: string;
  countryCode: string | null;
  city: string | null;
  asn: number | null;
  rateLimited: boolean;
  errorCode: string | null;
  durationMs: number;
  rawResponse: string | null;
}

// ─── Row shape (read path) ────────────────────────────────────────────

export interface RandomProbeRow {
  id: number;
  ipText: string;
  mode: "auto" | "manual" | "random";
  outcome: "merged" | "no_consensus" | "no_country" | "all_abstained";
  consensusCountry: string | null;
  consensusCity: string | null;
  consensusAsn: number | null;
  mergedRunId: number | null;
  providers: PerProviderDetail[];
  batchId: string | null;
  ts: Date;
}

export interface RandomProbeFilter {
  mode?: "auto" | "manual" | "random";
  outcome?: "merged" | "no_consensus" | "no_country" | "all_abstained";
  limit?: number;
}

// ─── Insert path ──────────────────────────────────────────────────────

export interface RandomProbeInsert {
  ipText: string;
  ipBinary: Buffer;
  mode: "auto" | "manual" | "random";
  outcome: "merged" | "no_consensus" | "no_country" | "all_abstained";
  consensusCountry: string | null;
  consensusCity: string | null;
  consensusAsn: number | null;
  mergedRunId: number | null;
  providers: PerProviderDetail[];
  batchId: string | null;
}

function rowToProbe(r: RowDataPacket): RandomProbeRow {
  let providers: PerProviderDetail[] = [];
  if (r.providers_json) {
    try {
      const parsed = JSON.parse(String(r.providers_json));
      if (Array.isArray(parsed)) providers = parsed as PerProviderDetail[];
    } catch {
      /* malformed JSON → empty array, surface the row anyway */
    }
  }
  return {
    id: Number(r.id),
    ipText: String(r.ip_text),
    mode: String(r.mode) as RandomProbeRow["mode"],
    outcome: String(r.outcome) as RandomProbeRow["outcome"],
    consensusCountry: r.consensus_country == null ? null : String(r.consensus_country),
    consensusCity: r.consensus_city == null ? null : String(r.consensus_city),
    consensusAsn: r.consensus_asn == null ? null : Number(r.consensus_asn),
    mergedRunId: r.merged_run_id == null ? null : Number(r.merged_run_id),
    providers,
    batchId: r.batch_id == null ? null : String(r.batch_id),
    ts: new Date(r.ts),
  };
}

export async function recordRandomProbe(pool: Pool, row: RandomProbeInsert): Promise<void> {
  await pool.query(
    `INSERT INTO random_probe_log
       (ip_text, ip_binary, mode, outcome, consensus_country, consensus_city,
        consensus_asn, merged_run_id, providers_json, batch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.ipText,
      row.ipBinary,
      row.mode,
      row.outcome,
      row.consensusCountry,
      row.consensusCity,
      row.consensusAsn,
      row.mergedRunId,
      JSON.stringify(row.providers),
      row.batchId,
    ],
  );
}

export async function recentProbes(pool: Pool, filter: RandomProbeFilter = {}): Promise<RandomProbeRow[]> {
  const whereArr: string[] = [];
  const args: unknown[] = [];
  if (filter.mode) {
    whereArr.push("mode = ?");
    args.push(filter.mode);
  }
  if (filter.outcome) {
    whereArr.push("outcome = ?");
    args.push(filter.outcome);
  }
  const limit = Math.min(filter.limit ?? 20, 100);
  const sql = `SELECT id, ip_text, mode, outcome, consensus_country, consensus_city,
                      consensus_asn, merged_run_id, providers_json, batch_id, ts
                 FROM random_probe_log
                ${whereArr.length ? "WHERE " + whereArr.join(" AND ") : ""}
                ORDER BY ts DESC, id DESC
                LIMIT ${limit}`;
  const [rows] = await pool.query<RowDataPacket[]>(sql, args);
  return rows.map(rowToProbe);
}

// ─── Summary stats for the scheduler card ─────────────────────────────

export interface ProbeSummaryStats {
  /** Total probes in the window. */
  total: number;
  /** Probes whose outcome was 'merged'. */
  merged: number;
  /** Probes whose outcome was 'no_consensus'. */
  noConsensus: number;
  /** Probes whose outcome was 'no_country'. */
  noCountry: number;
  /** Probes whose outcome was 'all_abstained'. */
  allAbstained: number;
  /** merged / total — rounded to nearest integer for display. */
  successRatePct: number;
  /** Approximate IPs/day projected from the window. Window is typically
   *  1h, so we multiply by 24. */
  warmingRatePerDay: number;
  /** Per-provider breakdown from the same window. Each provider's
   *  counters reflect only the probes within the window, parsed from
   *  each row's providers_json. Used by the metrics row's per-provider
   *  badges. */
  byProvider: Record<
    string,
    { ok: number; rateLimited: number; timeout: number; noCountry: number; error: number }
  >;
}

/** Compute summary stats over the trailing `windowMs` window (default
 *  1h). Walks providers_json for each row to attribute per-provider
 *  counters. Volume assumption: a 1h window returns at most a few
 *  hundred rows (well below the ~70k/day cap), so the in-process
 *  aggregation is cheap. */
export async function probeSummaryStats(
  pool: Pool,
  windowMs: number = 60 * 60 * 1000,
): Promise<ProbeSummaryStats> {
  const sinceMs = Date.now() - windowMs;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT outcome, providers_json
       FROM random_probe_log
      WHERE ts >= FROM_UNIXTIME(? / 1000)`,
    [sinceMs],
  );
  const stats: ProbeSummaryStats = {
    total: rows.length,
    merged: 0,
    noConsensus: 0,
    noCountry: 0,
    allAbstained: 0,
    successRatePct: 0,
    warmingRatePerDay: 0,
    byProvider: {},
  };
  for (const r of rows) {
    const outcome = String(r.outcome);
    if (outcome === "merged") stats.merged += 1;
    else if (outcome === "no_consensus") stats.noConsensus += 1;
    else if (outcome === "no_country") stats.noCountry += 1;
    else if (outcome === "all_abstained") stats.allAbstained += 1;
    let providers: PerProviderDetail[] = [];
    if (r.providers_json) {
      try {
        const parsed = JSON.parse(String(r.providers_json));
        if (Array.isArray(parsed)) providers = parsed as PerProviderDetail[];
      } catch {
        /* skip */
      }
    }
    for (const pp of providers) {
      const slot = stats.byProvider[pp.provider] ?? {
        ok: 0,
        rateLimited: 0,
        timeout: 0,
        noCountry: 0,
        error: 0,
      };
      if (pp.rateLimited) slot.rateLimited += 1;
      else if (pp.errorCode === "timeout") slot.timeout += 1;
      else if (pp.errorCode === "no_country") slot.noCountry += 1;
      else if (pp.errorCode) slot.error += 1;
      else slot.ok += 1;
      stats.byProvider[pp.provider] = slot;
    }
  }
  stats.successRatePct = stats.total > 0 ? Math.round((stats.merged / stats.total) * 100) : 0;
  // Project window rate to 24h. Rounded to 1 decimal for the UI.
  const hours = windowMs / (60 * 60 * 1000);
  stats.warmingRatePerDay = hours > 0 ? Math.round((stats.total / hours) * 24) : 0;
  return stats;
}

// ─── Continuous-ingest scheduler config ───────────────────────────────

export interface RandomGenConfig {
  intervalSec: number;
  batchSize: number;
  cooldownMinutes: number;
  cbLinkage: boolean;
}

/**
 * One run every three minutes — twenty an hour.
 *
 * The cadence is a quota decision, not a performance one. Four providers at
 * 45-100 calls a minute each sounds generous, but the limits are per
 * calendar minute and a run now asks ONE provider per IP: twenty runs an
 * hour is twenty provider calls an hour per source at a batch size of one,
 * which leaves the free tiers untouched for the queue-driven backfill.
 *
 * The previous default (60s, batch 10) was 600 IPs an hour against every
 * provider — enough to drain a free tier before the backfill that actually
 * needs the votes got a turn.
 */
const DEFAULT_CONFIG: RandomGenConfig = {
  intervalSec: 180,
  batchSize: 1,
  cooldownMinutes: 15,
  cbLinkage: true,
};

/** Twenty runs an hour, expressed as the interval the runner uses. */
export const RANDOM_GEN_RUNS_PER_HOUR = 20;
export const RANDOM_GEN_INTERVAL_SEC = 3600 / RANDOM_GEN_RUNS_PER_HOUR;

export async function loadRandomGenConfig(pool: Pool): Promise<RandomGenConfig> {
  const [intervalRaw, batchRaw, cooldownRaw, cbRaw] = await Promise.all([
    getSetting(pool, "random_gen_interval_sec"),
    getSetting(pool, "random_gen_batch_size"),
    getSetting(pool, "random_gen_cooldown_minutes"),
    getSetting(pool, "random_gen_cb_linkage"),
  ]);
  return {
    // Floor of 60s: anything faster is a burst the free tiers will answer
    // with 429s. Ceiling of an hour: slower than that and the "continuous"
    // runner is indistinguishable from a manual click.
    intervalSec:
      intervalRaw === null
        ? DEFAULT_CONFIG.intervalSec
        : Math.min(3600, Math.max(60, Number(intervalRaw) || DEFAULT_CONFIG.intervalSec)),
    // Capped at 20: each IP costs one provider call, and a large batch
    // turns one tick into the kind of burst the per-minute limiter exists
    // to prevent.
    batchSize:
      batchRaw === null
        ? DEFAULT_CONFIG.batchSize
        : Math.min(20, Math.max(1, Number(batchRaw) || DEFAULT_CONFIG.batchSize)),
    cooldownMinutes:
      cooldownRaw === null
        ? DEFAULT_CONFIG.cooldownMinutes
        : Math.min(1440, Math.max(0, Number(cooldownRaw) || DEFAULT_CONFIG.cooldownMinutes)),
    cbLinkage: cbRaw === null ? DEFAULT_CONFIG.cbLinkage : cbRaw === "1",
  };
}

export interface RandomGenConfigUpdate {
  intervalSec?: number;
  batchSize?: number;
  cooldownMinutes?: number;
  cbLinkage?: boolean;
}

export async function saveRandomGenConfig(pool: Pool, patch: RandomGenConfigUpdate): Promise<void> {
  if (patch.intervalSec !== undefined) {
    const clamped = Math.min(3600, Math.max(1, Math.round(patch.intervalSec)));
    await setSetting(pool, "random_gen_interval_sec", String(clamped));
  }
  if (patch.batchSize !== undefined) {
    const clamped = Math.min(100, Math.max(1, Math.round(patch.batchSize)));
    await setSetting(pool, "random_gen_batch_size", String(clamped));
  }
  if (patch.cooldownMinutes !== undefined) {
    const clamped = Math.min(1440, Math.max(0, Math.round(patch.cooldownMinutes)));
    await setSetting(pool, "random_gen_cooldown_minutes", String(clamped));
  }
  if (patch.cbLinkage !== undefined) {
    await setSetting(pool, "random_gen_cb_linkage", patch.cbLinkage ? "1" : "0");
  }
}

// ─── Retention ─────────────────────────────────────────────────────────
//
// random_probe_log grows ~20k rows/day at worst case (see migration 018's
// volume note). Without a sweep the table grows unbounded — at 20k/day
// that's 7.3M rows/year, and the table stores a providers_json blob per
// row, so it grows faster than the row count suggests.
//
// The sweep keeps a trailing window (default 30 days) and deletes
// anything older. It is a single indexed DELETE by ts — the table has a
// ts index (migration 018) so this stays cheap even at millions of rows.
//
// The window is configurable via the `random_probe_retention_days`
// setting so an operator with a compliance requirement to keep probe
// history longer can raise it without a code change. A value of 0 means
// "keep forever" and disables the sweep.

export const DEFAULT_RETENTION_DAYS = 30;

export async function loadRetentionDays(pool: Pool): Promise<number> {
  const raw = await getSetting(pool, "random_probe_retention_days");
  if (raw === null) return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(days);
}

/** Delete probe rows older than `retentionDays`. Returns the number of
 *  rows removed. `retentionDays <= 0` means "keep forever" and is a
 *  no-op returning 0. */
export async function purgeOldProbes(pool: Pool, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const [result] = await pool.query<ResultSetHeader>(
    `DELETE FROM random_probe_log WHERE ts < FROM_UNIXTIME(? / 1000)`,
    [cutoffMs],
  );
  return result.affectedRows;
}

/** Persist the retention window. Clamped to 0..3650 days — 0 means
 *  "keep forever" (the sweep is disabled), 3650 = 10 years. */
export async function saveRetentionDays(pool: Pool, days: number): Promise<void> {
  const clamped = Math.min(3650, Math.max(0, Math.round(days)));
  await setSetting(pool, "random_probe_retention_days", String(clamped));
}
