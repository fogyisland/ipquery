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

/** A handler takes raw tool arguments and returns a JSON string result. */
export type ToolHandler = (args: unknown) => Promise<string>;

export interface ToolRegistration {
  def: ToolDef;
  handler: ToolHandler;
}

/** Structured error text so AI clients see actionable messages. */
function errorText(message: string): string {
  return JSON.stringify({ isErrorHint: true, message }, null, 2);
}

/** Wrap a tool call: thrown errors become structured text, never escapes. */
async function safe(run: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await run(), null, 2);
  } catch (e) {
    return errorText(e instanceof Error ? e.message : String(e));
  }
}

async function statsHandler(deps: McpPool): Promise<unknown> {
  const last = await lastEtlRun(deps.pool);
  if (!last) return { lastRun: null };
  return {
    lastRun: {
      startedAt: last.startedAt?.toISOString() ?? null,
      finishedAt: last.finishedAt?.toISOString() ?? null,
      status: last.status,
      mergedRecords: last.mergedRecords ?? 0,
      sources: {
        maxmind: { records: last.maxmindRecords ?? 0, builtAt: last.maxmindBuiltAt?.toISOString() ?? null },
        ip2region: {
          records: last.ip2regionRecords ?? 0,
          builtAt: last.ip2regionBuiltAt?.toISOString() ?? null,
        },
        dbip: { records: last.dbipRecords ?? 0, builtAt: last.dbipBuiltAt?.toISOString() ?? null },
      },
    },
  };
}

function lookupHandler(deps: McpPool): ToolHandler {
  return async (args) => {
    const ip = (args as { ip?: unknown }).ip;
    if (typeof ip !== "string" || !isValidIp(ip)) {
      return errorText(`invalid ip: ${typeof ip === "string" ? ip : "(missing)"}`);
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
