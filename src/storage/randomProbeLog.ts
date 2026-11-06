// SPDX-License-Identifier: MIT
//
// random_probe_log: per-IP audit trail for the API ingest flows
// (runBackfill, runRandomGeneration, manual-generate). Read by the
// /admin/unknown-ips Overview tab "Recent Probes" table; written by the
// call sites of processIp via recordRandomProbe(). See migration 018.

import type { Pool, RowDataPacket } from "mysql2/promise";
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

const DEFAULT_CONFIG: RandomGenConfig = {
  intervalSec: 60,
  batchSize: 10,
  cooldownMinutes: 15,
  cbLinkage: true,
};

export async function loadRandomGenConfig(pool: Pool): Promise<RandomGenConfig> {
  const [intervalRaw, batchRaw, cooldownRaw, cbRaw] = await Promise.all([
    getSetting(pool, "random_gen_interval_sec"),
    getSetting(pool, "random_gen_batch_size"),
    getSetting(pool, "random_gen_cooldown_minutes"),
    getSetting(pool, "random_gen_cb_linkage"),
  ]);
  return {
    intervalSec:
      intervalRaw === null
        ? DEFAULT_CONFIG.intervalSec
        : Math.min(3600, Math.max(1, Number(intervalRaw) || DEFAULT_CONFIG.intervalSec)),
    batchSize:
      batchRaw === null
        ? DEFAULT_CONFIG.batchSize
        : Math.min(100, Math.max(1, Number(batchRaw) || DEFAULT_CONFIG.batchSize)),
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
