// SPDX-License-Identifier: MIT
/** Canonical list of the 7 read-only MCP tools IPQuery exposes. */
export const TOOL_NAMES = [
  "ipquery_lookup",
  "ipquery_stats",
  "ipquery_etl_status",
  "ipquery_queue_stats",
  "ipquery_queue_top",
  "ipquery_queries_recent",
  "ipquery_queries_daily",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
