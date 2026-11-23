// SPDX-License-Identifier: MIT
//
// The MCP server must be able to answer several IPs at once.
//
// `ipquery_lookup` takes one address. An operator checking whether a
// customer's traffic comes from the expected countries, or a client
// reconciling a list of suspicious addresses, has to call it once per
// address. That is fine over HTTP with a batch of three and miserable
// over MCP, where each call is a round trip through the client.
//
// The batch tool must not lose the per-address errors: a batch of ten
// where two addresses are malformed still answers the other eight. A
// batch that fails wholesale on the first bad address is worse than no
// batch tool at all.
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
import { mcpLookupBatch, lookupBatchToolDef, type McpPool } from "../../src/mcp/tools";

const noopLog = { warn: vi.fn(), error: vi.fn() };

function makeDeps(pool: unknown): McpPool {
  return { pool: pool as never, log: noopLog };
}

/**
 * A pool that answers the range lookup for a known address and finds
 * nothing for an unknown one.
 *
 * "Known" means the address starts with 8.8.8. — the mock returns a
 * range row for it and nothing for anything else.
 */
function makeLookupPool(): { pool: unknown; calls: string[] } {
  const calls: string[] = [];
  const pool = {
    query: vi.fn((sql: string, sqlParams?: unknown[]) => {
      calls.push(sql);
      // The "last successful ETL run" query.
      if (sql.includes("FROM etl_runs")) {
        return Promise.resolve([[{ finished_at: new Date("2026-11-21T00:00:00Z") }], []]);
      }
      // The range lookup. The bound parameter is the address buffer.
      if (sql.includes("ip_ranges")) {
        // The IPv4 buffer is 16 bytes, left-aligned at offset 12.
        const target = sqlParams?.[0];
        const isKnown = Buffer.isBuffer(target) && target[12] === 8 && target[13] === 8;
        if (!isKnown) return Promise.resolve([[], []]);
        return Promise.resolve([
          [
            {
              // The stored buffers are 16 bytes, left-aligned at 12 —
              // the same shape the parser produces.
              start_ip: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 8, 8, 8]),
              end_ip: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 8, 8, 8]),
              range_size: "0",
              country_code: "US",
              country_name: "United States",
              region: "California",
              city: "Mountain View",
              isp: "Google LLC",
              asn: 15169,
              asn_org: "GOOGLE",
              timezone: "America/Los_Angeles",
              country_source: "dbip",
              city_source: "dbip",
              isp_source: "dbip",
              asn_source: "dbip-asn",
              geo_source: "dbip",
            },
          ],
          [],
        ]);
      }
      return Promise.resolve([[], []]);
    }),
  };
  return { pool, calls };
}

describe("The batch lookup tool", () => {
  it("answers one entry per requested address", async () => {
    const { pool } = makeLookupPool();
    const result = await mcpLookupBatch(makeDeps(pool), { ips: ["8.8.8.8", "1.1.1.1"] });
    expect(result.results.length).toBe(2);
    expect(result.results.map((r) => r.ip)).toEqual(["8.8.8.8", "1.1.1.1"]);
  });

  it("keeps the order the caller asked for", async () => {
    const { pool } = makeLookupPool();
    const result = await mcpLookupBatch(makeDeps(pool), { ips: ["1.1.1.1", "8.8.8.8"] });
    expect(result.results.map((r) => r.ip)).toEqual(["1.1.1.1", "8.8.8.8"]);
  });

  it("marks an address that was not found instead of failing the batch", async () => {
    // The whole point of a batch is that one unknown address does not
    // cost the caller the other answers.
    const { pool } = makeLookupPool();
    const result = await mcpLookupBatch(makeDeps(pool), { ips: ["9.9.9.9", "8.8.8.8"] });
    expect(result.results[0]!.found).toBe(false);
    expect(result.results[0]!.error).toBe("not_found");
    // The known address still got its answer.
    expect(result.results[1]!.found).toBe(true);
  });

  it("marks a malformed address as invalid instead of failing the batch", async () => {
    const { pool } = makeLookupPool();
    const result = await mcpLookupBatch(makeDeps(pool), { ips: ["not-an-ip", "8.8.8.8"] });
    expect(result.results[0]!.found).toBe(false);
    expect(result.results[0]!.error).toBe("invalid_ip");
    // The good address still got an answer.
    expect(result.results.length).toBe(2);
  });

  it("reports the found addresses with their country", async () => {
    const { pool } = makeLookupPool();
    const result = await mcpLookupBatch(makeDeps(pool), { ips: ["8.8.8.8"] });
    expect(result.results[0]!.found).toBe(true);
    expect(result.results[0]!.result?.country.code).toBe("US");
    expect(result.results[0]!.result?.city?.name).toBe("Mountain View");
  });

  it("counts the addresses it found and the ones it did not", async () => {
    const { pool } = makeLookupPool();
    const result = await mcpLookupBatch(makeDeps(pool), { ips: ["8.8.8.8", "bad"] });
    expect(result.total).toBe(2);
    expect(result.found).toBe(1);
    expect(result.notFound).toBe(1);
  });

  it("returns an empty result for an empty list", async () => {
    const { pool } = makeLookupPool();
    const result = await mcpLookupBatch(makeDeps(pool), { ips: [] });
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("rejects a request whose addresses are not a list", async () => {
    const { pool } = makeLookupPool();
    await expect(mcpLookupBatch(makeDeps(pool), { ips: "8.8.8.8" })).rejects.toThrow(
      /ips must be an array/i,
    );
  });

  it("rejects a request with no addresses", async () => {
    const { pool } = makeLookupPool();
    await expect(mcpLookupBatch(makeDeps(pool), {})).rejects.toThrow(/ips must be an array/i);
  });

  it("caps the size of a batch", async () => {
    // An unbounded batch would let one call pull the whole table.
    const { pool } = makeLookupPool();
    const ips = Array.from({ length: 500 }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`);
    const result = await mcpLookupBatch(makeDeps(pool), { ips });
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it("is registered under a name in the canonical tool list", () => {
    expect(TOOL_NAMES).toContain("ipquery_lookup_batch");
  });

  it("is reachable by a lookup-scoped token", async () => {
    // Batch lookup is the same operation as lookup, so a lookup-scoped
    // token must be able to use it — it exposes no operational data.
    expect(LOOKUP_SCOPE_TOOLS).toContain("ipquery_lookup_batch");
  });

  it("is reachable by an ops-scoped token", () => {
    expect(OPS_SCOPE_TOOLS).toContain("ipquery_lookup_batch");
  });

  it("is actually registered with a handler", () => {
    const registrations = buildToolRegistrations(makeDeps({ query: vi.fn() }));
    const names = registrations.map((r) => r.def.name);
    expect(names).toContain("ipquery_lookup_batch");
    // Every registered tool must be in the canonical list, or the
    // server advertises a tool the docs and the scope list disagree on.
    for (const name of names) {
      expect(TOOL_NAMES as readonly string[]).toContain(name);
    }
  });

  it("declares the addresses it accepts", () => {
    const def = lookupBatchToolDef();
    expect(def.name).toBe("ipquery_lookup_batch");
    const properties = (def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties).toHaveProperty("ips");
  });
});
