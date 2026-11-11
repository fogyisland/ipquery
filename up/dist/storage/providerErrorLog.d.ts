import type { Pool } from "mysql2/promise";
export interface ProviderErrorRow {
    id: number;
    providerName: string;
    ipText: string;
    mode: "auto" | "manual" | "random";
    errorCode: string;
    reason: string;
    rawResponse: string | null;
    ts: Date;
    retryCount: number;
}
export interface ProviderErrorInsert {
    providerName: string;
    ipText: string;
    mode: "auto" | "manual" | "random";
    errorCode: string;
    reason: string;
    rawResponse?: string | null;
    retryCount?: number;
}
export interface ProviderErrorFilter {
    providerName?: string;
    errorCode?: string;
    mode?: "auto" | "manual" | "random";
    sinceMs?: number;
    limit?: number;
}
export declare function recordProviderError(pool: Pool, row: ProviderErrorInsert): Promise<void>;
export declare function queryProviderErrors(pool: Pool, filter?: ProviderErrorFilter): Promise<ProviderErrorRow[]>;
export declare function distinctErrorCodes(pool: Pool): Promise<string[]>;
export interface CircuitBreakerConfig {
    enabled: boolean;
    failureThresholdPct: number;
    windowMinutes: number;
    cooldownMinutes: number;
}
export declare function getCircuitBreakerConfig(pool: Pool): Promise<CircuitBreakerConfig>;
export interface CircuitBreakerUpdate {
    enabled?: boolean;
    failureThresholdPct?: number;
    windowMinutes?: number;
    cooldownMinutes?: number;
}
export declare function setCircuitBreakerConfig(pool: Pool, patch: CircuitBreakerUpdate): Promise<void>;
export interface ProviderHealthWindow {
    providerName: string;
    windowMs: number;
    calls: number;
    errors429: number;
    errorsOther: number;
    failureRatePct: number;
    rateLimitedRatePct: number;
    lastCallAt: Date | null;
}
/** Aggregate call counts for ONE provider over a time window.
 *  - windowMs <= 24h: use last_called_at (precise to the second) so the
 *    1h window rolls cleanly across UTC-day boundaries.
 *  - windowMs > 24h: bucket by day_utc because daily UPSERTs are the
 *    smallest resolution the table natively carries. */
export declare function aggregateProviderHealth(pool: Pool, name: string, windowMs: number): Promise<ProviderHealthWindow>;
/** One ProviderHealthWindow per provider in PROVIDER_CATALOG. Providers
 *  with zero calls return 0s. */
export declare function aggregateProviderHealthAll(pool: Pool, windowMs: number): Promise<ProviderHealthWindow[]>;
/** For tests: clear all cached health aggregates. */
export declare function _resetProviderHealthCache(): void;
export declare function getAggregateProviderHealthAllCached(pool: Pool, windowMs: number): Promise<ProviderHealthWindow[]>;
