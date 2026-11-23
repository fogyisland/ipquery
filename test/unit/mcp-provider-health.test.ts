// SPDX-License-Identifier: MIT
//
// The MCP server must be able to answer "are the lookup providers
// healthy?".
//
// The backfill fan-out talks to five external geolocation providers.
// When one of them starts failing, the admin console's Providers tab
// shows it — but an AI client driving the server had no way to ask. A
// client that watches the library fill itself has no way to notice that
// every backfill has been quietly abstaining because one provider is
// rate-limiting.
//
// The data is already computed and cached for the admin page
// (`aggregateProviderHealthAll` + `getCircuitBreakerConfig`). This
// tool exposes both: the health window per provider, and the breaker
// settings that decide what happens when the failure rate crosses the
// threshold.
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
import { mcpProviderHealth, providerHealthToolDef } from "../../src/mcp/ops-tools";
import type { McpPool } from "../../src/mcp/tools";

const noopLog = { warn: vi.fn(), error: vi.fn() };

function makeDeps(pool: unknown): McpPool {
  return { pool: pool as never, log: noopLog };
}

/**
 * A pool that answers the two queries the tool reads: the per-provider
 * counter aggregate and the circuit-breaker settings.
 *
 * The counter query is matched on the table name in the SQL text and the
 * provider name arrives as a bound parameter, so the mock does not
 * depend on the exact column list.
 */
function makeHealthPool(): { pool: unknown; calls: string[] } {
  const calls: string[] = [];
  const pool = {
    query: vi.fn((sql: string, sqlParams?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("provider_call_counter")) {
        // ip-api: mostly healthy. ip-sb: rate-limited.
        const name = typeof sqlParams?.[0] === "string" ? sqlParams[0] : "";
        if (name === "ip-api") {
          return Promise.resolve([
            [
              {
                calls: 100,
                errors429: 0,
                errorsOther: 2,
                lastCallAt: new Date("2026-11-21T10:00:00Z"),
              },
            ],
            [],
          ]);
        }
        return Promise.resolve([
          [
            {
              calls: 20,
              errors429: 15,
              errorsOther: 0,
              lastCallAt: new Date("2026-11-21T09:30:00Z"),
            },
          ],
          [],
        ]);
      }
      if (sql.includes("FROM settings")) {
        return Promise.resolve([[{ k: "cb_enabled", v: "1" }], []]);
      }
      return Promise.resolve([[], []]);
    }),
  };
  return { pool, calls };
}

describe("The provider health tool", () => {
  it("reports the call and error counts of each provider", async () => {
    const { pool } = makeHealthPool();
    const result = await mcpProviderHealth(makeDeps(pool));
    const ipApi = result.providers.find((p) => p.providerName === "ip-api");
    expect(ipApi).toBeDefined();
    expect(ipApi!.calls).toBe(100);
    expect(ipApi!.errors429).toBe(0);
    expect(ipApi!.errorsOther).toBe(2);
  });

  it("reports the failure rate of each provider", async () => {
    const { pool } = makeHealthPool();
    const result = await mcpProviderHealth(makeDeps(pool));
    const ipApi = result.providers.find((p) => p.providerName === "ip-api");
    expect(ipApi!.failureRatePct).toBe(2);
  });

  it("separates rate-limit failures from other failures", async () => {
    // A provider that returns 429 is a different problem from one that
    // returns 401 — the breaker treats them differently and so does the
    // operator reading the numbers.
    const { pool } = makeHealthPool();
    const result = await mcpProviderHealth(makeDeps(pool));
    const ipSb = result.providers.find((p) => p.providerName === "ip-sb");
    expect(ipSb).toBeDefined();
    expect(ipSb!.errors429).toBe(15);
    expect(ipSb!.errorsOther).toBe(0);
    expect(ipSb!.rateLimitedRatePct).toBe(75);
  });

  it("serializes the last call time as an ISO string", async () => {
    const { pool } = makeHealthPool();
    const result = await mcpProviderHealth(makeDeps(pool));
    const ipApi = result.providers.find((p) => p.providerName === "ip-api");
    expect(ipApi!.lastCallAt).toBe("2026-11-21T10:00:00.000Z");
  });

  it("reports the circuit-breaker settings", async () => {
    // The health numbers mean nothing without the threshold they are
    // measured against: 50% failures with a 100% threshold is healthy.
    const { pool } = makeHealthPool();
    const result = await mcpProviderHealth(makeDeps(pool));
    expect(result.circuitBreaker).not.toBeNull();
    expect(result.circuitBreaker!.enabled).toBe(true);
  });

  it("names the window the numbers cover", async () => {
    const { pool } = makeHealthPool();
    const result = await mcpProviderHealth(makeDeps(pool));
    expect(result.windowMinutes).toBeGreaterThan(0);
    expect(result.providers[0]!.windowMs).toBe(result.windowMinutes * 60_000);
  });

  it("honours a requested window", async () => {
    const { pool } = makeHealthPool();
    const result = await mcpProviderHealth(makeDeps(pool), { windowMinutes: 1440 });
    expect(result.windowMinutes).toBe(1440);
  });

  it("clamps an absurd window instead of running the query", async () => {
    const { pool } = makeHealthPool();
    const result = await mcpProviderHealth(makeDeps(pool), { windowMinutes: 999999 });
    expect(result.windowMinutes).toBeLessThanOrEqual(7 * 24 * 60);
  });

  it("ignores a window that is not a number", async () => {
    const { pool } = makeHealthPool();
    const result = await mcpProviderHealth(makeDeps(pool), { windowMinutes: "abc" });
    expect(result.windowMinutes).toBe(60);
  });

  it("is registered under a name in the canonical tool list", () => {
    expect(TOOL_NAMES).toContain("ipquery_provider_health");
  });

  it("is reachable by an ops-scoped token", () => {
    // A tool in the definition list but not in the scope list is
    // unreachable: the server answers "unknown tool" to every caller.
    expect(OPS_SCOPE_TOOLS).toContain("ipquery_provider_health");
  });

  it("is actually registered with a handler", () => {
    const registrations = buildToolRegistrations(makeDeps({ query: vi.fn() }));
    const names = registrations.map((r) => r.def.name);
    expect(names).toContain("ipquery_provider_health");
    // Every registered tool must be in the canonical list, or the
    // server advertises a tool the docs and the scope list disagree on.
    for (const name of names) {
      expect(TOOL_NAMES as readonly string[]).toContain(name);
    }
  });

  it("declares the window it accepts", () => {
    const def = providerHealthToolDef();
    expect(def.name).toBe("ipquery_provider_health");
    const properties = (def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties).toHaveProperty("windowMinutes");
  });
});
