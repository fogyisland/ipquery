import type { Pool } from "mysql2/promise";
import type { IpGeoProvider } from "./providers/types";
import type { ProviderConfigRow } from "../storage/ingestProviders";
import { type ProviderLock } from "./providerLock";
export interface RandomGenerationOptions {
    /** How many random IPs to pick. Default 10 — the user asked for 10. */
    count?: number;
    /** Stop retrying on collision after this many attempts per slot.
     *  Default 50 — the picks come from the RFC 5737 / RFC 6890 reserved
     *  pools (~4.1M addresses), so collisions inside a 10-IP run are
     *  effectively impossible; the budget only matters if the pool is
     *  nearly exhausted. */
    maxTriesPerIp?: number;
    /** The provider-fan-out mutex to use. Defaults to the shared
     *  instance so this flow can't double the request rate against the
     *  providers' free-tier quotas while a backfill run is in flight.
     *  Tests can pass their own lock to stay isolated. */
    lock?: ProviderLock;
    logger?: Pick<Console, "log" | "warn" | "error">;
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
    providers: Record<string, {
        ok: number;
        failed: number;
        abstained: number;
        rateLimited: number;
    }>;
    /** Provider names auto-disabled during this run. */
    providersDisabled: string[];
    /** True when the run was skipped because another provider fan-out was
     *  already in flight (the shared provider mutex was busy). No provider
     *  calls were made and no IPs were picked. */
    skippedLockBusy?: boolean;
}
/** Run the random-IP generation flow. Returns a summary so the admin
 *  route can show counts inline. */
export declare function runRandomGeneration(pool: Pool, providers: IpGeoProvider[], opts?: RandomGenerationOptions): Promise<RandomGenerationSummary>;
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
export declare function pickRandomIpsNotInRanges(pool: Pool, count: number, maxTriesPerSlot?: number): Promise<{
    ips: Array<{
        text: string;
        buffer: Buffer;
    }>;
    exhausted: number;
    coveredSkips: number;
}>;
/** Re-export so callers building providers from DB don't need a separate
 *  storage import for the type. */
export type { ProviderConfigRow };
