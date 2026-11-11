import type { Pool } from "mysql2/promise";
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
/**
 * MCP lookup: identical behavior to the HTTP /lookup route (including the
 * unknown_ip_queue miss side effect), but never writes query_log — MCP
 * callers have no authenticated subject to attribute the query to.
 */
export declare function mcpLookup(deps: McpPool, ip: string): Promise<LookupResult>;
export declare function lookupToolDef(): ToolDef;
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
         * Per-source counters. `records` is null for a source that did not
         * run and 0 for one that ran and contributed nothing — the two are
         * different facts and callers should not conflate them. MaxMind
         * and ip2region parsers exist but are not wired into the ETL
         * pipeline, so their counters are always null.
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
