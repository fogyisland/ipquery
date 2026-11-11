import type { Pool } from "mysql2/promise";
import type { IpGeoProvider } from "../etl/providers/types";
export interface ProviderConfigRow {
    name: string;
    displayName: string;
    freeQuota: string;
    enabled: boolean;
    apiKey: string | null;
    rateLimitPerMin: number | null;
    lastUsedAt: Date | null;
    lastErrorAt: Date | null;
    lastErrorReason: string | null;
    autoReenableAt: Date | null;
    autoDisabledReason: string | null;
    isCustom: boolean;
    customUrlTemplate: string | null;
    customMethod: "GET" | "POST";
    customRequestBody: string | null;
    customResponseFormat: "json" | "text";
    customCountryPath: string | null;
    customCityPath: string | null;
    customAsnPath: string | null;
    customTimeoutMs: number | null;
}
/** Static catalog. Mirrors the seeded rows in migration 016 — adding a
 *  new provider requires a row AND a catalog entry, never one alone.
 *  Exported (not just a module-private const) so peers like
 *  providerErrorLog can iterate the provider names without re-typing
 *  them. */
export declare const PROVIDER_CATALOG: Record<string, {
    displayName: string;
    freeQuota: string;
}>;
export declare const PROVIDER_CATALOG_LIST: ProviderConfigRow[];
export declare function listProviderConfigs(pool: Pool): Promise<ProviderConfigRow[]>;
export declare function getProviderConfig(pool: Pool, name: string): Promise<ProviderConfigRow | null>;
/** Persist admin changes. Whitelist of updatable fields: enabled, api_key,
 *  auto_reenable_at, auto_disabled_reason. Display name + free quota are
 *  code-managed (catalog). */
export interface ProviderConfigUpdate {
    enabled?: boolean;
    apiKey?: string | null;
    autoReenableAt?: Date | null;
    autoDisabledReason?: string | null;
}
export interface CustomProviderFields {
    displayName: string;
    urlTemplate: string;
    method: "GET" | "POST";
    requestBody: string | null;
    responseFormat: "json" | "text";
    countryPath: string;
    cityPath: string | null;
    asnPath: string | null;
    timeoutMs: number | null;
    apiKey: string | null;
    enabled?: boolean;
}
/** Upsert a custom provider. INSERT … ON DUPLICATE KEY UPDATE keeps the
 *  path simple: first create writes a new row (is_custom=1), subsequent
 *  updates refresh the custom_* columns in place. The api_key column is
 *  NOT touched here — it's rotated through updateProviderConfig like
 *  the built-in providers. */
export declare function upsertCustomProvider(pool: Pool, name: string, f: CustomProviderFields): Promise<void>;
/** Delete a custom provider. The is_custom=1 guard means a typo in the
 *  URL path can never accidentally drop a built-in row. Returns the
 *  number of rows actually deleted (0 when name didn't exist or was a
 *  built-in). */
export declare function deleteCustomProvider(pool: Pool, name: string): Promise<number>;
export declare function updateProviderConfig(pool: Pool, name: string, patch: ProviderConfigUpdate): Promise<void>;
export declare function touchProviderSuccess(pool: Pool, name: string): Promise<void>;
export declare function touchProviderError(pool: Pool, name: string, reason: string): Promise<void>;
/** Per-call outcome tag from the ingest flows (backfill / random-gen). */
export interface ProviderCallOutcome {
    rateLimited?: boolean;
    errorCode?: string;
}
/** Per-provider, per-UTC-day call counter. UPSERTs into provider_call_counter
 *  so calls within the same UTC day accumulate into one row. Called from
 *  processIp() in unknownIpBackfill AFTER every provider.lookup() —
 *  successful, rate-limited, errored, or thrown. Powers the "1h/24h/7d
 *  window stats" widget on the Providers tab and the "daily quota usage"
 *  pill.
 *
 *  All bucketing happens in JS — we bind only 0/1 increments so MySQL
 *  never has to coerce a string errorCode against numeric/equality
 *  literals in WHERE-style comparison contexts (which would error with
 *  "Truncated incorrect DOUBLE value: 'timeout'"). 9 placeholders
 *  total: 1 (name) + 4 (buckets for VALUES) + 4 (buckets for UPDATE). */
export declare function touchProviderCalled(pool: Pool, name: string, outcome: ProviderCallOutcome): Promise<void>;
/** Build provider instances for the backfill job, reading enabled
 *  + api_key from the DB. Disabled providers are skipped entirely.
 *  Custom providers (is_custom=1) are dispatched to GenericHttpProvider
 *  with their DB-stored template + field paths. */
export declare function buildProvidersFromConfig(configs: ProviderConfigRow[]): IpGeoProvider[];
export interface LastBackfillProviderEntry {
    ok: number;
    failed: number;
    abstained: number;
    rateLimited: number;
}
export type LastBackfillProviderStats = Record<string, LastBackfillProviderEntry>;
export declare function saveLastBackfillProviderStats(pool: Pool, providers: BackfillSummary["providers"], runAt: Date): Promise<void>;
export declare function loadLastBackfillProviderStats(pool: Pool): Promise<{
    runAt: Date | null;
    providers: LastBackfillProviderStats;
}>;
type BackfillSummary = {
    providers: Record<string, LastBackfillProviderEntry>;
};
export {};
