// SPDX-License-Identifier: MIT
// MCP tool definitions + handlers. Shared by the stdio server entry
// (src/mcp/server.ts); each tool returns plain JSON-serializable values.
import type { Pool } from "mysql2/promise";
import { doLookupCore } from "../lookup-core";
import { lastEtlRun } from "../storage/mysql";
import { queueStats, topByQueryCount } from "../storage/unknownIpQueue";
import type { LookupResult } from "../types";

/** Minimal dependency injection surface every MCP tool handler receives. */
export interface McpPool {
  pool: Pool;
  log: { warn: (obj: unknown, msg: string) => void; error: (obj: unknown, msg: string) => void };
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
export function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** ISO-serialize a Date-or-null for stable JSON output. */
function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/**
 * MCP lookup: identical behavior to the HTTP /lookup route (including the
 * unknown_ip_queue miss side effect), but never writes query_log — MCP
 * callers have no authenticated subject to attribute the query to.
 */
export async function mcpLookup(deps: McpPool, ip: string): Promise<LookupResult> {
  return doLookupCore(deps.pool, deps.log, ip);
}

export function lookupToolDef(): ToolDef {
  return {
    name: "ipquery_lookup",
    description:
      "Query IPQuery for the geolocation of an IPv4/IPv6 address: country, region, city, timezone, ISP and ASN. Unknown IPs are queued for multi-provider backfill.",
    inputSchema: {
      type: "object",
      properties: {
        ip: { type: "string", description: "IPv4 or IPv6 address to look up, e.g. 8.8.8.8" },
      },
      required: ["ip"],
    },
  };
}

export interface QueueStatsResult {
  pending: number;
  processed: number;
  totalQueries: number;
}

export async function mcpQueueStats(deps: McpPool): Promise<QueueStatsResult> {
  try {
    const s = await queueStats(deps.pool);
    return { pending: s.pending, processed: s.processed, totalQueries: s.totalQueries };
  } catch (e) {
    deps.log.error({ err: e }, "mcpQueueStats failed");
    throw new Error(`queue stats failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function queueStatsToolDef(): ToolDef {
  return {
    name: "ipquery_queue_stats",
    description: "Unknown-IP backfill queue counters: pending, processed, and total accumulated queries.",
    inputSchema: { type: "object", properties: {} },
  };
}

export interface EtlStatusResult {
  lastRun:
    | {
        startedAt: string | null;
        finishedAt: string | null;
        status: string;
        mergedRecords: number;
        sources: Record<string, { records: number; builtAt: string | null }>;
      }
    | null;
  queue: QueueStatsResult;
}

export async function mcpEtlStatus(deps: McpPool): Promise<EtlStatusResult> {
  try {
    const last = await lastEtlRun(deps.pool);
    const queue = await mcpQueueStats(deps);
    if (!last) return { lastRun: null, queue };
    return {
      lastRun: {
        startedAt: iso(last.startedAt),
        finishedAt: iso(last.finishedAt ?? null),
        status: last.status,
        mergedRecords: last.mergedRecords ?? 0,
        sources: {
          maxmind: { records: last.maxmindRecords ?? 0, builtAt: iso(last.maxmindBuiltAt ?? null) },
          ip2region: { records: last.ip2regionRecords ?? 0, builtAt: iso(last.ip2regionBuiltAt ?? null) },
          dbip: { records: last.dbipRecords ?? 0, builtAt: iso(last.dbipBuiltAt ?? null) },
        },
      },
      queue,
    };
  } catch (e) {
    deps.log.error({ err: e }, "mcpEtlStatus failed");
    throw new Error(`etl status failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function etlStatusToolDef(): ToolDef {
  return {
    name: "ipquery_etl_status",
    description: "Last ETL run status (per-source record counts) plus a queue summary.",
    inputSchema: { type: "object", properties: {} },
  };
}

export function queueTopToolDef(): ToolDef {
  return {
    name: "ipquery_queue_top",
    description: "Unknown IPs with the highest query counts, pending backfill.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many IPs to return (1-100, default 20)" },
      },
    },
  };
}

export interface QueueTopResult {
  pending: Array<{ ip: string; queryCount: number; lastSeenAt: string | null }>;
  recentlyProcessed: Array<{ ip: string; queryCount: number; processedAt: string | null }>;
}

export async function mcpQueueTop(deps: McpPool, limit?: unknown): Promise<QueueTopResult> {
  const n = clampInt(limit, 1, 100, 20);
  try {
    const { pending, recentlyProcessed } = await topByQueryCount(deps.pool, n);
    return {
      pending: pending.map((r) => ({
        ip: r.ipText,
        queryCount: Number(r.queryCount),
        lastSeenAt: iso(r.lastSeenAt),
      })),
      recentlyProcessed: recentlyProcessed.map((r) => ({
        ip: r.ipText,
        queryCount: Number(r.queryCount),
        processedAt: iso(r.processedAt),
      })),
    };
  } catch (e) {
    deps.log.error({ err: e }, "mcpQueueTop failed");
    throw new Error(`queue top failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
