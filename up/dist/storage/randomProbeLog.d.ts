import type { Pool } from "mysql2/promise";
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
export declare function recordRandomProbe(pool: Pool, row: RandomProbeInsert): Promise<void>;
export declare function recentProbes(pool: Pool, filter?: RandomProbeFilter): Promise<RandomProbeRow[]>;
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
    byProvider: Record<string, {
        ok: number;
        rateLimited: number;
        timeout: number;
        noCountry: number;
        error: number;
    }>;
}
/** Compute summary stats over the trailing `windowMs` window (default
 *  1h). Walks providers_json for each row to attribute per-provider
 *  counters. Volume assumption: a 1h window returns at most a few
 *  hundred rows (well below the ~70k/day cap), so the in-process
 *  aggregation is cheap. */
export declare function probeSummaryStats(pool: Pool, windowMs?: number): Promise<ProbeSummaryStats>;
export interface RandomGenConfig {
    intervalSec: number;
    batchSize: number;
    cooldownMinutes: number;
    cbLinkage: boolean;
}
export declare function loadRandomGenConfig(pool: Pool): Promise<RandomGenConfig>;
export interface RandomGenConfigUpdate {
    intervalSec?: number;
    batchSize?: number;
    cooldownMinutes?: number;
    cbLinkage?: boolean;
}
export declare function saveRandomGenConfig(pool: Pool, patch: RandomGenConfigUpdate): Promise<void>;
export declare const DEFAULT_RETENTION_DAYS = 30;
export declare function loadRetentionDays(pool: Pool): Promise<number>;
/** Delete probe rows older than `retentionDays`. Returns the number of
 *  rows removed. `retentionDays <= 0` means "keep forever" and is a
 *  no-op returning 0. */
export declare function purgeOldProbes(pool: Pool, retentionDays: number): Promise<number>;
/** Persist the retention window. Clamped to 0..3650 days — 0 means
 *  "keep forever" (the sweep is disabled), 3650 = 10 years. */
export declare function saveRetentionDays(pool: Pool, days: number): Promise<void>;
