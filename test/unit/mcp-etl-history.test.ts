// SPDX-License-Identifier: MIT
//
// The MCP server must be able to answer "what happened on the last few
// ETL runs?".
//
// `ipquery_etl_status` reports the newest run only, and
// `ipquery_etl_sources` reports one run's per-file contribution. Neither
// can show the history: an operator asking "did last night's run fail,
// and how many runs has this instance had since?" gets nothing. The
// `etl_runs` table already holds the answer — `recentEtlRuns` reads it
// for the marketing page — but no MCP tool exposed it.
//
// This test pins the new tool's shape and its three registration points.
// Missing any one of them is a silent hole rather than an error: a tool
// in the definition list but not in the scope list is unreachable, and a
// tool in the scope list but not registered is a promise the server does
// not keep.
import { describe, it, expect, vi } from "vitest";
import { TOOL_NAMES } from "../../src/mcp/tool-names";
import { OPS_SCOPE_TOOLS } from "../../src/mcp/auth";
import { buildToolRegistrations } from "../../src/mcp/server-tools";
import { mcpEtlHistory, etlHistoryToolDef } from "../../src/mcp/ops-tools";
import type { McpPool } from "../../src/mcp/tools";

const noopLog = { warn: vi.fn(), error: vi.fn() };

function makeDeps(pool: unknown): McpPool {
  return { pool: pool as never, log: noopLog };
}

/** A pool that answers the etl_runs history query. */
function makeHistoryPool(rows: unknown[]): { pool: unknown; calls: string[]; params: unknown[][] } {
  const calls: string[] = [];
  const params: unknown[][] = [];
  const pool = {
    query: vi.fn((sql: string, sqlParams?: unknown[]) => {
      calls.push(sql);
      params.push(sqlParams ?? []);
      if (sql.includes("FROM etl_runs")) return Promise.resolve([rows, []]);
      return Promise.resolve([[], []]);
    }),
  };
  return { pool, calls, params };
}

/** The bound parameters of the first query the pool received. */
function paramsOf(calls: { calls: string[]; params: unknown[][] }): unknown[] {
  return calls.params[0] ?? [];
}

/** A row as the storage layer returns it: snake_case columns, Date values. */
function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12,
    started_at: new Date("2026-11-20T22:00:00Z"),
    finished_at: new Date("2026-11-20T22:12:00Z"),
    status: "success",
    merged_records: 8152112,
    dbip_records: 8152112,
    error_message: null,
    ...overrides,
  };
}

describe("The ETL run history tool", () => {
  it("lists the runs newest first", async () => {
    const { pool } = makeHistoryPool([runRow({ id: 12 }), runRow({ id: 11 })]);
    const result = await mcpEtlHistory(makeDeps(pool));
    expect(result.runs.length).toBe(2);
    expect(result.runs.map((r) => r.id)).toEqual([12, 11]);
  });

  it("reports the status and the record count of each run", async () => {
    const { pool } = makeHistoryPool([runRow({ id: 12 })]);
    const result = await mcpEtlHistory(makeDeps(pool));
    expect(result.runs[0]!.status).toBe("success");
    expect(result.runs[0]!.mergedRecords).toBe(8152112);
  });

  it("serializes the timestamps as ISO strings", async () => {
    const { pool } = makeHistoryPool([runRow({ id: 12 })]);
    const result = await mcpEtlHistory(makeDeps(pool));
    expect(result.runs[0]!.startedAt).toBe("2026-11-20T22:00:00.000Z");
    expect(result.runs[0]!.finishedAt).toBe("2026-11-20T22:12:00.000Z");
  });

  it("carries the failure reason of a failed run", async () => {
    // A failed run without its error message is not diagnosable: the
    // operator is left with the knowledge that something broke and no
    // way to find out what.
    const { pool } = makeHistoryPool([
      runRow({ id: 13, status: "failed", error_message: "source file vanished" }),
    ]);
    const result = await mcpEtlHistory(makeDeps(pool));
    expect(result.runs[0]!.status).toBe("failed");
    expect(result.runs[0]!.errorMessage).toBe("source file vanished");
  });

  it("reports a run that has not finished yet as still running", async () => {
    // A run in flight has no finished_at; the tool must say so rather
    // than leaving the field undefined.
    const { pool } = makeHistoryPool([
      runRow({ id: 14, status: "running", finished_at: null }),
    ]);
    const result = await mcpEtlHistory(makeDeps(pool));
    expect(result.runs[0]!.status).toBe("running");
    expect(result.runs[0]!.finishedAt).toBeNull();
  });

  it("returns an empty list when the server has never run an ETL", async () => {
    const { pool } = makeHistoryPool([]);
    const result = await mcpEtlHistory(makeDeps(pool));
    expect(result.runs).toEqual([]);
  });

  it("caps the number of runs it returns", async () => {
    // An unbounded history would hand the client the whole table. The
    // limit travels as a query parameter, not spliced into the SQL.
    const recorder = makeHistoryPool([runRow()]);
    await mcpEtlHistory(makeDeps(recorder.pool), 5);
    expect(recorder.calls[0]).toContain("LIMIT ?");
    expect(paramsOf(recorder)).toEqual([5]);
  });

  it("clamps an absurd limit instead of running the query", async () => {
    const recorder = makeHistoryPool([runRow()]);
    await mcpEtlHistory(makeDeps(recorder.pool), 100000);
    expect(paramsOf(recorder)).toEqual([100]);
  });

  it("ignores a limit that is not a number", async () => {
    const recorder = makeHistoryPool([runRow()]);
    await mcpEtlHistory(makeDeps(recorder.pool), "abc");
    expect(paramsOf(recorder)).toEqual([20]);
  });

  it("is registered under a name in the canonical tool list", () => {
    expect(TOOL_NAMES).toContain("ipquery_etl_history");
  });

  it("is reachable by an ops-scoped token", () => {
    // A tool in the definition list but not in the scope list is
    // unreachable: the server answers "unknown tool" to every caller.
    expect(OPS_SCOPE_TOOLS).toContain("ipquery_etl_history");
  });

  it("is actually registered with a handler", () => {
    const registrations = buildToolRegistrations(makeDeps({ query: vi.fn() }));
    const names = registrations.map((r) => r.def.name);
    expect(names).toContain("ipquery_etl_history");
    // Every registered tool must be in the canonical list, or the
    // server advertises a tool the docs and the scope list disagree on.
    for (const name of names) {
      expect(TOOL_NAMES as readonly string[]).toContain(name);
    }
  });

  it("declares the limit it accepts", () => {
    const def = etlHistoryToolDef();
    expect(def.name).toBe("ipquery_etl_history");
    const properties = (def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties).toHaveProperty("limit");
  });
});
