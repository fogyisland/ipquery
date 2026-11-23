import type { Pool } from "mysql2/promise";
import { type BatchLookupEntry as CoreBatchLookupEntry, type BatchLookupResult as CoreBatchLookupResult } from "../lookup-core";
import { type EtlSourceReport } from "../storage/etlSourceContribution";
import type { QueryLogRow } from "../storage/queryLog";
import type { LookupResult } from "../types";
/** Minimal dependency injection surface every MCP tool handler receives. */
export interface McpPool {
    pool: Pool;
    log: {
        warn: (obj: unknown, msg: string) => void;
        error: (obj: unknown, msg: string) => void;
    };
}
/** JSON-Schema tool definition as accepted by the MCP SDK. */
export interface ToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
/**
 * Clamp an unknown tool argument into [min, max]. Non-numeric input falls
 * back to the default; numeric input is clamped into the bounds.
 */
export declare function clampInt(v: unknown, min: number, max: number, fallback: number): number;
/** ISO-serialize a Date-or-null for stable JSON output. */
export declare function iso(d: Date | null | undefined): string | null;
/**
 * MCP lookup: identical behavior to the HTTP /lookup route (including the
 * unknown_ip_queue miss side effect), but never writes query_log — MCP
 * callers have no authenticated subject to attribute the query to.
 */
export declare function mcpLookup(deps: McpPool, ip: string): Promise<LookupResult>;
export declare function lookupToolDef(): ToolDef;
/** One address inside a batch answer. */
export type BatchLookupEntry = CoreBatchLookupEntry;
/** The answer to a batch of lookups. */
export type BatchLookupResult = CoreBatchLookupResult;
/**
 * Look several addresses up in one call.
 *
 * `ipquery_lookup` takes one address. Reconciling a list of addresses
 * one call at a time is fine over HTTP and miserable over MCP, where
 * every call is a round trip through the client.
 *
 * A malformed or unknown address does not fail the batch: the other
 * addresses still get their answers, and the failed one is marked.
 * A batch that died on the first bad address would be worse than no
 * batch tool at all.
 *
 * The work itself lives in the shared core, so this tool and the HTTP
 * endpoint answer identically — the same addresses, the same markers,
 * the same count. Two implementations of one answer is how a client ends
 * up with two different truths about the same address.
 */
export declare function mcpLookupBatch(deps: McpPool, args: {
    ips?: unknown;
}): Promise<BatchLookupResult>;
export declare function lookupBatchToolDef(): ToolDef;
export interface QueueStatsResult {
    pending: number;
    processed: number;
    totalQueries: number;
}
export declare function mcpQueueStats(deps: McpPool): Promise<QueueStatsResult>;
export declare function queueStatsToolDef(): ToolDef;
export interface EtlStatusResult {
    lastRun: {
        startedAt: string | null;
        finishedAt: string | null;
        status: string;
        mergedRecords: number;
        /**
         * Per-source counters. `records` is null for a source whose count
         * the run row does not carry — the source list is derived from the
         * pipeline's own file table, so it names only sources that
         * actually run. The per-file counts for those sources live in the
         * ETL stage tables, not on the run row.
         */
        sources: Record<string, {
            records: number | null;
            builtAt: string | null;
        }>;
    } | null;
    queue: QueueStatsResult;
}
export declare function mcpEtlStatus(deps: McpPool): Promise<EtlStatusResult>;
export declare function etlStatusToolDef(): ToolDef;
/**
 * Per-source ETL contribution.
 *
 * `ipquery_etl_status` reports the run-level counters, of which only
 * one (the lumped DB-IP counter) is non-null — the other six files are
 * counted per file in the stage tables, and no tool could reach them.
 * This one reads those tables.
 *
 * `runId` selects the run; without it the most recent run is used.
 */
export declare function mcpEtlSources(deps: McpPool, runId?: unknown): Promise<EtlSourceReport>;
export declare function etlSourcesToolDef(): ToolDef;
export declare function queueTopToolDef(): ToolDef;
export interface QueueTopResult {
    pending: Array<{
        ip: string;
        queryCount: number;
        lastSeenAt: string | null;
    }>;
    recentlyProcessed: Array<{
        ip: string;
        queryCount: number;
        processedAt: string | null;
    }>;
}
export declare function mcpQueueTop(deps: McpPool, limit?: unknown): Promise<QueueTopResult>;
/** Mask an email as p***@e***.com; null/empty → null.
 *  Only the TLD survives (last dot, not first): a first-dot split would
 *  leak the whole registrable domain of a subdomain address —
 *  a@mail.example.com must come out as a***@m***.com, not a***@m***.example.com. */
export declare function maskEmail(email: string | null | undefined): string | null;
/** Keep the first 4 chars of an API-key prefix; null/empty → null. */
export declare function maskPrefix(prefix: string | null | undefined): string | null;
/**
 * Serialize a query-log row for MCP output. includePrivate=false (the
 * default from the tool layer) redacts userEmail and apiKeyPrefix; remote
 * address and IP text stay visible — they are the lookup subject, not a
 * secret. Dates are ISO-serialized.
 */
export declare function sanitizeQueryRow(row: QueryLogRow, includePrivate: boolean): Record<string, unknown>;
export interface QueriesRecentArgs {
    limit?: unknown;
    status?: unknown;
    includePrivate?: unknown;
}
export declare function mcpQueriesRecent(deps: McpPool, args?: QueriesRecentArgs): Promise<{
    rows: Array<Record<string, unknown>>;
    total: number;
}>;
export declare function queriesRecentToolDef(): ToolDef;
export declare function mcpQueriesDaily(deps: McpPool, args?: {
    days?: unknown;
}): Promise<Array<{
    day: string;
    count: number;
}>>;
export declare function queriesDailyToolDef(): ToolDef;
