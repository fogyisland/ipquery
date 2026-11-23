// SPDX-License-Identifier: MIT
//
// The MCP server must be able to answer "who changed what, and when?".
//
// Every administrative action — approving an MCP token, importing IP
// ranges, changing the circuit breaker — lands in `admin_audit_log`.
// The admin console reads it at `/admin/audit-log`, but an AI client
// driving the server could not ask. A client that can change settings
// (or that watches an instance someone else administers) needs to be
// able to read the trail.
//
// The audit log holds operator email addresses, so it is operational
// data: it belongs to the `ops` scope, not to `lookup`.
//
// This test pins the new tool's shape and its three registration points.
// Missing any one of them is a silent hole rather than an error: a tool
// in the definition list but not in the scope list is unreachable, and a
// tool in the scope list but not registered is a promise the server does
// not keep.
import { describe, it, expect, vi } from "vitest";
import { TOOL_NAMES } from "../../src/mcp/tool-names";
import { OPS_SCOPE_TOOLS, LOOKUP_SCOPE_TOOLS } from "../../src/mcp/auth";
import { buildToolRegistrations } from "../../src/mcp/server-tools";
import { mcpAuditLog, auditLogToolDef } from "../../src/mcp/ops-tools";
import type { McpPool } from "../../src/mcp/tools";

const noopLog = { warn: vi.fn(), error: vi.fn() };

function makeDeps(pool: unknown): McpPool {
  return { pool: pool as never, log: noopLog };
}

/**
 * A pool that answers the audit-log queries: a COUNT for the total and
 * a page of rows.
 */
function makeAuditPool(
  rows: unknown[],
  total = rows.length,
): { pool: unknown; calls: string[]; params: unknown[][] } {
  const calls: string[] = [];
  const params: unknown[][] = [];
  const pool = {
    query: vi.fn((sql: string, sqlParams?: unknown[]) => {
      calls.push(sql);
      params.push(sqlParams ?? []);
      if (sql.includes("COUNT(*)")) return Promise.resolve([[{ c: total }], []]);
      return Promise.resolve([rows, []]);
    }),
  };
  return { pool, calls, params };
}

/**
 * The page size the pool was actually asked for.
 *
 * The limit travels as a bound parameter, and the mock always returns
 * the same rows regardless — so asserting on the returned rows would
 * pass even with an unbounded limit. The parameter is the thing the
 * clamp has to change.
 */
function limitParam(recorder: { params: unknown[][] }): unknown {
  const rowQuery = recorder.params.find((p) => p.length >= 2);
  return rowQuery?.[rowQuery.length - 2];
}

/** A row as the storage layer returns it: snake_case columns. */
function auditRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 91,
    actor_user_id: 3,
    actor_email: "admin@example.com",
    action: "mcp_token.approve",
    target_type: "mcp_token",
    target_id: 12,
    metadata: { note: "internal tooling" },
    ip: "203.0.113.7",
    user_agent: "curl/8.4.0",
    status_code: 302,
    created_at: new Date("2026-11-21T11:00:00Z"),
    ...overrides,
  };
}

describe("The audit log tool", () => {
  it("lists the entries newest first", async () => {
    const { pool } = makeAuditPool([auditRow()]);
    const result = await mcpAuditLog(makeDeps(pool));
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]!.id).toBe(91);
  });

  it("reports who did it and what they did", async () => {
    const { pool } = makeAuditPool([auditRow()]);
    const result = await mcpAuditLog(makeDeps(pool));
    expect(result.rows[0]!.actorEmail).toBe("admin@example.com");
    expect(result.rows[0]!.action).toBe("mcp_token.approve");
    expect(result.rows[0]!.targetType).toBe("mcp_token");
    expect(result.rows[0]!.targetId).toBe(12);
  });

  it("reports the metadata of the action", async () => {
    const { pool } = makeAuditPool([auditRow()]);
    const result = await mcpAuditLog(makeDeps(pool));
    expect(result.rows[0]!.metadata).toEqual({ note: "internal tooling" });
  });

  it("serializes the timestamp as an ISO string", async () => {
    const { pool } = makeAuditPool([auditRow()]);
    const result = await mcpAuditLog(makeDeps(pool));
    expect(result.rows[0]!.createdAt).toBe("2026-11-21T11:00:00.000Z");
  });

  it("reports the total number of entries", async () => {
    const { pool } = makeAuditPool([auditRow()], 137);
    const result = await mcpAuditLog(makeDeps(pool));
    expect(result.total).toBe(137);
  });

  it("filters by action", async () => {
    const { pool, calls } = makeAuditPool([auditRow()]);
    await mcpAuditLog(makeDeps(pool), { action: "mcp_token.approve" });
    expect(calls[0]).toContain("action = ?");
  });

  it("returns nothing for a log that has no entries", async () => {
    const { pool } = makeAuditPool([]);
    const result = await mcpAuditLog(makeDeps(pool));
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("passes the requested page size to the query", async () => {
    const recorder = makeAuditPool([auditRow()]);
    await mcpAuditLog(makeDeps(recorder.pool), { limit: 5 });
    expect(limitParam(recorder)).toBe(5);
  });

  it("clamps an absurd limit instead of running the query", async () => {
    const recorder = makeAuditPool([auditRow()]);
    await mcpAuditLog(makeDeps(recorder.pool), { limit: 100000 });
    expect(limitParam(recorder)).toBe(100);
  });

  it("ignores a limit that is not a number", async () => {
    const recorder = makeAuditPool([auditRow()]);
    await mcpAuditLog(makeDeps(recorder.pool), { limit: "abc" });
    expect(limitParam(recorder)).toBe(20);
  });

  it("is registered under a name in the canonical tool list", () => {
    expect(TOOL_NAMES).toContain("ipquery_audit_log");
  });

  it("is reachable by an ops-scoped token", () => {
    // A tool in the definition list but not in the scope list is
    // unreachable: the server answers "unknown tool" to every caller.
    expect(OPS_SCOPE_TOOLS).toContain("ipquery_audit_log");
  });

  it("is out of reach of a lookup-scoped token", () => {
    // The audit log names operators and their email addresses. A
    // lookup token exists to answer geolocation questions; it has no
    // business reading who ran what.
    expect(LOOKUP_SCOPE_TOOLS).not.toContain("ipquery_audit_log");
  });

  it("is actually registered with a handler", () => {
    const registrations = buildToolRegistrations(makeDeps({ query: vi.fn() }));
    const names = registrations.map((r) => r.def.name);
    expect(names).toContain("ipquery_audit_log");
    // Every registered tool must be in the canonical list, or the
    // server advertises a tool the docs and the scope list disagree on.
    for (const name of names) {
      expect(TOOL_NAMES as readonly string[]).toContain(name);
    }
  });

  it("declares the filter and limit it accepts", () => {
    const def = auditLogToolDef();
    expect(def.name).toBe("ipquery_audit_log");
    const properties = (def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties).toHaveProperty("limit");
    expect(properties).toHaveProperty("action");
  });
});
