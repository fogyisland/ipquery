// SPDX-License-Identifier: MIT
//
// The MCP server must be able to answer "is an import or export running,
// and did the last one succeed?".
//
// A library-sized import takes hours and a library-sized export writes
// around two gigabytes, so both run detached: the request starts the
// job and returns, and the work continues afterwards. The admin console
// shows both at `/admin/ranges`, but an AI client driving the server
// could not ask — and a client that wants to know whether the ranges
// table is mid-swap has no way to find out.
//
// Both jobs write their state to a table, so the state survives a
// restart: `range_imports` and `range_exports`.
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
import { mcpRangeJobs, rangeJobsToolDef } from "../../src/mcp/ops-tools";
import type { McpPool } from "../../src/mcp/tools";

const noopLog = { warn: vi.fn(), error: vi.fn() };

function makeDeps(pool: unknown): McpPool {
  return { pool: pool as never, log: noopLog };
}

/**
 * A pool that answers the two job-table queries.
 *
 * Both list functions run the migrations first, so the mock has to
 * tolerate the bookkeeping queries those make.
 */
function makeJobPool(): { pool: unknown; calls: string[]; params: unknown[][] } {
  const calls: string[] = [];
  const params: unknown[][] = [];
  // Both list functions run the migrations first, which takes a
  // dedicated connection and runs its statements on it.
  const conn = {
    query: vi.fn().mockResolvedValue([[], []]),
    beginTransaction: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    release: vi.fn(),
  };
  const pool = {
    getConnection: vi.fn().mockResolvedValue(conn),
    query: vi.fn((sql: string, sqlParams?: unknown[]) => {
      calls.push(sql);
      params.push(sqlParams ?? []);
      if (sql.includes("FROM range_imports")) {
        return Promise.resolve([
          [
            {
              id: 5,
              mode: "replace",
              source: "ranges.ipq",
              status: "running",
              rows_done: 120000,
              declared_rows: 9000000,
              rows_written: 110000,
              preserved: 3,
              error_message: null,
              started_at: new Date("2026-11-21T09:00:00Z"),
              finished_at: null,
            },
          ],
          [],
        ]);
      }
      if (sql.includes("FROM range_exports")) {
        return Promise.resolve([
          [
            {
              id: "exp-1",
              filename: "ipquery-ranges-2026-11-21.ipq",
              country_code: "CN",
              status: "success",
              rows: 9000000,
              bytes: 2147483648,
              error_message: null,
              started_at: new Date("2026-11-20T09:00:00Z"),
              finished_at: new Date("2026-11-20T10:00:00Z"),
            },
          ],
          [],
        ]);
      }
      // The migration bookkeeping queries.
      return Promise.resolve([[], []]);
    }),
  };
  return { pool, calls, params };
}

/**
 * The page size the pool was actually asked for.
 *
 * The limit travels as a bound parameter and the mock always returns
 * the same rows regardless — so asserting on the returned rows would
 * pass even with an unbounded limit. The parameter is the thing the
 * clamp has to change.
 */
function limitParam(recorder: { params: unknown[][] }): unknown {
  const withLimit = recorder.params.filter((p) => p.length >= 1);
  return withLimit[0]?.[0];
}

describe("The range job tool", () => {
  it("reports the running imports", async () => {
    const { pool } = makeJobPool();
    const result = await mcpRangeJobs(makeDeps(pool));
    expect(result.imports.length).toBe(1);
    expect(result.imports[0]!.id).toBe(5);
    expect(result.imports[0]!.mode).toBe("replace");
    expect(result.imports[0]!.status).toBe("running");
  });

  it("reports the progress of an import", async () => {
    // An import that takes hours needs a progress number, otherwise
    // "running" says nothing about whether it is stuck.
    const { pool } = makeJobPool();
    const result = await mcpRangeJobs(makeDeps(pool));
    expect(result.imports[0]!.rowsDone).toBe(120000);
    expect(result.imports[0]!.declaredRows).toBe(9000000);
    expect(result.imports[0]!.rowsWritten).toBe(110000);
  });

  it("reports the exports and their size", async () => {
    const { pool } = makeJobPool();
    const result = await mcpRangeJobs(makeDeps(pool));
    expect(result.exports.length).toBe(1);
    expect(result.exports[0]!.id).toBe("exp-1");
    expect(result.exports[0]!.filename).toBe("ipquery-ranges-2026-11-21.ipq");
    expect(result.exports[0]!.rows).toBe(9000000);
    expect(result.exports[0]!.bytes).toBe(2147483648);
  });

  it("reports the country an export was restricted to", async () => {
    const { pool } = makeJobPool();
    const result = await mcpRangeJobs(makeDeps(pool));
    expect(result.exports[0]!.countryCode).toBe("CN");
  });

  it("serializes the timestamps as ISO strings", async () => {
    const { pool } = makeJobPool();
    const result = await mcpRangeJobs(makeDeps(pool));
    expect(result.exports[0]!.startedAt).toBe("2026-11-20T09:00:00.000Z");
    expect(result.exports[0]!.finishedAt).toBe("2026-11-20T10:00:00.000Z");
    // A running import has no finish time yet.
    expect(result.imports[0]!.finishedAt).toBeNull();
  });

  it("reports a job that has not started as no rows", async () => {
    const conn = {
      query: vi.fn().mockResolvedValue([[], []]),
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    const pool = {
      getConnection: vi.fn().mockResolvedValue(conn),
      query: vi.fn().mockResolvedValue([[], []]),
    };
    const result = await mcpRangeJobs(makeDeps(pool));
    expect(result.imports).toEqual([]);
    expect(result.exports).toEqual([]);
  });

  it("passes the requested page size to the query", async () => {
    const recorder = makeJobPool();
    await mcpRangeJobs(makeDeps(recorder.pool), { limit: 5 });
    expect(limitParam(recorder)).toBe(5);
  });

  it("clamps an absurd limit instead of running the query", async () => {
    const recorder = makeJobPool();
    await mcpRangeJobs(makeDeps(recorder.pool), { limit: 100000 });
    expect(limitParam(recorder)).toBe(50);
  });

  it("ignores a limit that is not a number", async () => {
    const recorder = makeJobPool();
    await mcpRangeJobs(makeDeps(recorder.pool), { limit: "abc" });
    expect(limitParam(recorder)).toBe(10);
  });

  it("is registered under a name in the canonical tool list", () => {
    expect(TOOL_NAMES).toContain("ipquery_range_jobs");
  });

  it("is reachable by an ops-scoped token", () => {
    // A tool in the definition list but not in the scope list is
    // unreachable: the server answers "unknown tool" to every caller.
    expect(OPS_SCOPE_TOOLS).toContain("ipquery_range_jobs");
  });

  it("is out of reach of a lookup-scoped token", () => {
    expect(LOOKUP_SCOPE_TOOLS).not.toContain("ipquery_range_jobs");
  });

  it("is actually registered with a handler", () => {
    const registrations = buildToolRegistrations(makeDeps({ query: vi.fn() }));
    const names = registrations.map((r) => r.def.name);
    expect(names).toContain("ipquery_range_jobs");
    // Every registered tool must be in the canonical list, or the
    // server advertises a tool the docs and the scope list disagree on.
    for (const name of names) {
      expect(TOOL_NAMES as readonly string[]).toContain(name);
    }
  });

  it("declares the limit it accepts", () => {
    const def = rangeJobsToolDef();
    expect(def.name).toBe("ipquery_range_jobs");
    const properties = (def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties).toHaveProperty("limit");
  });
});
