// SPDX-License-Identifier: MIT
//
// The MCP server must be able to answer "what did each source
// actually contribute to the last run?".
//
// The `ipquery_etl_status` tool reports a `sources` map, and that map
// is nearly empty: `etl_runs` carries one lumped counter for the whole
// DB-IP family, so the other six files show `records: null`. The real
// per-source numbers — rows emitted per file, rows inserted per file,
// rows skipped per file — are in the stage tables (`etl_run_parses`,
// `etl_run_inserts`, `etl_run_downloads`), and no MCP tool could reach
// them. An operator asking an AI client "which source gave me the
// Chinese ranges?" had no way to find out.
//
// This test pins the new tool's shape and its three registration
// points. Missing any one of them is a silent hole rather than an
// error: a tool in the definition list but not in the scope list is
// unreachable, and a tool in the scope list but not registered is a
// promise the server does not keep.
import { describe, it, expect, vi } from "vitest";
import { TOOL_NAMES } from "../../src/mcp/tool-names";
import { OPS_SCOPE_TOOLS } from "../../src/mcp/auth";
import { buildToolRegistrations } from "../../src/mcp/server-tools";
import {
  mcpEtlSources,
  etlSourcesToolDef,
  type McpPool,
} from "../../src/mcp/tools";

const noopLog = { warn: vi.fn(), error: vi.fn() };

function makeDeps(pool: unknown): McpPool {
  return { pool: pool as never, log: noopLog };
}

/**
 * A pool that answers the three stage-table queries the tool reads.
 * The queries are matched on the table name in the SQL text, so the
 * mock does not depend on the exact column list.
 */
function makeStagePool(): { pool: unknown; calls: string[] } {
  const calls: string[] = [];
  const pool = {
    query: vi.fn((sql: string) => {
      calls.push(sql);
      if (sql.includes("etl_run_parses")) {
        return Promise.resolve([
          [
            {
              run_id: 7,
              source: "metowolf-cn",
              dest_name: "china-ipv4.txt",
              rows_emitted: 5000,
              rows_skipped_short: 1,
              rows_skipped_header: 2,
              rows_skipped_unparseable_ip: 3,
              rows_skipped_missing_col: 4,
              rows_skipped_nan_asn: 0,
              rows_skipped_other: 5,
              gunzip_errors: 0,
              started_at: new Date("2026-11-01T00:00:00Z"),
              finished_at: new Date("2026-11-01T00:00:05Z"),
              duration_ms: 5000,
            },
          ],
          [],
        ]);
      }
      if (sql.includes("etl_run_inserts")) {
        return Promise.resolve([
          [
            {
              run_id: 7,
              source: "metowolf-cn",
              dest_name: "china-ipv4.txt",
              rows_attempted: 5000,
              rows_inserted: 4900,
              rows_duplicates: 100,
              batch_count: 5,
              duration_ms: 3000,
              started_at: new Date("2026-11-01T00:00:05Z"),
              finished_at: new Date("2026-11-01T00:00:08Z"),
            },
          ],
          [],
        ]);
      }
      if (sql.includes("etl_run_downloads")) {
        return Promise.resolve([
          [
            {
              run_id: 7,
              source: "metowolf-cn",
              dest_name: "china-ipv4.txt",
              source_url: "https://example.invalid/list.txt",
              month: null,
              status: "success",
              bytes: 1024,
              duration_ms: 200,
              retry_count: 0,
              error_message: null,
              started_at: new Date("2026-11-01T00:00:00Z"),
              finished_at: new Date("2026-11-01T00:00:01Z"),
            },
          ],
          [],
        ]);
      }
      if (sql.includes("FROM etl_runs")) {
        return Promise.resolve([[{ id: 7 }], []]);
      }
      return Promise.resolve([[], []]);
    }),
  };
  return { pool, calls };
}

describe("The per-source ETL tool", () => {
  it("reports the rows each source emitted, inserted and skipped", async () => {
    const { pool } = makeStagePool();
    const result = await mcpEtlSources(makeDeps(pool));
    expect(result.sources.length).toBe(1);
    const source = result.sources[0]!;
    expect(source.source).toBe("metowolf-cn");
    expect(source.label).toBe("metowolf/iplist (CN)");
    expect(source.rowsEmitted).toBe(5000);
    expect(source.rowsInserted).toBe(4900);
    expect(source.rowsDuplicates).toBe(100);
    expect(source.rowsSkipped).toBe(15);
  });

  it("reports the download outcome for each source", async () => {
    const { pool } = makeStagePool();
    const result = await mcpEtlSources(makeDeps(pool));
    expect(result.sources[0]!.downloadStatus).toBe("success");
    expect(result.sources[0]!.bytes).toBe(1024);
  });

  it("names the run it read", async () => {
    const { pool } = makeStagePool();
    const result = await mcpEtlSources(makeDeps(pool));
    expect(result.runId).toBe(7);
  });

  it("returns an empty list when the run has no stage rows", async () => {
    const pool = {
      query: vi.fn((sql: string) => {
        if (sql.includes("FROM etl_runs")) return Promise.resolve([[{ id: 9 }], []]);
        return Promise.resolve([[], []]);
      }),
    };
    const result = await mcpEtlSources(makeDeps(pool));
    expect(result.sources).toEqual([]);
    expect(result.runId).toBe(9);
  });

  it("returns an empty list when the server has never run an ETL", async () => {
    const pool = { query: vi.fn().mockResolvedValue([[], []]) };
    const result = await mcpEtlSources(makeDeps(pool));
    expect(result.sources).toEqual([]);
    expect(result.runId).toBeNull();
  });

  it("reports a source the stage tables have no row for as absent, not zero", async () => {
    // A source with no stage row did not contribute zero rows — it
    // has no row at all. Reporting zero would be a different claim.
    const { pool } = makeStagePool();
    const result = await mcpEtlSources(makeDeps(pool));
    expect(result.sources.map((s) => s.source)).toEqual(["metowolf-cn"]);
  });

  it("is registered under a name in the canonical tool list", () => {
    expect(TOOL_NAMES).toContain("ipquery_etl_sources");
  });

  it("is reachable by an ops-scoped token", () => {
    // A tool in the definition list but not in the scope list is
    // unreachable: the server answers "unknown tool" to every caller.
    expect(OPS_SCOPE_TOOLS).toContain("ipquery_etl_sources");
  });

  it("is actually registered with a handler", () => {
    const registrations = buildToolRegistrations(makeDeps({ query: vi.fn() }));
    const names = registrations.map((r) => r.def.name);
    expect(names).toContain("ipquery_etl_sources");
    // Every registered tool must be in the canonical list, or the
    // server advertises a tool the docs and the scope list disagree on.
    for (const name of names) {
      expect(TOOL_NAMES as readonly string[]).toContain(name);
    }
  });

  it("declares the run id it accepts", () => {
    const def = etlSourcesToolDef();
    expect(def.name).toBe("ipquery_etl_sources");
    const properties = (def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties).toHaveProperty("runId");
  });
});
