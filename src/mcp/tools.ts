// SPDX-License-Identifier: MIT
// MCP tool definitions + handlers. Shared by the stdio server entry
// (src/mcp/server.ts); each tool returns plain JSON-serializable values.
import type { Pool } from "mysql2/promise";
import { doLookupCore } from "../lookup-core";
import { lastEtlRun } from "../storage/mysql";
import { queueStats, topByQueryCount } from "../storage/unknownIpQueue";
import { listQueryLogs, countQueriesByDay } from "../storage/queryLog";
import { buildEtlSourceReport } from "../storage/etlSourceReport";
import { buildRunSourceReport, type EtlSourceReport } from "../storage/etlSourceContribution";
import { isValidIp } from "../ip";
import type { QueryLogRow } from "../storage/queryLog";
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
export function iso(d: Date | null | undefined): string | null {
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

/** One address inside a batch answer. */
export interface BatchLookupEntry {
  ip: string;
  /** False when the address was malformed or not in the library. */
  found: boolean;
  /** The lookup result, when the address was found. */
  result?: LookupResult;
  /** Why the address was not found: "invalid_ip" or "not_found". */
  error?: string;
}

export interface BatchLookupResult {
  results: BatchLookupEntry[];
  /** How many addresses were asked about. */
  total: number;
  /** How many of them were in the library. */
  found: number;
  /** How many were not — malformed or unknown. */
  notFound: number;
}

/** Largest batch the tool will answer in one call. */
const MAX_BATCH_SIZE = 100;

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
 */
export async function mcpLookupBatch(
  deps: McpPool,
  args: { ips?: unknown },
): Promise<BatchLookupResult> {
  if (!Array.isArray(args.ips)) {
    throw new Error("ips must be an array of IPv4/IPv6 addresses");
  }
  const requested = args.ips.slice(0, MAX_BATCH_SIZE).map((ip) => (typeof ip === "string" ? ip.trim() : ""));
  const results: BatchLookupEntry[] = [];
  let found = 0;

  for (const ip of requested) {
    if (!isValidIp(ip)) {
      results.push({ ip, found: false, error: "invalid_ip" });
      continue;
    }
    try {
      const result = await mcpLookup(deps, ip);
      results.push({ ip, found: true, result });
      found += 1;
    } catch (e) {
      // A miss is an answer, not a failure: the address is simply not
      // in the library. Anything else is reported as an error on that
      // entry so the rest of the batch still lands.
      const code = (e as { code?: unknown }).code;
      results.push({
        ip,
        found: false,
        error: typeof code === "string" ? code : "lookup_failed",
      });
    }
  }

  return { results, total: requested.length, found, notFound: requested.length - found };
}

export function lookupBatchToolDef(): ToolDef {
  return {
    name: "ipquery_lookup_batch",
    description:
      "Look up up to 100 IPv4/IPv6 addresses in one call. The answers keep the order of the request; an address that is malformed or not in the library is marked rather than failing the batch.",
    inputSchema: {
      type: "object",
      properties: {
        ips: {
          type: "array",
          items: { type: "string" },
          description: "IPv4/IPv6 addresses to look up (max 100)",
        },
      },
      required: ["ips"],
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
    sources: Record<string, { records: number | null; builtAt: string | null }>;
  } | null;
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
        sources: buildEtlSourceReport(last),
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
export async function mcpEtlSources(deps: McpPool, runId?: unknown): Promise<EtlSourceReport> {
  const requested =
    typeof runId === "number" && Number.isInteger(runId) && runId > 0 ? runId : null;
  try {
    return await buildRunSourceReport(deps.pool, requested);
  } catch (e) {
    deps.log.error({ err: e }, "mcpEtlSources failed");
    throw new Error(`etl sources failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function etlSourcesToolDef(): ToolDef {
  return {
    name: "ipquery_etl_sources",
    description:
      "Per-source ETL contribution for one run: rows emitted, skipped, inserted and duplicated per source, with the download outcome. Defaults to the most recent run.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "number",
          description: "ETL run id to inspect (default: the most recent run)",
        },
      },
    },
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

// ─── Query-log tools + redaction ──────────────────────────────────────

/** Mask an email as p***@e***.com; null/empty → null.
 *  Only the TLD survives (last dot, not first): a first-dot split would
 *  leak the whole registrable domain of a subdomain address —
 *  a@mail.example.com must come out as a***@m***.com, not a***@m***.example.com. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return `${local[0]}***@***`;
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${domain[0]}***${tld}`;
}

/** Keep the first 4 chars of an API-key prefix; null/empty → null. */
export function maskPrefix(prefix: string | null | undefined): string | null {
  if (!prefix) return null;
  return `${prefix.slice(0, 4)}***`;
}

/**
 * Serialize a query-log row for MCP output. includePrivate=false (the
 * default from the tool layer) redacts userEmail and apiKeyPrefix; remote
 * address and IP text stay visible — they are the lookup subject, not a
 * secret. Dates are ISO-serialized.
 */
export function sanitizeQueryRow(row: QueryLogRow, includePrivate: boolean): Record<string, unknown> {
  return {
    id: row.id,
    ts: iso(row.ts ?? null),
    ipText: row.ipText,
    status: row.status,
    userId: row.userId,
    userAgent: row.userAgent ?? null,
    userEmail: includePrivate ? (row.userEmail ?? null) : maskEmail(row.userEmail),
    apiKeyPrefix: includePrivate ? (row.apiKeyPrefix ?? null) : maskPrefix(row.apiKeyPrefix),
  };
}

export interface QueriesRecentArgs {
  limit?: unknown;
  status?: unknown;
  includePrivate?: unknown;
}

const VALID_STATUSES = ["hit", "miss", "invalid"] as const;
type QueryStatus = (typeof VALID_STATUSES)[number];

export async function mcpQueriesRecent(
  deps: McpPool,
  args: QueriesRecentArgs = {},
): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
  const limit = clampInt(args.limit, 1, 50, 10);
  const status =
    typeof args.status === "string" && (VALID_STATUSES as readonly string[]).includes(args.status)
      ? (args.status as QueryStatus)
      : undefined;
  const includePrivate = args.includePrivate === true;
  try {
    const { rows, total } = await listQueryLogs(deps.pool, { offset: 0, limit, status });
    return { rows: rows.map((r) => sanitizeQueryRow(r, includePrivate)), total };
  } catch (e) {
    deps.log.error({ err: e }, "mcpQueriesRecent failed");
    throw new Error(`recent queries failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function queriesRecentToolDef(): ToolDef {
  return {
    name: "ipquery_queries_recent",
    description:
      "Recent lookup queries from the query log, newest first. userEmail and apiKeyPrefix are redacted unless includePrivate is true.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Rows to return (1-50, default 10)" },
        status: { type: "string", enum: ["hit", "miss", "invalid"], description: "Filter by result status" },
        includePrivate: {
          type: "boolean",
          description: "Return unredacted userEmail/apiKeyPrefix (default false)",
        },
      },
    },
  };
}

export async function mcpQueriesDaily(
  deps: McpPool,
  args: { days?: unknown } = {},
): Promise<Array<{ day: string; count: number }>> {
  const days = clampInt(args.days, 1, 90, 30);
  try {
    const buckets = await countQueriesByDay(deps.pool, days);
    return buckets.map((b) => ({ day: b.date, count: Number(b.total) }));
  } catch (e) {
    deps.log.error({ err: e }, "mcpQueriesDaily failed");
    throw new Error(`daily queries failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function queriesDailyToolDef(): ToolDef {
  return {
    name: "ipquery_queries_daily",
    description: "Lookup query volume per day over the last N days (1-90, default 30).",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "Window size in days (1-90, default 30)" } },
    },
  };
}
