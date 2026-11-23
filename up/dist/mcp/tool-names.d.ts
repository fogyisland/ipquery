/** Canonical list of the read-only MCP tools IPQuery exposes. */
export declare const TOOL_NAMES: readonly ["ipquery_lookup", "ipquery_lookup_batch", "ipquery_stats", "ipquery_etl_status", "ipquery_etl_sources", "ipquery_etl_history", "ipquery_provider_health", "ipquery_audit_log", "ipquery_range_jobs", "ipquery_queue_stats", "ipquery_queue_top", "ipquery_queries_recent", "ipquery_queries_daily"];
export type ToolName = (typeof TOOL_NAMES)[number];
