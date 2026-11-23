// SPDX-License-Identifier: MIT
// Unified registration table: pairs every tool definition with a handler
// that returns MCP text content. The stdio server entry consumes this.
import {
  mcpLookup,
  lookupToolDef,
  mcpLookupBatch,
  lookupBatchToolDef,
  mcpEtlStatus,
  etlStatusToolDef,
  mcpEtlSources,
  etlSourcesToolDef,
  mcpQueueStats,
  queueStatsToolDef,
  mcpQueueTop,
  queueTopToolDef,
  mcpQueriesRecent,
  queriesRecentToolDef,
  mcpQueriesDaily,
  queriesDailyToolDef,
  type McpPool,
  type ToolDef,
} from "./tools";
import {
  mcpEtlHistory,
  etlHistoryToolDef,
  mcpProviderHealth,
  providerHealthToolDef,
  mcpAuditLog,
  auditLogToolDef,
  mcpRangeJobs,
  rangeJobsToolDef,
} from "./ops-tools";
import { lastEtlRun } from "../storage/mysql";
import { buildEtlSourceReport } from "../storage/etlSourceReport";
import { isValidIp } from "../ip";

/** A handler takes raw tool arguments and returns a typed result envelope. */
export interface ToolResult {
  isErrorHint?: boolean;
  message?: string;
  [key: string]: unknown;
}

export type ToolHandler = (args: unknown) => Promise<ToolResult>;

export interface ToolRegistration {
  def: ToolDef;
  handler: ToolHandler;
}

/** Structured error result so the server layer can flag isError without
 *  sniffing serialized text. */
function errorResult(message: string, code?: string): ToolResult {
  return code ? { isErrorHint: true, code, message } : { isErrorHint: true, message };
}

/** Wrap a tool call: thrown errors become structured results, never escapes.
 *  Tool payloads are plain JSON objects; ToolResult's index signature accepts
 *  them once widened through unknown. Typed business codes (e.g. the lookup
 *  `not_found` miss) travel alongside so the server layer can downgrade
 *  them to a normal result — a miss is an answer, not a tool failure. */
async function safe(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return (await run()) as ToolResult;
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return errorResult(e instanceof Error ? e.message : String(e), typeof code === "string" ? code : undefined);
  }
}

/** ISO-serialize the shared lastRun shape (used by ipquery_stats and the
 *  etl-status tool so the two outputs cannot drift). */
export function serializeLastRun(
  last: NonNullable<Awaited<ReturnType<typeof lastEtlRun>>>,
): ToolResult["lastRun"] {
  return {
    startedAt: last.startedAt?.toISOString() ?? null,
    finishedAt: last.finishedAt?.toISOString() ?? null,
    status: last.status,
    mergedRecords: last.mergedRecords ?? 0,
    // Derived from the pipeline's own file table — the same helper the
    // HTTP /stats route uses, so the two cannot drift apart.
    sources: buildEtlSourceReport(last),
  };
}

async function statsHandler(deps: McpPool): Promise<ToolResult> {
  const last = await lastEtlRun(deps.pool);
  if (!last) return { lastRun: null };
  return { lastRun: serializeLastRun(last) };
}

function lookupHandler(deps: McpPool): ToolHandler {
  return async (args) => {
    const ip = (args as { ip?: unknown }).ip;
    if (typeof ip !== "string" || !isValidIp(ip)) {
      return errorResult(`invalid ip: ${typeof ip === "string" ? ip : "(missing)"}`);
    }
    return safe(() => mcpLookup(deps, ip));
  };
}

export function buildToolRegistrations(deps: McpPool): ToolRegistration[] {
  return [
    { def: lookupToolDef(), handler: lookupHandler(deps) },
    {
      def: lookupBatchToolDef(),
      handler: (args) => safe(() => mcpLookupBatch(deps, args as { ips?: unknown })),
    },
    {
      def: {
        name: "ipquery_stats",
        description: "Library summary: last ETL run status and per-source record counts.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: () => safe(() => statsHandler(deps)),
    },
    { def: etlStatusToolDef(), handler: () => safe(() => mcpEtlStatus(deps)) },
    {
      def: etlSourcesToolDef(),
      handler: (args) => safe(() => mcpEtlSources(deps, (args as { runId?: unknown }).runId)),
    },
    {
      def: etlHistoryToolDef(),
      handler: (args) => safe(() => mcpEtlHistory(deps, (args as { limit?: unknown }).limit)),
    },
    {
      def: providerHealthToolDef(),
      handler: (args) =>
        safe(() => mcpProviderHealth(deps, args as { windowMinutes?: unknown })),
    },
    {
      def: auditLogToolDef(),
      handler: (args) => safe(() => mcpAuditLog(deps, args as { limit?: unknown; action?: unknown })),
    },
    {
      def: rangeJobsToolDef(),
      handler: (args) => safe(() => mcpRangeJobs(deps, args as { limit?: unknown })),
    },
    { def: queueStatsToolDef(), handler: () => safe(() => mcpQueueStats(deps)) },
    {
      def: queueTopToolDef(),
      handler: (args) => safe(() => mcpQueueTop(deps, (args as { limit?: unknown }).limit)),
    },
    {
      def: queriesRecentToolDef(),
      handler: (args) =>
        safe(() =>
          mcpQueriesRecent(deps, args as { limit?: unknown; status?: unknown; includePrivate?: unknown }),
        ),
    },
    {
      def: queriesDailyToolDef(),
      handler: (args) => safe(() => mcpQueriesDaily(deps, args as { days?: unknown })),
    },
  ];
}
