// SPDX-License-Identifier: MIT
// Unified registration table: pairs every tool definition with a handler
// that returns MCP text content. The stdio server entry consumes this.
import {
  mcpLookup,
  lookupToolDef,
  mcpEtlStatus,
  etlStatusToolDef,
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
import { lastEtlRun } from "../storage/mysql";
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
    sources: {
      // null = the source did not run; 0 = it ran and contributed
      // nothing. MaxMind and ip2region parsers exist but are not wired
      // into the ETL pipeline, so their counters stay NULL.
      maxmind: {
        records: last.maxmindRecords ?? null,
        builtAt: last.maxmindBuiltAt?.toISOString() ?? null,
      },
      ip2region: {
        records: last.ip2regionRecords ?? null,
        builtAt: last.ip2regionBuiltAt?.toISOString() ?? null,
      },
      dbip: { records: last.dbipRecords ?? 0, builtAt: last.dbipBuiltAt?.toISOString() ?? null },
    },
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
      def: {
        name: "ipquery_stats",
        description: "Library summary: last ETL run status and per-source record counts.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: () => safe(() => statsHandler(deps)),
    },
    { def: etlStatusToolDef(), handler: () => safe(() => mcpEtlStatus(deps)) },
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
