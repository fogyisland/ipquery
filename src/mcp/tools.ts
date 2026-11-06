// SPDX-License-Identifier: MIT
// MCP tool definitions + handlers. Shared by the stdio server entry
// (src/mcp/server.ts); each tool returns plain JSON-serializable values.
import type { Pool } from "mysql2/promise";
import { doLookupCore } from "../lookup-core";
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
