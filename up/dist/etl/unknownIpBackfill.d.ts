import type { Pool } from "mysql2/promise";
import type { IpGeoProvider, IpGeoRecord } from "./providers/types";
import type { ProviderConfigRow } from "../storage/ingestProviders";
import { type PerProviderDetail } from "../storage/randomProbeLog";
import { type ProviderLock } from "./providerLock";
export interface BackfillOptions {
    /** How many IPs to pull per run. Each IP fans out to all providers so
     *  effective provider-call count is `batchLimit * providers.length`. */
    batchLimit?: number;
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
    perProvider: Array<{
        name: string;
        ok: boolean;
        country: string | null;
        errorCode: string | null;
    }>;
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
    providers: Record<string, {
        ok: number;
        failed: number;
        abstained: number;
        rateLimited: number;
    }>;
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
/** Per-IP outcome returned by processIp. `merged` carries `newlyInserted`
 *  so the random-IP flow can tell genuinely-new rows apart from
 *  duplicates-that-were-ignored. Backfill doesn't care about the
 *  distinction (queue rows are unique by construction). */
export type IpOutcome = {
    kind: "merged";
    record: IpGeoRecord;
    newlyInserted: boolean;
} | {
    kind: "no_consensus";
} | {
    kind: "no_country";
} | {
    kind: "all_abstained";
};
/** Returned by processIp alongside the outcome. Carries the per-provider
 *  detail so the caller (random-gen flow, manual-generate, backfill) can
 *  record a self-contained row into random_probe_log without re-running
 *  any provider call. */
export interface ProcessIpResult {
    outcome: IpOutcome;
    perProvider: PerProviderDetail[];
}
export declare function runBackfill(pool: Pool, providers: IpGeoProvider[], opts?: BackfillOptions): Promise<BackfillSummary>;
/** Per-IP fan-out + vote + write. Used by both the queue-driven backfill
 *  and the random-IP generator. Updates `summary.providers[name]` stats
 *  in place. Returns the outcome so the caller can track it.
 *
 *  Each non-OK per-provider call is recorded into provider_error_log so
 *  the Failure Logs tab can audit exactly what failed and why. The
 *  record is fire-and-forget — a failure to log must not poison the
 *  vote. */
export declare function processIp(pool: Pool, providers: IpGeoProvider[], ipText: string, ipBuffer: Buffer, summary: BackfillSummary, mode?: "auto" | "manual" | "random", dryRun?: boolean, logger?: Pick<Console, "log" | "warn" | "error">): Promise<ProcessIpResult>;
/** Disable any provider whose rateLimited counter > 0. Idempotent. Also
 *  consults the circuit-breaker config: when the failure rate (non-ok
 *  outcomes / total) over the configured window exceeds the threshold,
 *  the provider is auto-disabled even without a 429. The breaker reads
 *  the persisted `provider_error_log` for a sliding-window check. */
export declare function disableRateLimitedProviders(pool: Pool, providers: IpGeoProvider[], summary: BackfillSummary): Promise<void>;
/** Convenience constructor: pick providers based on which API keys are
 *  present in env. Each provider silently abstains if its key is missing,
 *  so the backfill is robust to partial configurations — it'll just have
 *  fewer votes and may fail to reach consensus. */
export declare function buildDefaultProviders(env?: NodeJS.ProcessEnv): IpGeoProvider[];
/** Convenience: parse + validate an IP string into the same Buffer format
 *  unknown_ip_queue stores. Re-exported here so admin routes don't need
 *  to import the low-level helper directly. */
export declare function bufferFromIpText(text: string): Buffer | null;
/** Re-export the storage type for callers that build providers from DB. */
export type { ProviderConfigRow };
