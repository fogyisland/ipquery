import { type McpPool, type ToolDef } from "./tools";
import { type CircuitBreakerConfig } from "../storage/providerErrorLog";
/**
 * One ETL run, flattened for MCP output.
 *
 * `mergedRecords` is the number of rows the run left in the live table;
 * it is the only count that survives the run, so it is the one an
 * operator comparing two runs actually wants. The per-source breakdown
 * lives in `ipquery_etl_sources`.
 */
export interface EtlHistoryRun {
    id: number;
    startedAt: string | null;
    finishedAt: string | null;
    status: string;
    mergedRecords: number;
    errorMessage: string | null;
}
export interface EtlHistoryResult {
    runs: EtlHistoryRun[];
}
/**
 * ETL run history, newest first.
 *
 * `ipquery_etl_status` reports the newest run only, so a question like
 * "did last night's run fail, and how many runs has this instance had
 * since?" had no answer. The rows are already there — the marketing
 * page reads them through `recentEtlRuns` — this exposes them to MCP.
 */
export declare function mcpEtlHistory(deps: McpPool, limit?: unknown): Promise<EtlHistoryResult>;
export declare function etlHistoryToolDef(): ToolDef;
/** One provider's health inside the requested window. */
export interface ProviderHealthEntry {
    providerName: string;
    /** The window this row covers, in milliseconds. */
    windowMs: number;
    calls: number;
    errors429: number;
    errorsOther: number;
    failureRatePct: number;
    rateLimitedRatePct: number;
    lastCallAt: string | null;
}
export interface ProviderHealthResult {
    /** The size of the window the counters cover, in minutes. */
    windowMinutes: number;
    providers: ProviderHealthEntry[];
    /** The breaker's settings, or null when they could not be read. */
    circuitBreaker: CircuitBreakerConfig | null;
}
/**
 * Provider health for the backfill fan-out.
 *
 * The admin console shows this on its Providers tab, but an AI client
 * driving the server could not ask — and a client watching the library
 * fill itself needs to notice that every backfill has been abstaining
 * because one provider is rate-limiting.
 *
 * The health numbers mean nothing without the breaker settings they are
 * measured against (50% failures under a 100% threshold is healthy), so
 * the two travel together.
 */
export declare function mcpProviderHealth(deps: McpPool, args?: {
    windowMinutes?: unknown;
}): Promise<ProviderHealthResult>;
export declare function providerHealthToolDef(): ToolDef;
/** One administrative action, flattened for MCP output. */
export interface AuditLogRow {
    id: number;
    actorEmail: string;
    action: string;
    targetType: string | null;
    targetId: number | null;
    metadata: Record<string, unknown> | null;
    ip: string | null;
    statusCode: number | null;
    createdAt: string | null;
}
export interface AuditLogResult {
    rows: AuditLogRow[];
    /** How many entries the filter matches in total, not just this page. */
    total: number;
}
/**
 * The administrative audit trail.
 *
 * Every administrative action lands in `admin_audit_log` — approving an
 * MCP token, importing ranges, changing the circuit breaker. The admin
 * console reads it at `/admin/audit-log`; this makes it reachable from
 * an MCP client.
 *
 * The log names operators and their email addresses, so it sits in the
 * `ops` scope: a `lookup` token answers geolocation questions and has
 * no business reading who ran what.
 */
export declare function mcpAuditLog(deps: McpPool, args?: {
    limit?: unknown;
    action?: unknown;
}): Promise<AuditLogResult>;
export declare function auditLogToolDef(): ToolDef;
/** One import job, flattened for MCP output. */
export interface RangeImportEntry {
    id: number;
    mode: string;
    source: string;
    status: string;
    rowsDone: number;
    declaredRows: number | null;
    rowsWritten: number;
    preserved: number;
    errorMessage: string | null;
    startedAt: string | null;
    finishedAt: string | null;
}
/** One export job, flattened for MCP output. */
export interface RangeExportEntry {
    id: string;
    filename: string;
    countryCode: string | null;
    status: string;
    rows: number;
    bytes: number;
    errorMessage: string | null;
    startedAt: string | null;
    finishedAt: string | null;
}
export interface RangeJobsResult {
    imports: RangeImportEntry[];
    exports: RangeExportEntry[];
}
/**
 * The state of the range import and export jobs.
 *
 * A library-sized import takes hours and a library-sized export writes
 * around two gigabytes, so both run detached: the request that starts
 * the job returns immediately and the work continues. Both write their
 * state to a table, so the state survives a restart.
 *
 * The admin console shows both at `/admin/ranges`; this makes them
 * reachable from an MCP client that needs to know whether the ranges
 * table is mid-swap.
 */
export declare function mcpRangeJobs(deps: McpPool, args?: {
    limit?: unknown;
}): Promise<RangeJobsResult>;
export declare function rangeJobsToolDef(): ToolDef;
